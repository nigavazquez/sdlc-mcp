import { z } from 'zod';
import type { TenantCtx } from '@sdlc/adapters-contracts';
import type { FlowStore } from '../../state/index.js';
import { resolveStoryForCtx } from './flow-access.js';
import type { PullRequestProvider } from '../../adapters/pull-request-provider.js';
import { isNoOpPullRequestAdapter } from '../../adapters/pull-request-provider.js';
import { resolveStoryComponent } from './story-component.js';
import { assertRole } from './role-guard.js';
import { assertFlowNotAborted, updateFlowUnlessAborted } from './abort-flow.js';
// Los helpers viven en submit-review-outcome.ts, que es el gate principal que
// protegen; acá se reusan para que las dos mitades del review exijan lo mismo.
import { assertPrTargetsStoryRepo, declaredRepoForStory } from './submit-review-outcome.js';

export const RequestCodeReviewInput = z.object({
  story_id: z.string().min(1),
  reviewer_ids: z.array(z.string().min(1)).min(1),
  message: z.string().optional(),
});
export type RequestCodeReviewInput = z.infer<typeof RequestCodeReviewInput>;

/**
 * Detecta si alguno de los `reviewer_ids` es el autor de la story.
 *
 * Limitación conocida y deliberada: `reviewer_ids` son logins de GitHub o GUIDs
 * de identidad de ADO, mientras que `story.assignee` y `ctx.userId` son ids
 * internos del server. No existe hoy un directorio que mapee un espacio de
 * nombres al otro, así que lo único que podemos afirmar con certeza es la
 * coincidencia literal (normalizada a minúsculas y sin espacios). Eso cubre el
 * caso real —el autor se agrega a sí mismo usando el id con el que opera— sin
 * fingir una verificación más fuerte de la que tenemos.
 *
 * Cuando exista el directorio de identidades, hay que resolver cada
 * `reviewer_id` a un user id interno antes de comparar y este helper pasa a ser
 * una comparación sólida en lugar de una defensiva.
 */
export function findAuthorAmongReviewers(
  reviewerIds: readonly string[],
  authorIds: readonly (string | undefined)[],
): string | undefined {
  const authors = new Set(
    authorIds.filter((id): id is string => !!id).map((id) => id.trim().toLowerCase()),
  );
  return reviewerIds.find((r) => authors.has(r.trim().toLowerCase()));
}

export function makeRequestCodeReviewTool(store: FlowStore, pullRequestProvider: PullRequestProvider) {
  return {
    name: 'request_code_review',
    description:
      'Requests a code review for a QA-passed story. Requires role qa or tech-lead and a configured ' +
      "pr_provider. Adds the specified reviewers to the PR identified by the story's pr_url, advances " +
      'the flow to the review phase, and emits review.requested.',
    inputSchema: RequestCodeReviewInput,
    handler: async (input: RequestCodeReviewInput, ctx: TenantCtx) => {
      const resolvedStory = await resolveStoryForCtx(store, ctx, input.story_id);
      if (!resolvedStory.ok) return { ok: false, error: resolvedStory.error };
      const { story, flow } = resolvedStory;

      // request_code_review es el paso que sigue a que QA apruebe, así que lo
      // pide quien firmó la QA (o el tech-lead). Los roles se evalúan contra el
      // workspace del flow. Guarda aplicada antes de cualquier side-effect.
      const roleDenied = assertRole(ctx, ['qa', 'tech-lead'], 'request_code_review', flow.project);
      if (roleDenied) {
        return {
          ok: false,
          error:
            `${roleDenied} Verificá tus roles con whoami y pedile a alguien con rol qa o tech-lead ` +
            'en ese workspace que ejecute request_code_review.',
        };
      }

      // Un flow abandonado no pide reviews. Ésta era **la** puerta de la
      // resurrección: la escritura de `status: impl_in_review` de más abajo no
      // miraba el status previo, así que un flow `aborted` con una story en
      // `qa_passed` volvía a `impl_in_review` en una llamada, y desde ahí
      // `submit_review_outcome` lo cerraba como `merged/done`. `closeFlowIfSettled`
      // sí chequeaba `aborted`, pero corría un paso después: la defensa estaba
      // puesta después del daño.
      const abortedDenied = assertFlowNotAborted(flow, 'request_code_review');
      if (abortedDenied) return { ok: false, error: abortedDenied };

      if (story.status !== 'qa_passed') {
        return {
          ok: false,
          error:
            `Can only request review for a qa_passed story (current status=${story.status}). ` +
            'Cerrá la QA con submit_qa_results({verdict:"passed"}) antes de pedir el review.',
        };
      }
      if (!story.pr_url) {
        return {
          ok: false,
          error:
            'story has no pr_url; call report_progress({status:"in_review", pr_url}) first',
        };
      }

      // El autor no puede ser reviewer de su propio cambio: sería el mismo
      // fail-open que la separación de funciones cierra del otro lado.
      const authorAsReviewer = findAuthorAmongReviewers(input.reviewer_ids, [story.assignee, ctx.userId]);
      if (authorAsReviewer) {
        return {
          ok: false,
          error:
            `reviewer_ids incluye a "${authorAsReviewer}", que es quien tiene asignada la story ` +
            `${story.story_id}: nadie puede revisar su propio cambio. Volvé a llamar request_code_review ` +
            'con reviewer_ids de otras personas.',
        };
      }

      // For multi-repo flows, resolve the PR provider for the integration
      // project of the story's target component (falls back to flow.project).
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
            'y volvé a llamar request_code_review.',
        };
      }

      // Mismo criterio que submit_adr con el doc store: el no-op acepta
      // cualquier URL y no crea ni valida nada, así que dejaría la story en
      // review contra un PR fantasma.
      if (isNoOpPullRequestAdapter(prAdapter)) {
        return {
          ok: false,
          error:
            `No hay pr_provider configurado para el proyecto "${integrationProject}": el adapter no-op acepta ` +
            'cualquier pr_url y pondría el flow en review sobre un PR inexistente. Configurá pr_provider ' +
            '(github | azure-devops-repos) en tenant_integrations para ese proyecto y volvé a llamar request_code_review.',
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
            'Corregí el pr_url con report_progress({status:"in_review", pr_url}) y volvé a llamar request_code_review.',
        };
      }

      // Mismo chequeo que submit_review_outcome, un paso antes: pedir el review
      // ya es un side-effect sobre el repo del PR (agrega reviewers, y con
      // `message` postea un comentario), así que el PR de un repo ajeno se
      // rechaza acá y no llega a emitir el `review.requested` que habilita la firma.
      const repoDenied = assertPrTargetsStoryRepo(
        prAdapter.kind,
        prRef,
        declaredRepoForStory(flow, story, resolved.component),
        'request_code_review',
      );
      if (repoDenied) return { ok: false, error: repoDenied };

      try {
        await prAdapter.requestReview(
          { pr_ref: prRef, reviewer_ids: input.reviewer_ids, ...(input.message !== undefined ? { message: input.message } : {}) },
          ctx,
        );
      } catch (err) {
        return {
          ok: false,
          error:
            `PR provider error during requestReview: ${err instanceof Error ? err.message : String(err)}. ` +
            'El flow no avanzó: resolvé el error del proveedor y volvé a llamar request_code_review.',
        };
      }

      // Por el chokepoint: la guarda de arriba corrió antes de tocar el PR, pero
      // entre ella y esta línea se agregaron los reviewers, y el flow pudo haberse
      // abortado en esa ventana. Un status que no se pisa sin mirarlo es lo que
      // hace que `aborted` sea terminal de verdad.
      const written = await updateFlowUnlessAborted(
        store,
        flow,
        { current_phase: 'review', status: 'impl_in_review' },
        'request_code_review',
      );
      if (!written.ok) return { ok: false, error: written.error };
      const updatedFlow = written.flow;

      await store.appendEvent({
        flow_id: flow.flow_id,
        type: 'review.requested',
        actor: ctx.userId,
        payload: {
          story_id: story.story_id,
          pr_url: story.pr_url,
          reviewer_ids: input.reviewer_ids,
        },
      });

      return {
        ok: true,
        data: { story, flow: updatedFlow },
        next_actions: ['submit_review_outcome'],
      };
    },
  };
}
