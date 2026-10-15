import { z } from 'zod';
import type { Flow } from '@sdlc/core';
import type { TenantCtx } from '@sdlc/adapters-contracts';
import type { FlowStatusTransition, FlowStore } from '../../state/index.js';
import { resolveFlowForCtx } from './flow-access.js';
import { assertRole } from './role-guard.js';

export const AbortFlowInput = z.object({
  flow_id: z.string().min(1),
  reason: z.string().min(1),
});
export type AbortFlowInput = z.infer<typeof AbortFlowInput>;

/**
 * Guarda de estado terminal: un flow `aborted` no acepta más escrituras.
 *
 * Vive acá, al lado de la única tool que produce ese estado, por el mismo criterio
 * que `assertPrTargetsStoryRepo` vive en `submit-review-outcome.ts` y lo reusa
 * `request-code-review.ts`: el texto que nombra la salida ejecutable se escribe una
 * sola vez, junto al gate que lo define.
 *
 * Sin esto `aborted` sería un estado de mentira. `submit_rfc` ya lo rechazaba —era
 * la única tool que lo hacía— pero `submit_prd` y `sync_backlog` no miran el status
 * y lo pisaban con `prd_ready` / `backlog_ready`, o sea que abortar un flow y
 * resucitarlo costaba una llamada. Las demás tools de escritura no lo resucitaban
 * pero seguían operando sobre un flow abandonado: se claimeaban stories, se
 * publicaban ADRs y se generaban planes de QA de algo que nadie iba a entregar.
 *
 * No hay tool que saque un flow de `aborted`: es terminal a propósito. La salida es
 * `start_flow`, que abre una iniciativa nueva y deja el abandono en el log.
 *
 * Devuelve un mensaje de error si el flow está abortado, o `null` si pasa.
 */
export function assertFlowNotAborted(flow: Flow, action: string): string | null {
  if (flow.status !== 'aborted') return null;
  return (
    `${action}: el flow "${flow.flow_id}" está en status "aborted" — la iniciativa se abandonó y no ` +
    'acepta más cambios. No hay forma de desabortarlo: si el trabajo se retoma, abrí una iniciativa ' +
    'nueva con start_flow y enviá su PRD con submit_prd. El motivo del abandono está en el evento ' +
    `flow.aborted del log: get_flow_state({flow_id:"${flow.flow_id}"}).`
  );
}

/**
 * Guarda de `abort_flow` sobre el status previo: qué status impiden abortar y por qué.
 *
 * Vive en una función porque se evalúa **dos veces** con dos propósitos distintos: como
 * gate temprano (antes de contar stories y de emitir el evento) y como explicación de
 * un `applied:false` de la escritura condicional, cuando el status cambió en el medio.
 * Los dos casos merecen el mismo texto.
 */
function assertAbortable(flow: Flow): string | null {
  if (flow.status === 'aborted') {
    return (
      `abort_flow: el flow "${flow.flow_id}" ya está aborted. El motivo del abandono original está ` +
      `en el evento flow.aborted: get_flow_state({flow_id:"${flow.flow_id}"}). Si el trabajo se ` +
      'retoma, abrí una iniciativa nueva con start_flow.'
    );
  }
  if (flow.status === 'merged') {
    return (
      `abort_flow: el flow "${flow.flow_id}" está merged — el trabajo se integró, así que marcarlo ` +
      'abandonado reescribiría la historia. Si hay que revertir lo entregado, eso es un cambio ' +
      'nuevo: abrí una iniciativa con start_flow.'
    );
  }
  return null;
}

/** Los status desde los que `abort_flow` no puede escribir. Es el `WHERE` de su escritura. */
const NO_ABORTABLES = ['aborted', 'merged'] as const;

/** Resultado de una escritura sobre el flow que pudo ser rechazada por el terminal. */
export type FlowWriteResult = { ok: true; flow: Flow } | { ok: false; error: string };

/**
 * **Chokepoint de `flow.status`.** Toda transición de status del flow pasa por acá;
 * la única escritura directa que queda es la que produce `aborted`, unas líneas
 * más abajo.
 *
 * Por qué existe, y por qué la guarda por tool no alcanzaba: un reviewer
 * adversarial llevó un flow `aborted` hasta `merged/done` con
 * `submit_qa_results → request_code_review → submit_review_outcome`, y la causa
 * raíz no era la guarda faltante sino la **escritura incondicional**:
 * `request_code_review` hacía `updateFlow({status:'impl_in_review'})` sin mirar el
 * status previo, y `closeFlowIfSettled` —que sí chequea `aborted`— corría un paso
 * después, o sea que la defensa estaba puesta después del daño. Con la guarda en
 * diez tools y una escritura incondicional en la onceava, `aborted` volvía a ser
 * decorativo. La invariante tiene que vivir en el lugar donde se escribe, no
 * repetida en cada caller.
 *
 * Dos cosas que la guarda temprana no puede dar:
 *
 *  1. **Cobertura por construcción.** Una tool nueva que avance el flow usa esta
 *     función porque es la única forma de escribir el status: `UpdateFlowInput` no
 *     tiene `status`, `updateFlow` tira si el patch lo trae, y `updateFlowStatus`
 *     —el único método que lo mueve— se nombra acá y en ningún otro lado. El
 *     compilador es el censo; `test/aborted-flow-writes.test.ts` lo verifica por
 *     comportamiento, no por regex.
 *  2. **Escritura condicional.** La invariante se evalúa en el **mismo statement**
 *     que escribe (`UPDATE ... WHERE status NOT IN ('aborted')`, y su equivalente
 *     sincrónico en memoria). La versión anterior re-leía el flow y después
 *     escribía, que es mejor que nada pero sigue siendo una carrera: entre la
 *     re-lectura y la escritura hay un punto de suspensión, y dos requests MCP
 *     concurrentes en el mismo proceso Node alcanzan para que gane el último que
 *     escribe — un `abort_flow` pisado, y el flow resucitado con `ok:true`.
 *
 * Qué **no** es: no reemplaza a `assertFlowNotAborted` en el handler. Esto corre
 * después de los side-effects, así que un rechazo acá deja el work item movido o
 * los reviewers agregados: es el backstop de un bug, no el gate. La guarda
 * temprana sigue siendo la que cumple "las guardas corren antes de cualquier
 * side-effect".
 */
export async function updateFlowUnlessAborted(
  store: FlowStore,
  flow: Flow,
  patch: FlowStatusTransition,
  action: string,
): Promise<FlowWriteResult> {
  const written = await store.updateFlowStatus(flow.flow_id, patch, ['aborted']);
  if (written.applied) return { ok: true, flow: written.flow };

  // No se escribió. El caller **no** puede confundir esto con un éxito: siempre
  // sale `ok:false` con un texto que nombra la salida ejecutable. El caso normal es
  // que el flow esté aborted; el otro —el flow dejó de existir— no debería pasar,
  // pero devolver `ok:true` con el snapshot viejo sería afirmar que escribimos.
  const current = written.flow;
  const denied = current ? assertFlowNotAborted(current, action) : null;
  if (denied) return { ok: false, error: denied };
  return {
    ok: false,
    error:
      `${action}: la escritura sobre el flow "${flow.flow_id}" no se aplicó — el flow cambió de estado ` +
      'o dejó de existir mientras corría la operación, así que la transición de status se descartó. ' +
      `Mirá en qué quedó con get_flow_state({flow_id:"${flow.flow_id}"}) y volvé a intentar desde ahí.`,
  };
}

/**
 * Aborta un flow: lo lleva al terminal `FlowStatus.aborted`.
 *
 * Existe porque `aborted` estaba en el enum de status desde el principio y ninguna
 * de las tools lo seteaba. Un flow abandonado —la iniciativa se despriorizó, el
 * epic se replanteó de cero, el PRD resultó inviable— se quedaba para siempre en la
 * fase donde murió, indistinguible de uno en curso. `merged/done` no servía de
 * salida: afirma que el trabajo se integró.
 *
 * El caso que lo vuelve necesario y no cosmético lo dejó escrito `closeFlowIfSettled`:
 * un flow donde se descartaron *todas* las stories no entregó nada, así que no cierra
 * como `merged`, y ahí decidimos a propósito no mandarlo a `aborted` como efecto
 * lateral de descartar la última story —abandonar un epic es una decisión de producto,
 * no un side-effect—. Esta es la tool que toma esa decisión de frente, con rol y motivo.
 *
 * Los bordes:
 *
 *  - **Un flow `merged` no se aborta.** El trabajo se integró; marcarlo abandonado
 *    reescribiría la historia. Mismo criterio que `discard_story` con una story ya
 *    `merged`. El chequeo no es sólo un gate temprano: es el `WHERE` de la escritura,
 *    porque un `submit_review_outcome(approved)` concurrente cerraba el flow en
 *    `merged/done` y este abort lo pisaba, dejándolo abandonado y terminado a la vez.
 *  - **Un flow ya `aborted` no se re-aborta.** Rechazamos en vez de responder ok
 *    silenciosamente: el segundo motivo no se guarda en ninguna parte y decir "ok"
 *    haría creer que sí. El primer abandono es el que vale y está en el log.
 *  - **Las stories en vuelo no lo bloquean.** Abandonar trabajo empezado es
 *    justamente para lo que sirve la tool; exigir que el backlog esté limpio primero
 *    (`discard_story` una por una) haría inalcanzable el único caso que importa. Lo
 *    que sí hacemos es contarlas y nombrarlas en el evento y en la respuesta, para
 *    que el abandono quede auditable y quien lo ejecuta vea qué está dejando tirado.
 *    Las stories no se tocan: su status queda como estaba, y el flow abortado es lo
 *    que las saca de circulación.
 *  - **No se desaborta.** El status es terminal, y eso se sostiene en tres capas:
 *    `assertFlowNotAborted` en cada tool de escritura (la guarda, antes de los
 *    side-effects), `updateFlowUnlessAborted` en el único lugar que escribe
 *    `flow.status` (el chokepoint, por construcción: `UpdateFlowInput` no tiene
 *    `status` y `updateFlow` tira si el patch lo trae), y la escritura **condicional**
 *    del store, que evalúa la invariante en el mismo statement que escribe. La
 *    afirmación fue falsa dos veces: primero porque dos tools pisaban el status sin
 *    mirarlo, después porque el chokepoint re-leía en vez de escribir condicional y
 *    dos requests concurrentes se pisaban igual. Hoy no es una promesa: la cobertura
 *    la verifica `test/aborted-flow-writes.test.ts` por comportamiento y la carrera
 *    `test/flow-status-race.test.ts` con dos operaciones concurrentes reales.
 */
export function makeAbortFlowTool(store: FlowStore) {
  return {
    name: 'abort_flow',
    description:
      'Aborts a flow whose initiative was abandoned (deprioritized, superseded, or found unviable), ' +
      'moving it to the terminal status "aborted" and emitting flow.aborted with the reason. Requires ' +
      'role tech-lead or pmo in the flow workspace and a non-empty reason. A merged flow cannot be ' +
      'aborted, and an aborted flow cannot be un-aborted or re-aborted: no other tool accepts writes on ' +
      'it, so the only way forward is a new flow via start_flow. Stories still in flight do not block ' +
      'the abort; they are counted and recorded in the event.',
    inputSchema: AbortFlowInput,
    handler: async (input: AbortFlowInput, ctx: TenantCtx) => {
      const reason = input.reason.trim();
      if (reason.length === 0) {
        return {
          ok: false,
          error:
            'abort_flow: reason no puede estar vacío. Volvé a llamar abort_flow({flow_id, reason}) ' +
            'explicando por qué se abandona la iniciativa — queda en el evento flow.aborted como única ' +
            'traza del abandono, y el status es terminal.',
        };
      }

      const resolved = await resolveFlowForCtx(store, ctx, input.flow_id);
      if (!resolved.ok) return { ok: false, error: resolved.error };
      const flow = resolved.flow;

      // Guarda de rol antes de cualquier side-effect: abortar es terminal e
      // irreversible, así que es la concesión más grande del flujo. Los roles se
      // evalúan contra el workspace del flow, no contra el tenant.
      const roleDenied = assertRole(ctx, ['tech-lead', 'pmo'], 'abort_flow', flow.project);
      if (roleDenied) {
        return {
          ok: false,
          error:
            `${roleDenied} Verificá tus roles con whoami y pedile a alguien con rol tech-lead o pmo ` +
            'en ese workspace que ejecute abort_flow.',
        };
      }

      // Gate temprano, antes de contar stories y de emitir el evento. No alcanza por
      // sí solo: la decisión definitiva la toma el `WHERE` de la escritura de abajo.
      const noAbortable = assertAbortable(flow);
      if (noAbortable) return { ok: false, error: noAbortable };

      // Las stories en vuelo no bloquean el abort, pero se cuentan: el evento tiene
      // que decir qué trabajo quedó tirado, porque después de esto ninguna tool las
      // puede mover (el flow abortado las corta a todas).
      const stories = await store.listStoriesByFlow(flow.flow_id);
      const abandoned = stories.filter((s) => s.status !== 'merged' && s.status !== 'discarded');

      // Sólo se mueve el status. `current_phase` queda en la fase donde el flow se
      // abandonó a propósito: es el dato que dice hasta dónde había llegado, y
      // `CurrentPhase` no tiene un valor equivalente a `aborted` — mandarlo a `done`
      // sería la misma mentira que cerrarlo como `merged`.
      //
      // Escritura **condicional**, no re-lectura: el gate de arriba corrió contra el
      // status leído al principio del handler, y entre ese punto y esta línea hay dos
      // `await` (el rol y el conteo de stories). Con lectura-chequeo-escritura, un
      // `submit_review_outcome(approved)` concurrente cerraba el flow en `merged/done`
      // y este `UPDATE` lo pisaba con `aborted` dejándolo *a la vez* abandonado y
      // terminado: `status: aborted` con `current_phase: done` y la story `merged`.
      // Justo lo que la guarda de `merged` existe para impedir. El `WHERE` lo cierra.
      const written = await store.updateFlowStatus(
        flow.flow_id,
        { status: 'aborted' },
        NO_ABORTABLES,
      );
      if (!written.applied) {
        const denied = written.flow ? assertAbortable(written.flow) : null;
        return {
          ok: false,
          error:
            denied ??
            `abort_flow: el flow "${flow.flow_id}" cambió de estado mientras corría el abort, así que no ` +
              `se escribió nada y no se emitió flow.aborted. Mirá en qué quedó con ` +
              `get_flow_state({flow_id:"${flow.flow_id}"}) y, si sigue abandonado, volvé a llamar abort_flow.`,
        };
      }
      const updated = written.flow;
      await store.appendEvent({
        flow_id: flow.flow_id,
        type: 'flow.aborted',
        actor: ctx.userId,
        payload: {
          reason,
          previous_status: flow.status,
          phase_at_abort: flow.current_phase,
          abandoned_story_count: abandoned.length,
          abandoned_story_ids: abandoned.map((s) => s.story_id),
          merged_story_count: stories.filter((s) => s.status === 'merged').length,
        },
      });

      return {
        ok: true,
        data: {
          flow: updated,
          abandoned_story_count: abandoned.length,
          abandoned_story_ids: abandoned.map((s) => s.story_id),
        },
        // No hay próximo paso sobre este flow: el status es terminal. La única
        // continuación posible es una iniciativa nueva.
        next_actions: ['start_flow'],
      };
    },
  };
}
