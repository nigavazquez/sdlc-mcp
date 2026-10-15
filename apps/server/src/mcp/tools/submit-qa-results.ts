import { z } from 'zod';
import type { TenantCtx } from '@sdlc/adapters-contracts';
import type { RoleId } from '@sdlc/core';
import type { TaskSystemProvider } from '../../adapters/task-system-provider.js';
import { QA_ENVELOPE_SCHEMA, QaRunEnvelopeInput, StoryQaResult, QaVerdict } from '@sdlc/core';
import type { FlowStore } from '../../state/index.js';
import { resolveStoryForCtx } from './flow-access.js';
import { assertNotSelfSignoff, assertRole } from './role-guard.js';
import { assertFlowNotAborted } from './abort-flow.js';
import {
  isPlaceholderText,
  QA_ENVELOPE_TEMPLATE,
  validateQaEnvelope,
} from '../../validation/qa-envelope.js';

export const SubmitQaResultsInput = z.object({
  story_id: z.string().min(1),
  results: z.array(StoryQaResult),
  /**
   * Bloque estructurado de la corrida. **Obligatorio**, pero `optional()` acá:
   * lo exige el handler, no el schema, para poder devolver un `{ ok:false, error }`
   * que enumere todos los campos mal de una y nombre la salida ejecutable. Ver el
   * comentario de `QaRunEnvelopeInput` en `packages/core/src/story.ts`.
   */
  envelope: QaRunEnvelopeInput.optional(),
  verdict: QaVerdict,
  block_reason: z.string().optional(),
});
export type SubmitQaResultsInput = z.infer<typeof SubmitQaResultsInput>;

/** Quién puede firmar un veredicto de QA. */
const QA_SIGNOFF_ROLES: readonly RoleId[] = ['qa', 'tech-lead'];

/**
 * Techo del **payload del evento** `qa.results.submitted`, en bytes de JSON.
 *
 * El payload pasó de cuatro contadores a llevar los resultados con su evidencia,
 * así que ahora crece con el plan. Se acota **rechazando en la admisión**, no
 * recortando: tirar evidencia para que entre sería volver exactamente al problema
 * que este gate arregla. 64 KiB da para ~200 casos con URL y notas cortas; lo que
 * lo revienta en la práctica es una `notes` con un stack trace pegado, y para eso
 * está `evidence_url` — la nota apunta al log, no lo transcribe.
 *
 * Se mide sobre el payload **entero**, no sobre `{results, envelope}`. Medía sólo
 * esos dos y el payload lleva además `story_id`, `verdict`, `case_count`,
 * `failed_count` y `block_reason`; ese último es un `z.string().optional()` sin
 * cota, así que 2 MB de `block_reason` entraban al event log —y a
 * `story.qa_block_reason`, que es la misma cadena— con el techo intacto. El techo
 * decía acotar el payload del evento y no lo acotaba.
 *
 * Por qué medir el payload y no poner un tope por campo: un tope por campo hay
 * que agregarlo de nuevo cada vez que el payload crece, y el olvido no lo nota
 * nadie —es el bug que acabamos de tener—. El objeto que se serializa es uno y es
 * el que se escribe: medirlo cubre todo lo que hay adentro hoy y todo lo que se
 * le agregue mañana, incluido lo que se persiste en la story.
 */
const MAX_QA_PAYLOAD_BYTES = 64 * 1024;

// ---------------------------------------------------------------------------
// Evidencia
// ---------------------------------------------------------------------------

/**
 * Hosts que no prueban nada: dominios reservados para ejemplos y documentación
 * (RFC 2606 / RFC 6761) y loopback.
 *
 * Un reviewer adversarial pasó este gate con `https://foo.test/log`,
 * `https://foo.invalid/log` y `http://192.168.0.10/log`: sólo estaban los
 * `example.*` y el loopback exacto. `.test` e `.invalid` son de la misma RFC que
 * `.example` y los rangos privados son igual de inalcanzables desde afuera, así
 * que van todos por las mismas reglas de abajo.
 *
 * Cualquier host sin punto (`localhost`, `ci`, `mi-server`) cae por la regla de
 * `isPlaceholderHost`, no hace falta enumerarlo.
 */
const PLACEHOLDER_HOSTS = new Set([
  'example.com',
  'example.org',
  'example.net',
  'example.edu',
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  '::1',
  '::',
]);

/** Subdominios de los dominios de ejemplo (`foo.example.com`) también son relleno. */
const PLACEHOLDER_SUFFIXES = ['.example.com', '.example.org', '.example.net', '.localhost'];

/**
 * TLDs que por definición no resuelven en la Internet pública: reservados por
 * RFC 2606 (`.test`, `.example`, `.invalid`, `.localhost`), por RFC 6762/8375
 * (`.local`, `.home.arpa`) o de uso interno (`.internal`). Una evidencia alojada
 * ahí no la puede abrir nadie más que quien la escribió.
 */
const RESERVED_TLDS = ['.test', '.example', '.invalid', '.localhost', '.local', '.internal'];

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/**
 * Rangos IPv4 que no son alcanzables desde afuera de la red de quien firma:
 * privados (RFC 1918), loopback, link-local, CGNAT, TEST-NET y multicast.
 *
 * `http://192.168.0.10/log` pasaba el gate anterior. Una URL así puede ser un
 * link real en la máquina del agente y aun así no ser evidencia: nadie que
 * audite la story después la puede abrir.
 */
function isReservedIpv4(host: string): boolean {
  const m = IPV4_RE.exec(host);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (a === undefined || b === undefined) return false;
  if (a > 255 || b > 255 || Number(m[3]) > 255 || Number(m[4]) > 255) return false;
  if (a === 0 || a === 10 || a === 127) return true; // this-network, RFC 1918, loopback
  if (a === 169 && b === 254) return true; // link-local
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC 1918
  if (a === 192 && b === 168) return true; // RFC 1918
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT (RFC 6598)
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking (RFC 2544)
  if (a === 192 && b === 0 && Number(m[3]) === 2) return true; // TEST-NET-1
  if (a === 198 && b === 51 && Number(m[3]) === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && Number(m[3]) === 113) return true; // TEST-NET-3
  if (a >= 224) return true; // multicast + reservado
  return false;
}

/** ULA (`fc00::/7`) y link-local (`fe80::/10`): el equivalente IPv6 de lo de arriba. */
function isReservedIpv6(host: string): boolean {
  if (!host.includes(':')) return false;
  return /^f[cd][0-9a-f]{0,2}:/i.test(host) || /^fe[89ab][0-9a-f]?:/i.test(host);
}

/**
 * Allowlist opcional de hosts de evidencia, en el mismo formato CSV que
 * `ADMIN_EMAILS` / `ALLOWED_EMAIL_DOMAINS` (ver `apps/server/src/config.ts`).
 *
 * Se lee en cada llamada y no al boot porque el registry de tools no recibe la
 * `Config` del proceso: cablearla implicaría tocar `buildToolRegistry` y todos
 * sus callers, fuera del alcance de este gate. Vacío o ausente => sólo aplican
 * las reglas de forma (http(s) + host plausible + path sin relleno).
 */
const HostAllowlistCsv = z.string().default('');

export function evidenceHostAllowlist(env: NodeJS.ProcessEnv = process.env): string[] {
  return HostAllowlistCsv.parse(env.QA_EVIDENCE_HOST_ALLOWLIST ?? undefined)
    .split(',')
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean);
}

function normalizeHost(url: URL): string {
  // Node deja los literales IPv6 entre corchetes (`[::1]`).
  return url.hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
}

function isPlaceholderHost(host: string): boolean {
  if (PLACEHOLDER_HOSTS.has(host)) return true;
  if (PLACEHOLDER_SUFFIXES.some((suffix) => host.endsWith(suffix))) return true;
  if (RESERVED_TLDS.some((tld) => host.endsWith(tld))) return true;
  if (isReservedIpv4(host)) return true;
  if (isReservedIpv6(host)) return true;
  // Un host sin punto no es alcanzable desde afuera: intranet inventada o relleno.
  return !host.includes('.');
}

/**
 * Path o query de relleno: `https://ci.acme.dev/TODO`, `https://n.ai/n%2Fa`,
 * `.../tbd`, `.../pending`, `.../none`.
 *
 * Es el caso que el comentario del código anterior decía cubrir ("mata `n/a`,
 * `TODO`, `TBD`") y no cubría: no había ningún regex, sólo el chequeo de host, y
 * el reviewer pasó el gate con un host plausible y `/TODO` de path. Con un host
 * real y el path inventado, la URL es sintácticamente perfecta y no lleva a
 * ninguna corrida.
 *
 * Se compara segmento por segmento **decodificado** (`n%2Fa` → `n/a`) y sobre
 * los valores de la query, con la misma regex `not` que usa el envelope.
 * Devuelve el fragmento culpable, o `null`.
 */
function fillerPathPart(url: URL): string | null {
  for (const raw of url.pathname.split('/')) {
    if (raw.length === 0) continue;
    let segment = raw;
    try {
      segment = decodeURIComponent(raw);
    } catch {
      /* secuencia percent inválida: se evalúa tal cual llegó */
    }
    if (isPlaceholderText(segment)) return segment;
  }
  for (const [, value] of url.searchParams) {
    if (value.length > 0 && isPlaceholderText(value)) return value;
  }
  return null;
}

/** El host está permitido si es exactamente uno de la lista o un subdominio suyo. */
function isAllowedHost(host: string, allowlist: readonly string[]): boolean {
  return allowlist.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}

type EvidenceProblem = { case_id: string; reason: string };

/** Devuelve el motivo por el que la URL no sirve como evidencia, o `null` si sirve. */
function evidenceProblem(raw: string, allowlist: readonly string[]): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return `"${raw}" no es una URL absoluta`;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return `"${raw}" no usa http:// ni https://`;
  }
  const host = normalizeHost(url);
  if (isPlaceholderHost(host)) {
    return `el host "${host}" es de relleno (dominio reservado o de ejemplo, IP privada o de loopback, o host sin punto)`;
  }
  const filler = fillerPathPart(url);
  if (filler !== null) {
    return `"${raw}" tiene relleno en el path o la query ("${filler}"): el host es real pero la URL no lleva a ninguna corrida`;
  }
  if (allowlist.length > 0 && !isAllowedHost(host, allowlist)) {
    return `el host "${host}" no está en QA_EVIDENCE_HOST_ALLOWLIST (permitidos: ${allowlist.join(', ')})`;
  }
  return null;
}

export function makeSubmitQaResultsTool(store: FlowStore, taskSystemProvider: TaskSystemProvider) {
  return {
    name: 'submit_qa_results',
    description:
      'Submits a QA verdict (passed | blocked) for a story in in_review. Requires role qa or tech-lead, ' +
      'and the story assignee cannot sign off their own QA. Every reported case needs an http(s) evidence_url ' +
      'pointing at a real system, and the call must carry a machine-parseable envelope ' +
      `("${QA_ENVELOPE_SCHEMA}": test_command, test_exit_code, test_output_hash, acceptance_criteria "N/M"). ` +
      'The verdict is checked against the envelope, not against the prose: verdict "passed" with a non-zero ' +
      'test_exit_code is rejected, the acceptance_criteria denominator must match the story, and verdict ' +
      '"passed" requires full coverage (covered === total) — partial coverage is a "blocked". ' +
      'Admission runs FIRST: if it fails nothing is written — the story, the work item and the event log are ' +
      'left exactly as they were. On success the results and the envelope are persisted on the story and ' +
      'emitted in qa.results.submitted, and the work item transitions to Closed or Active.',
    inputSchema: SubmitQaResultsInput,
    handler: async (input: SubmitQaResultsInput, ctx: TenantCtx) => {
      const resolved = await resolveStoryForCtx(store, ctx, input.story_id);
      if (!resolved.ok) return { ok: false, error: resolved.error };
      const { story, flow } = resolved;

      // Guardas de autorización antes de cualquier side-effect (el side-effect
      // de esta tool es `taskSystem.transition`, al final).
      const roleDenied = assertRole(ctx, QA_SIGNOFF_ROLES, 'submit_qa_results', flow.project);
      if (roleDenied) {
        return {
          ok: false,
          error: `${roleDenied} Pedile a alguien con rol qa o tech-lead en "${flow.project}" que firme el QA de esta story.`,
        };
      }
      const selfSignoff = assertNotSelfSignoff(ctx, story, 'submit_qa_results');
      if (selfSignoff) return { ok: false, error: selfSignoff };

      // Un flow abandonado no se verifica. Ésta era la primera llamada de la cadena
      // que resucitaba un flow `aborted`: no escribe el status del flow —así que
      // por sí sola no lo resucitaba— pero dejaba la story en `qa_passed`, que es
      // la precondición de `request_code_review`, y ésa sí lo pisaba.
      const abortedDenied = assertFlowNotAborted(flow, 'submit_qa_results');
      if (abortedDenied) return { ok: false, error: abortedDenied };

      if (story.status !== 'in_review') {
        return {
          ok: false,
          error: `Cannot submit results unless story is in_review (current=${story.status})`,
        };
      }
      if (!story.qa_plan) {
        return { ok: false, error: 'No qa_plan on this story; call generate_qa_plan first.' };
      }

      // ---------------------------------------------------------------------
      // Gate de admisión. Validamos TODO antes de escribir nada.
      //
      // Es el mismo gate que submit_prd y submit_rfc, por el mismo motivo: un
      // agente que no puede producir un resultado válido tampoco debería poder
      // pisar el resultado válido anterior. Acá "escribir" son tres cosas y las
      // tres viven después de este bloque: `taskSystem.transition` (que mueve el
      // work item en el sistema externo y no tiene undo), `updateStory` y
      // `appendEvent`. Si la admisión falla se devuelve `{ ok:false }` y ninguna
      // de las tres corrió: la story, el work item y el log quedan como estaban.
      //
      // Ojo con el orden: `taskSystem.resolve` también queda abajo. Resolver el
      // adapter antes de validar no escribe nada, pero puede tirar por
      // configuración y taparía el error real de admisión.
      //
      // Un `blocked` **válido** sí escribe: validez y readiness son decisiones
      // separadas. Este gate decide si el resultado es admisible, no si la story
      // avanza.
      // ---------------------------------------------------------------------

      const planCaseIds = new Set(story.qa_plan.cases.map((c) => c.case_id));
      const seen = new Set<string>();
      for (const r of input.results) {
        if (!planCaseIds.has(r.case_id)) {
          return { ok: false, error: `Unknown case_id "${r.case_id}" — not in qa_plan.` };
        }
        if (seen.has(r.case_id)) {
          return { ok: false, error: `Duplicate result for case_id "${r.case_id}".` };
        }
        seen.add(r.case_id);
      }
      const missing = [...planCaseIds].filter((id) => !seen.has(id));
      if (missing.length > 0) {
        return {
          ok: false,
          error: `Incomplete coverage: missing results for ${missing.join(', ')}.`,
        };
      }

      // Evidencia: la exigimos en **todo** caso reportado, pase o falle. El
      // camino que avanza el flow no puede ser el que no pide nada.
      const allowlist = evidenceHostAllowlist();
      const withoutEvidence: string[] = [];
      const badEvidence: EvidenceProblem[] = [];
      for (const r of input.results) {
        const raw = r.evidence_url?.trim();
        if (!raw) {
          withoutEvidence.push(r.case_id);
          continue;
        }
        const problem = evidenceProblem(raw, allowlist);
        if (problem) badEvidence.push({ case_id: r.case_id, reason: problem });
      }
      // Se reportan todos juntos: un error de a un case_id son N round-trips.
      if (withoutEvidence.length > 0) {
        return {
          ok: false,
          error:
            `Falta evidence_url en ${withoutEvidence.join(', ')}. Todo caso reportado necesita evidencia ` +
            'verificable (corrida de CI, log, video, ticket), pase o falle. Agregá evidence_url a esos casos ' +
            'y reintentá submit_qa_results; si todavía no corriste la verificación, correla primero o devolvé ' +
            `la story con block_story({story_id:"${story.story_id}", reason:"<qué falta>"}).`,
        };
      }
      if (badEvidence.length > 0) {
        const detail = badEvidence.map((p) => `${p.case_id}: ${p.reason}`).join('; ');
        const allowlistHint = badEvidence.some((p) =>
          p.reason.includes('QA_EVIDENCE_HOST_ALLOWLIST'),
        )
          ? ' Si el host es legítimo, pedile al admin que lo agregue a QA_EVIDENCE_HOST_ALLOWLIST.'
          : '';
        return {
          ok: false,
          error:
            `evidence_url inválida — ${detail}. Sólo se aceptan URLs http(s) que apunten a un sistema real ` +
            `donde se pueda ver la corrida. Corregí esas URLs y reintentá submit_qa_results.${allowlistHint}`,
        };
      }

      const anyFailed = input.results.some((r) => r.status === 'failed');
      if (input.verdict === 'passed' && anyFailed) {
        return {
          ok: false,
          error:
            'Inconsistent verdict: cannot pass with any failed case. Mandá verdict:"blocked" con block_reason, ' +
            'o corregí el status de los casos que en realidad pasaron y reintentá submit_qa_results.',
        };
      }
      if (input.verdict === 'blocked') {
        if (!input.block_reason || input.block_reason.trim().length === 0) {
          return {
            ok: false,
            error:
              'block_reason is required when verdict=blocked. Agregá block_reason con qué rompió y reintentá submit_qa_results.',
          };
        }
        if (!anyFailed) {
          return {
            ok: false,
            error:
              'verdict=blocked requires at least one failed case. Marcá el caso que falló con status:"failed" ' +
              'y reintentá submit_qa_results, o mandá verdict:"passed" si en realidad pasó todo.',
          };
        }
      }

      // El envelope: lo único que este gate parsea para decidir. La prosa
      // (`notes`, `block_reason`, el propio `verdict`) es para las personas —
      // acá se la chequea contra los campos estructurados, no al revés. El
      // denominador de `acceptance_criteria` sale de la story, nunca del agente.
      const envelopeCheck = validateQaEnvelope(input.envelope ?? null, {
        verdict: input.verdict,
        acceptance_criteria_total: story.acceptance_criteria.length,
      });
      if (!envelopeCheck.ok) {
        const detalle = envelopeCheck.issues.map((i) => i.message).join('; ');
        return {
          ok: false,
          error:
            `El envelope de la corrida no es válido (${envelopeCheck.issues.length} problema(s)): ${detalle}. ` +
            'No se escribió nada: la story, el work item y el log quedaron como estaban. ' +
            `Corregí el bloque y reintentá submit_qa_results con ${QA_ENVELOPE_TEMPLATE}. ` +
            `Si todavía no corriste la verificación, correla primero o devolvé la story con ` +
            `block_story({story_id:"${story.story_id}", reason:"<qué falta>"}).`,
          data: { envelope_issues: envelopeCheck.issues },
          next_actions: ['submit_qa_results', 'block_story'],
        };
      }
      const envelope = envelopeCheck.envelope;

      // El payload del evento se arma acá, ANTES del techo, porque el techo se mide
      // sobre él: es el objeto que se serializa y se escribe, así que medir
      // cualquier subconjunto deja la diferencia sin acotar (ver
      // `MAX_QA_PAYLOAD_BYTES`). Los contadores quedan por compatibilidad; lo que
      // hace auditable el log son `results` (con sus evidence_url) y `envelope`.
      // Ver `QaResultsSubmittedPayload` en @sdlc/core.
      const eventPayload = {
        story_id: story.story_id,
        verdict: input.verdict,
        case_count: input.results.length,
        failed_count: input.results.filter((r) => r.status === 'failed').length,
        results: input.results,
        envelope,
        ...(input.verdict === 'blocked' ? { block_reason: input.block_reason ?? null } : {}),
      };

      // Techo del payload que se persiste y se emite. Se rechaza, no se recorta:
      // ver `MAX_QA_PAYLOAD_BYTES`.
      const payloadBytes = Buffer.byteLength(JSON.stringify(eventPayload), 'utf8');
      if (payloadBytes > MAX_QA_PAYLOAD_BYTES) {
        return {
          ok: false,
          error:
            `El payload del resultado pesa ${payloadBytes} bytes y el máximo es ${MAX_QA_PAYLOAD_BYTES}. ` +
            'No se recorta la evidencia para que entre: acortá las "notes" y el "block_reason" (apuntan al ' +
            'log, no lo transcriben — para el detalle está evidence_url) y reintentá submit_qa_results. Si el ' +
            'plan es genuinamente enorme, partí la story con propose_breakdown.',
          next_actions: ['submit_qa_results'],
        };
      }

      // --- A partir de acá, side-effects. La admisión ya pasó. ---------------
      const adoStatus = input.verdict === 'passed' ? 'Closed' : 'Active';
      const taskSystem = await taskSystemProvider.resolve(ctx, flow);
      await taskSystem.transition(story.external_id, adoStatus, ctx);

      const updated = await store.updateStory(story.story_id, {
        status: input.verdict === 'passed' ? 'qa_passed' : 'blocked',
        qa_verdict: input.verdict,
        qa_block_reason: input.verdict === 'blocked' ? (input.block_reason ?? null) : null,
        // Un `blocked` válido se persiste igual que un `passed`: es un resultado
        // de QA legítimo y su evidencia es la que después justifica el rework.
        qa_results: input.results,
        qa_envelope: envelope,
      });
      await store.appendEvent({
        flow_id: flow.flow_id,
        type: 'qa.results.submitted',
        actor: ctx.userId,
        payload: eventPayload,
      });

      return {
        ok: true,
        data: { story: updated, verdict: input.verdict, envelope },
        next_actions:
          input.verdict === 'passed'
            ? ['request_code_review']
            : ['report_progress({status:"in_progress"})'],
      };
    },
  };
}
