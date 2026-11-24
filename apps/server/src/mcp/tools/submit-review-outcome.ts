import { z } from 'zod';
import type { PrDetails, PullRequestRef, TenantCtx } from '@sdlc/adapters-contracts';
import type { PrProviderKind } from '@sdlc/adapters-contracts';
import type { Flow, Story } from '@sdlc/core';
import type { FlowStore } from '../../state/index.js';
import { resolveStoryForCtx } from './flow-access.js';
import type { PullRequestProvider } from '../../adapters/pull-request-provider.js';
import { isNoOpPullRequestAdapter } from '../../adapters/pull-request-provider.js';
import { resolveStoryComponent } from './story-component.js';
import { assertRole } from './role-guard.js';
import { ReviewEnvelopeInput, REVIEW_ENVELOPE_SCHEMA } from '@sdlc/core';
import type { TaskSystemProvider } from '../../adapters/task-system-provider.js';
import { selfSignoffPolicy, type SelfSignoffDeps } from './self-signoff.js';
import {
  selfSignoffAnnotation,
  type SelfSignoffCaseResult,
} from '../../signoff/self-signoff-comment.js';
import {
  REVIEW_ENVELOPE_TEMPLATE,
  validateReviewEnvelope,
  verdictContradice,
} from '../../validation/review-envelope.js';
import { closeFlowIfSettled } from './flow-closure.js';
import { assertFlowNotAborted, updateFlowUnlessAborted } from './abort-flow.js';
import { declaredRepoIdentity, prRepoIdentity, DECLARA_EL_REPO } from '../../repos/identity.js';

export const SubmitReviewOutcomeInput = z.object({
  story_id: z.string().min(1),
  outcome: z.enum(['approved', 'changes_requested']),
  comment: z.string().optional(),
  /**
   * Los dos ejes del review. Laxo acá y validado en el handler: ver
   * `validation/review-envelope.ts` (mismo razonamiento que el envelope de QA).
   */
  review: ReviewEnvelopeInput,
});
export type SubmitReviewOutcomeInput = z.infer<typeof SubmitReviewOutcomeInput>;

/** Estado del PR normalizado a través de plataformas. */
export type NormalizedPrState = 'open' | 'closed' | 'unknown';

/**
 * Normaliza el `status` crudo del PR a un estado común.
 *
 * Cada plataforma usa su propio vocabulario —ADO `active | completed |
 * abandoned`, GitHub `open | closed`— y ninguna garantiza la caja, así que
 * comparamos en minúsculas y sin espacios.
 *
 * Un valor desconocido devuelve `unknown` y **no** cuenta como abierto: si el
 * proveedor cambia el vocabulario preferimos frenar el gate y que alguien lo
 * mire, antes que aprobar un PR cuyo estado no sabemos leer.
 *
 * Tolera `undefined` / `null` a propósito: `PrDetails.status` viene de la
 * respuesta del proveedor y nada garantiza que el campo exista (un provider que
 * devuelve el PR sin `state` hacía explotar `.trim()` *fuera* de los try/catch
 * del handler, o sea que el agente recibía un TypeError en vez del
 * `{ok:false, error}` del contrato). Un estado ausente es exactamente el caso
 * "no sé leer el estado" → `unknown`, que ya bloquea.
 */
export function normalizePrState(raw: string | null | undefined): NormalizedPrState {
  if (typeof raw !== 'string') return 'unknown';
  switch (raw.trim().toLowerCase()) {
    case 'active': // ADO
    case 'open': // GitHub
      return 'open';
    case 'completed': // ADO: mergeado
    case 'abandoned': // ADO: descartado
    case 'closed': // GitHub: cerrado o mergeado
    case 'merged':
      return 'closed';
    default:
      return 'unknown';
  }
}

// ---------------------------------------------------------------------------
// El PR tiene que ser el de la story
//
// `parsePrUrl` acepta cualquier `github.com/<owner>/<repo>/pull/<n>`, y el
// `pr_url` lo escribe el propio developer con `report_progress`. Sin comparar
// contra el repo declarado de la story, el gate firma —y en GitHub *postea* un
// APPROVE real— sobre un PR de un repo arbitrario, típicamente uno del atacante.
// ---------------------------------------------------------------------------

// Las identidades de repo viven en `src/repos/identity.ts`: las usa también
// `create_stories` y la validación del frontmatter del RFC, que no puede
// depender de una tool. Se re-exportan acá porque este módulo sigue siendo el
// que define *qué se hace* con ellas.
export {
  adoRepoIdentity,
  declaredRepoIdentity,
  githubRepoIdentity,
  prRepoIdentity,
  DECLARA_EL_REPO,
} from '../../repos/identity.js';

/**
 * Repo declarado para la story: el denormalizado de la story manda, después el
 * del componente del RFC, y por último el `existing_repo` del flow (stories
 * legacy, anteriores al registry de componentes).
 */
export function declaredRepoForStory(
  flow: Pick<Flow, 'existing_repo'>,
  story: Pick<Story, 'target_repo'>,
  component: { repo?: string } | undefined,
): string | undefined {
  return story.target_repo ?? component?.repo ?? flow.existing_repo ?? undefined;
}

/**
 * Exige que el PR de la story viva en el repo declarado para esa story.
 *
 * Tres resultados:
 *  - repo declarado ausente → **error**. Un PR que se va a verificar tiene que
 *    tener un repo declarado contra el cual verificarlo; "no hay contra qué
 *    comparar → pasá" es un fail-open, no un caso legacy. Con el `return null`
 *    que había acá, `codebase_status: greenfield` —un RFC perfectamente válido,
 *    porque el frontmatter sólo exige repo cuando el codebase es `existing`—
 *    desactivaba el gate entero: `story.target_repo`, `component.repo` y
 *    `flow.existing_repo` son los tres `undefined`, y el APPROVE se posteaba
 *    sobre cualquier PR que el developer pusiera en `pr_url`.
 *  - alguno de los dos lados no es parseable para este proveedor → error. Es un
 *    fail-closed explícito: preferimos frenar un flujo mal declarado antes que
 *    firmar un APPROVE sobre un repo que no pudimos verificar.
 *  - identidades distintas → error.
 *
 * Este chequeo es la última línea, no la primera: `create_stories` ya rechaza
 * derivar el backlog de un flow sin repo declarado, que es el último momento en
 * el que `submit_rfc` sigue abierto (el flow todavía está en `rfc_ready`). Un
 * flow que llega hasta acá sin repo es data anterior a esa guarda, y por eso el
 * mensaje nombra también `start_flow`: con el backlog ya derivado, `submit_rfc`
 * está cerrado y rehacer el flow es la única salida honesta.
 *
 * Devuelve el mensaje de error, o `null` si pasa.
 */
export function assertPrTargetsStoryRepo(
  kind: PrProviderKind | string,
  prRef: PullRequestRef,
  declaredRepo: string | undefined,
  action: string,
): string | null {
  if (!declaredRepo) {
    return (
      `${action}: la story no declara ningún repo, así que no hay contra qué verificar el PR ${prRef.url} — ` +
      'y sin eso firmar el review sería aprobar un PR de un repo arbitrario. ' +
      `${DECLARA_EL_REPO} Si el backlog ya se derivó de este RFC, submit_rfc está cerrado: registrá el cambio ` +
      `con submit_adr y rehacé el flow con start_flow declarando el repo desde el RFC. Después volvé a llamar ${action}.`
    );
  }

  const expected = declaredRepoIdentity(kind, declaredRepo);
  const actual = prRepoIdentity(kind, prRef);

  if (!expected || !actual) {
    const cual = !expected ? `el repo declarado de la story ("${declaredRepo}")` : `la URL del PR (${prRef.url})`;
    return (
      `${action}: no se puede verificar de forma confiable que el PR pertenezca al repo de la story — ` +
      `no se pudo interpretar ${cual} con el proveedor "${kind}", así que frenamos en vez de firmar a ciegas. ` +
      `Corregí el repo del componente en el RFC con submit_rfc, o el pr_url con ` +
      `report_progress({status:"in_review", pr_url}), y volvé a llamar ${action}.`
    );
  }

  if (expected !== actual) {
    return (
      `${action}: el PR ${prRef.url} pertenece al repo "${actual}", pero la story declara "${expected}". ` +
      'Nadie firma un review sobre un repo que no es el de la story. Abrí el PR contra el repo correcto y ' +
      `registralo con report_progress({status:"in_review", pr_url}) antes de volver a llamar ${action}.`
    );
  }

  return null;
}

/** Cómo se vuelve a pedir el review. Único texto para las tres salidas de abajo. */
const PEDI_EL_REVIEW =
  'El review se pide con request_code_review({story_id, reviewer_ids}) —lo ejecuta alguien con rol qa o ' +
  'tech-lead— y recién después se firma el outcome con submit_review_outcome.';

/**
 * Exige un `review.requested` **vigente**: de esta story, del PR que la story
 * tiene ahora, y todavía sin consumir por un outcome anterior.
 *
 * Por qué el event log y no `flow.current_phase === 'review'`: la fase es estado
 * del *flow*, no de la story. En un flow multi-story la puso ahí cualquier otra
 * story (o quedó de una vuelta anterior), así que chequearla dejaría firmar una
 * story para la que nunca se pidió review. El evento, en cambio, lleva
 * `story_id` y `pr_url` en el payload: es la única prueba de que
 * `request_code_review` corrió **para esta story y para este PR**, y con él las
 * guardas de esa tool (rol qa|tech-lead, autor ≠ reviewer, PR en el repo de la
 * story, rechazo del no-op) dejan de ser salteables con sólo no llamarla.
 *
 * Las dos condiciones nuevas, y el ataque que cierra cada una:
 *
 *  1. **El `pr_url` del evento tiene que ser el actual.** Antes alcanzaba con
 *     que existiera *algún* `review.requested` de la story: como
 *     `changes_requested` devuelve la story a `in_progress` y el evento queda,
 *     el developer registraba otro `pr_url` con `report_progress` y firmaba un
 *     PR que nunca pasó por `request_code_review` — sin reviewers agregados y
 *     sin el chequeo de autor ≠ reviewer.
 *  2. **El evento tiene que ser posterior a todo lo que lo consume.** Un
 *     `review.requested` que ya fue respondido está consumido: es un token de un
 *     solo uso, no una llave permanente. Sin esto, cualquier story que reciba un
 *     `changes_requested` queda con el gate abierto para siempre sobre ese
 *     mismo PR, y el camino para llegar ahí es el flujo legítimo.
 *
 *     Lo consume **cualquiera de dos eventos**, no sólo el outcome:
 *      - `review.outcome.submitted`: alguien ya respondió ese pedido.
 *      - `progress.reported`: la story retrocedió. A `qa_passed → in_progress`
 *        también se llega con `report_progress`, que no emite ningún outcome, así
 *        que mirando sólo el outcome el token sobrevivía el retroceso: el
 *        developer volvía a `in_progress`, re-subía **el mismo PR** con otro
 *        contenido —para eso retrocedió—, QA pasaba de nuevo y la firma salía sin
 *        que `request_code_review` hubiera vuelto a correr: nadie fue re-agregado
 *        como reviewer y el chequeo de autor ≠ reviewer no se re-ejecutó. El
 *        `pr_url` coincidía porque es el mismo PR, que es justamente lo que hace
 *        que la condición 1 no alcance. Cualquier `progress.reported` posterior al
 *        pedido es prueba de que el trabajo siguió después de pedir el review, y
 *        eso invalida el pedido. El camino feliz no se toca: ahí el
 *        `progress.reported` (subir el PR) es **anterior** al `review.requested`.
 *
 * Se compara por posición en el log, no por `ts`: `listEvents` devuelve orden de
 * inserción en las dos implementaciones del store (array en memoria, `ORDER BY
 * seq` en Postgres) y dos eventos pueden compartir el milisegundo.
 *
 * Por qué el evento y no un campo `review_requested_for_pr` en la story: el
 * campo hay que invalidarlo a mano en cada lugar que toque `pr_url` (hoy
 * `report_progress`, mañana cualquier otro), y un olvido reabre exactamente este
 * agujero sin que nada lo note. El evento no se invalida: la respuesta se deriva
 * de hechos inmutables ya escritos —qué PR se pidió y cuándo, contra qué PR
 * tiene la story ahora— así que no hay estado que se pueda desincronizar. Es
 * además el mismo log que audita el resto del flow y no toca el schema.
 *
 * Devuelve el mensaje de error, o `null` si pasa.
 */
export function assertReviewRequested(
  events: readonly { type: string; payload: Record<string, unknown> }[],
  storyId: string,
  prUrl: string,
): string | null {
  const forStory = (e: { payload: Record<string, unknown> }) =>
    (e.payload as { story_id?: unknown })?.story_id === storyId;

  let lastRequestedForPr = -1;
  let lastRequestedAny = -1;
  let lastConsumed = -1;
  let lastConsumedType = '';
  events.forEach((e, i) => {
    if (!forStory(e)) return;
    if (e.type === 'review.requested') {
      lastRequestedAny = i;
      if ((e.payload as { pr_url?: unknown })?.pr_url === prUrl) lastRequestedForPr = i;
    } else if (e.type === 'review.outcome.submitted' || e.type === 'progress.reported') {
      lastConsumed = i;
      lastConsumedType = e.type;
    }
  });

  if (lastRequestedForPr === -1) {
    const detalle =
      lastRequestedAny === -1
        ? `nunca se pidió el code review de la story ${storyId} (no hay evento review.requested para esta story)`
        : `el review que se pidió para la story ${storyId} era sobre otro PR, no sobre ${prUrl} ` +
          '(el pr_url cambió después de pedirlo, así que este PR nunca pasó por request_code_review: ' +
          'no se agregó a nadie como reviewer ni corrió el chequeo de que el autor no se revise a sí mismo)';
    return `submit_review_outcome: ${detalle}. ${PEDI_EL_REVIEW}`;
  }

  if (lastRequestedForPr < lastConsumed) {
    const motivo =
      lastConsumedType === 'progress.reported'
        ? 'después de pedirlo la story volvió a moverse con report_progress, así que el PR que se firmaría no ' +
          'es el que se pidió revisar aunque la URL coincida'
        : 'ya fue respondido con un outcome anterior';
    return (
      `submit_review_outcome: el review que se había pedido para la story ${storyId} está consumido — ${motivo}. ` +
      `Un review.requested habilita una firma, no todas las que vengan después. ${PEDI_EL_REVIEW}`
    );
  }

  return null;
}

/** Qué miró el review, por eje: es lo que el comentario de una firma propia muestra. */
const REVIEW_AXES = {
  standards: 'Convenciones del repo y piso de smells',
  spec: 'Hace lo que pidieron el RFC y los criterios',
} as const;

export function reviewAxesResults(review: SubmitReviewOutcomeInput['review']): SelfSignoffCaseResult[] {
  return (Object.keys(REVIEW_AXES) as Array<keyof typeof REVIEW_AXES>).map((axis) => {
    const report = review[axis];
    const notes = [
      report.summary,
      ...report.findings.map((f) => `${f.file}${f.line !== undefined ? `:${f.line}` : ''} ${f.why}`),
    ]
      .filter((n): n is string => !!n && n.trim() !== '')
      .join('; ');
    return {
      case_id: axis,
      criterion: REVIEW_AXES[axis],
      status: report.verdict,
      ...(notes ? { notes } : {}),
    };
  });
}

export interface SubmitReviewOutcomeDeps {
  /** Para anotar el issue de la story en una firma propia. Sin esto, la firma propia se rechaza. */
  taskSystemProvider?: TaskSystemProvider;
  signoff?: SelfSignoffDeps;
}

export function makeSubmitReviewOutcomeTool(
  store: FlowStore,
  pullRequestProvider: PullRequestProvider,
  deps: SubmitReviewOutcomeDeps = {},
) {
  const signoff = deps.signoff ?? {};
  return {
    name: 'submit_review_outcome',
    description:
      'Records the review outcome (approved | changes_requested) for a story in the review phase. ' +
      'Requires role reviewer or tech-lead, a prior request_code_review for this story, a configured ' +
      "pr_provider, a PR that belongs to the story's declared repo, and an open PR. " +
      'Approved: advances the story to merged; the flow only closes (merged/done) once every story is merged. ' +
      'Changes requested: returns story and flow to in_progress/implementation. If the signer is the story ' +
      'assignee and the workspace allows self sign-off, the issue and PR get the sdlc:review-propio label and ' +
      'a detail comment, and GitHub records the outcome as a COMMENT review (self_signed:true).',
    inputSchema: SubmitReviewOutcomeInput,
    handler: async (input: SubmitReviewOutcomeInput, ctx: TenantCtx) => {
      const resolvedStory = await resolveStoryForCtx(store, ctx, input.story_id);
      if (!resolvedStory.ok) return { ok: false, error: resolvedStory.error };
      const { story, flow } = resolvedStory;

      // Separación de funciones — antes de cualquier side-effect. Los roles se
      // evalúan contra el workspace del flow: pertenecer al tenant no habilita a
      // firmar el review de un workspace donde no tenés el rol.
      const roleDenied = assertRole(ctx, ['reviewer', 'tech-lead'], 'submit_review_outcome', flow.project);
      if (roleDenied) {
        return {
          ok: false,
          error:
            `${roleDenied} Verificá tus roles con whoami y pedile a alguien con rol reviewer o ` +
            'tech-lead en ese workspace que ejecute submit_review_outcome.',
        };
      }
      // ¿Firma el autor? La política del workspace decide (épica #20). Sigue antes
      // de cualquier side-effect: una firma propia rechazada no toca nada.
      const decision = await selfSignoffPolicy(signoff, ctx, flow, story, 'submit_review_outcome');
      if (decision.self && !decision.allowed) {
        return {
          ok: false,
          error:
            `submit_review_outcome: ${decision.error} Mientras tanto la story queda en qa_passed.`,
        };
      }
      const selfSigned = decision.self;

      // Un flow abandonado no se firma, ni para aprobar ni para pedir cambios. El
      // `approved` lo frenaba `closeFlowIfSettled` (no cierra un flow `aborted`),
      // pero mergeaba la story igual; y la rama `changes_requested` escribía
      // `status: impl_in_review` sin mirar el status previo, o sea que reabría la
      // implementación de una iniciativa abandonada.
      const abortedDenied = assertFlowNotAborted(flow, 'submit_review_outcome');
      if (abortedDenied) return { ok: false, error: abortedDenied };

      if (story.status !== 'qa_passed') {
        return {
          ok: false,
          error:
            `submit_review_outcome requires story status=qa_passed (current=${story.status}). ` +
            'Llamá get_flow_state para ver en qué punto quedó la story y retomá desde ahí.',
        };
      }
      if (!story.pr_url) {
        return {
          ok: false,
          error:
            'story has no pr_url; cannot submit review outcome. ' +
            'Llamá report_progress({status:"in_review", pr_url}) con el PR real y después request_code_review.',
        };
      }
      if (input.outcome === 'changes_requested' && !input.comment) {
        return {
          ok: false,
          error:
            'comment is required when outcome=changes_requested. ' +
            'Volvé a llamar submit_review_outcome con comment describiendo qué hay que cambiar.',
        };
      }

      // El review tiene que haber sido pedido para ESTA story y para ESTE PR, y
      // no puede estar ya consumido por un outcome anterior. Sin esto,
      // `request_code_review` es opcional (todas sus guardas se evitan no
      // llamándola) y su evento es un token permanente. Ver
      // `assertReviewRequested`. Lectura, no side-effect: corre antes del proveedor.
      // Gate de admisión del review, antes de cualquier side-effect: acá abajo se
      // habla con el proveedor de PRs y se mueve la story. Si el envelope no cierra,
      // no se toca nada.
      const revision = validateReviewEnvelope(input.review);
      if (!revision.ok) {
        const detalle = revision.issues.map((i) => i.message).join(' ');
        return {
          ok: false,
          error:
            `El review no pasó la validación (${revision.issues.length} problema(s)): ${detalle} ` +
            `No se registró nada. La forma esperada es:\n${REVIEW_ENVELOPE_TEMPLATE}`,
          data: { issues: revision.issues },
          next_actions: ['submit_review_outcome'],
        };
      }

      // El envelope puede estar perfecto y el outcome contradecirlo.
      const contradice = verdictContradice(input.outcome, input.review);
      if (contradice) return { ok: false, error: contradice };

      const requestDenied = assertReviewRequested(
        await store.listEvents(flow.flow_id),
        story.story_id,
        story.pr_url,
      );
      if (requestDenied) return { ok: false, error: requestDenied };

      // Resolve the PR provider the same way request_code_review does: honor
      // the story component's repo_project so both halves of the review use
      // the same adapter in multi-repo flows.
      const resolved = resolveStoryComponent(flow, story);
      if (!resolved.ok) return { ok: false, error: resolved.error };
      const repoProject = resolved.component?.repo_project;
      const integrationProject = repoProject ?? flow.project;

      let prAdapter;
      try {
        prAdapter = await pullRequestProvider.resolve(ctx, flow, repoProject ? { project: repoProject } : undefined);
      } catch (err) {
        return {
          ok: false,
          error:
            `Failed to resolve PR provider: ${err instanceof Error ? err.message : String(err)}. ` +
            `Configurá pr_provider (github | azure-devops-repos) en tenant_integrations para el proyecto "${integrationProject}" ` +
            'y volvé a llamar submit_review_outcome.',
        };
      }

      // El no-op acepta cualquier URL y no verifica nada: dejarlo firmar el gate
      // llevaría la story a merged con un PR fantasma.
      if (isNoOpPullRequestAdapter(prAdapter)) {
        if (selfSigned) {
          // Un review propio se sostiene en la marca visible en el issue y el PR;
          // sin un provider real no quedaría en ningún lado.
          return {
            ok: false,
            error:
              `No hay pr_provider configurado para el proyecto "${integrationProject}", así que el review propio ` +
              'no dejaría ninguna marca visible (etiqueta sdlc:review-propio y comentario en el PR). Configurá ' +
              'pr_provider (github | azure-devops-repos) en tenant_integrations para ese proyecto y volvé a llamar ' +
              'submit_review_outcome.',
          };
        }
        return {
          ok: false,
          error:
            `No hay pr_provider configurado para el proyecto "${integrationProject}": el adapter no-op no verifica ` +
            'nada y aprobaría un PR inexistente. Configurá pr_provider (github | azure-devops-repos) en ' +
            'tenant_integrations para ese proyecto y volvé a llamar submit_review_outcome.',
        };
      }

      let prRef;
      try {
        prRef = prAdapter.parsePrUrl(story.pr_url);
      } catch (err) {
        return {
          ok: false,
          error:
            `Invalid PR URL: ${err instanceof Error ? err.message : String(err)}. ` +
            'Corregí el pr_url con report_progress({status:"in_review", pr_url}) y volvé a llamar submit_review_outcome.',
        };
      }

      // El PR tiene que ser el de la story: el `pr_url` lo escribió el developer
      // y `parsePrUrl` acepta cualquier repo. Antes del `getPullRequest` y, sobre
      // todo, del `submitOutcome` que postea el APPROVE real.
      const repoDenied = assertPrTargetsStoryRepo(
        prAdapter.kind,
        prRef,
        declaredRepoForStory(flow, story, resolved.component),
        'submit_review_outcome',
      );
      if (repoDenied) return { ok: false, error: repoDenied };

      // Verificar el PR ANTES de firmarlo. `submitOutcome` no comprueba nada: en
      // GitHub postea un review con event=APPROVE usando el token del server, o
      // sea que el sistema aprueba en lugar de constatar que alguien aprobó. Lo
      // mínimo que sí podemos constatar es que el PR exista y siga abierto.
      let prDetails: PrDetails;
      try {
        prDetails = await prAdapter.getPullRequest(prRef, ctx);
      } catch (err) {
        // Un error trayendo el PR aborta: no sabemos si existe ni en qué estado
        // está, y seguir sería aprobar a ciegas.
        return {
          ok: false,
          error:
            `No se pudo verificar el PR ${story.pr_url}: ${err instanceof Error ? err.message : String(err)}. ` +
            'Revisá que el PR exista y que el token del pr_provider tenga acceso al repo, y volvé a llamar submit_review_outcome.',
        };
      }

      const rawPrState = prDetails?.status;
      const prState = normalizePrState(rawPrState);
      if (prState !== 'open') {
        const detalle =
          prState !== 'unknown'
            ? `estado "${rawPrState}"`
            : typeof rawPrState === 'string' && rawPrState.trim() !== ''
              ? `estado desconocido "${rawPrState}"`
              : 'estado desconocido: el proveedor devolvió el PR sin campo de estado';
        return {
          ok: false,
          error:
            `El PR ${story.pr_url} no está abierto (${detalle}); no se puede firmar el review sobre un PR cerrado. ` +
            'Reabrí el PR o abrí uno nuevo, registralo con report_progress({status:"in_review", pr_url}) y volvé a ' +
            'llamar request_code_review antes de submit_review_outcome.',
        };
      }

      // Firma propia: la marca (etiqueta + comentario de detalle) va en el issue y
      // en el PR **antes** de firmar. Si no se puede dejar, la firma no existe: no
      // se postea el review ni se mueve la story ni se emite el evento. El issue va
      // primero porque es lo más probable que falle (providers sin `annotate`), y
      // así el PR no queda anotado a medias. Reintentar es seguro: `annotate` es
      // idempotente por el marcador del comentario.
      let outcomeComment = input.comment;
      if (selfSigned) {
        const annotation = selfSignoffAnnotation({
          kind: 'review',
          signer: ctx.userId,
          story: {
            story_id: story.story_id,
            external_id: story.external_id,
            title: story.title,
            acceptance_criteria: story.acceptance_criteria,
          },
          flow_id: flow.flow_id,
          signed_at: new Date().toISOString(),
          results: reviewAxesResults(input.review),
        });

        const annotateFailed = (target: 'issue' | 'pr', err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          signoff.logger?.warn?.({
            evt: 'signoff.annotate_failed',
            tool: 'submit_review_outcome',
            target,
            workspace_id: flow.project,
            story_id: story.story_id,
            error: message.slice(0, 300),
          });
          const donde = target === 'issue' ? `el issue ${story.external_id}` : `el PR ${story.pr_url}`;
          return {
            ok: false,
            error:
              `submit_review_outcome: no se pudo anotar ${donde} con la marca del review propio (${message}). ` +
              'Un review propio sin marca visible no se registra: no se publicó el review, la story sigue en ' +
              'qa_passed y no se emitió ningún evento. Resolvé el error del proveedor y volvé a llamar ' +
              'submit_review_outcome, o pedile a otra persona que firme.',
          };
        };

        if (!deps.taskSystemProvider) {
          return annotateFailed('issue', new Error('no hay task system disponible para anotar el issue'));
        }
        try {
          const taskSystem = await deps.taskSystemProvider.resolve(ctx, flow);
          await taskSystem.annotate(story.external_id, annotation, ctx);
        } catch (err) {
          return annotateFailed('issue', err);
        }
        try {
          await prAdapter.annotate(prRef, annotation, ctx);
        } catch (err) {
          return annotateFailed('pr', err);
        }

        // El review en el PR lleva el mismo detalle: en GitHub el autor no puede
        // aprobar su propio PR, así que el outcome queda como COMMENT (`as_author`).
        outcomeComment = [`**Review propio: ${input.outcome}**`, input.comment, annotation.body]
          .filter((part): part is string => !!part && part.trim() !== '')
          .join('\n\n');
      }

      try {
        await prAdapter.submitOutcome(
          {
            pr_ref: prRef,
            outcome: input.outcome,
            ...(outcomeComment !== undefined ? { comment: outcomeComment } : {}),
            ...(selfSigned ? { as_author: true } : {}),
          },
          ctx,
        );
      } catch (err) {
        return {
          ok: false,
          error:
            `PR provider error during submitOutcome: ${err instanceof Error ? err.message : String(err)}. ` +
            'La story no cambió de estado: resolvé el error del proveedor y volvé a llamar submit_review_outcome.',
        };
      }

      let updatedStory: typeof story;
      let updatedFlow: typeof flow;
      let nextActions: string[];

      if (input.outcome === 'approved') {
        updatedStory = await store.updateStory(story.story_id, {
          status: 'merged',
          review_envelope: {
          schema: REVIEW_ENVELOPE_SCHEMA,
          standards: input.review.standards,
          spec: input.review.spec,
          submitted_at: new Date().toISOString(),
        },
        });

        // Una story aprobada NO cierra el flow entero. El flow es el epic: un
        // epic de 8 stories quedaba en merged/done con la primera aprobación, y
        // las otras 7 —sin implementar— pasaban a colgar de un flow "terminado".
        // La decisión de cierre vive en `closeFlowIfSettled` porque el conteo de
        // pendientes lo cambian dos tools —esta al mergear, `discard_story` al
        // descartar— y escrita en una sola de las dos dejaba flows sin salida.
        // La story ya está persistida como `merged`, así que el helper la cuenta.
        const closure = await closeFlowIfSettled(store, flow);
        updatedFlow = closure.flow;
        // El flow se queda donde está mientras queden stories en vuelo: la fase
        // del flow describe al conjunto, no a esta story.
        nextActions = closure.closed ? [] : [`get_flow_state({flow_id:"${flow.flow_id}"})`];
      } else {
        updatedStory = await store.updateStory(story.story_id, {
          status: 'in_progress',
          review_envelope: {
          schema: REVIEW_ENVELOPE_SCHEMA,
          standards: input.review.standards,
          spec: input.review.spec,
          submitted_at: new Date().toISOString(),
        },
        });
        // changes_requested sí devuelve el flow entero a implementation, incluso
        // con varias stories en vuelo, y está bien: es un movimiento hacia atrás
        // que no habilita nada. Desde que el gate del review es por story (el
        // evento `review.requested`, no `current_phase`), la fase del flow ya no
        // autoriza a nadie a firmar, así que retroceder no puede des-gatear otra
        // story; lo único que hace es describir con precisión que volvió a haber
        // trabajo en implementación. La asimetría con el approved es deliberada:
        // cerrar concede, reabrir no.
        // Por el chokepoint, igual que el resto de las transiciones: "es un
        // movimiento hacia atrás que no habilita nada" vale mientras el flow esté
        // vivo. Sobre uno `aborted`, reabrir la implementación **sí** habilitaba —
        // era la mitad de la cadena que resucitaba el flow.
        const written = await updateFlowUnlessAborted(
          store,
          flow,
          { status: 'impl_in_review', current_phase: 'implementation' },
          'submit_review_outcome',
        );
        if (!written.ok) return { ok: false, error: written.error };
        updatedFlow = written.flow;
        nextActions = ['report_progress({status:"in_progress"})'];
      }

      await store.appendEvent({
        flow_id: flow.flow_id,
        type: 'review.outcome.submitted',
        actor: ctx.userId,
        payload: {
          story_id: story.story_id,
          pr_url: story.pr_url,
          pr_status: prDetails.status,
          outcome: input.outcome,
          comment: input.comment ?? null,
          // Los dos ejes viajan en el evento por la misma razón que la evidencia de
          // QA: un replay del log tiene que recuperar qué se miró, no sólo el
          // veredicto.
          review: { standards: input.review.standards, spec: input.review.spec },
          // El autor firmó su propio review (permitido por el workspace).
          self_signed: selfSigned,
        },
      });

      return {
        ok: true,
        data: { story: updatedStory, flow: updatedFlow },
        next_actions: nextActions,
      };
    },
  };
}
