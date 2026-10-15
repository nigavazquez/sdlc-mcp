import type { Flow } from '@sdlc/core';
import type { FlowStore } from '../../state/index.js';
import { updateFlowUnlessAborted } from './abort-flow.js';

/** Qué pasó al re-evaluar el cierre del flow. */
export interface FlowClosure {
  /** El flow, cerrado o tal como estaba. */
  flow: Flow;
  /** `true` sólo si esta llamada lo movió a merged/done. */
  closed: boolean;
  /** Stories vivas que todavía no están merged. */
  pending: number;
  /** Stories merged del flow. */
  merged: number;
}

/**
 * Re-evalúa el cierre del flow y lo cierra si ya no queda trabajo vivo.
 *
 * Vive acá y no dentro de `submit_review_outcome` porque el conteo de pendientes
 * lo cambian **dos** tools, no una: aprobar la última story (una pendiente menos
 * porque se mergeó) y descartar la última pendiente (una menos porque no se va a
 * hacer). Con la decisión escrita sólo en el camino del approve, el orden natural
 * de trabajo —mergear lo real primero y recién al final descartar lo sobrante—
 * dejaba el flow en `impl_in_review` sin ninguna tool capaz de volver a mirarlo:
 * `submit_review_outcome` rechaza una story ya `merged`, `discard_story` rechaza
 * una story ya `merged`, y la única salida era rebobinar el flow con
 * `sync_backlog` y entregar de punta a punta una story que nadie quería. Es
 * exactamente el absurdo que `discard_story` vino a eliminar, reaparecido un paso
 * más adelante.
 *
 * Las dos condiciones para cerrar:
 *
 *  1. **Cero pendientes.** "Vivas" excluye `discarded`, el único terminal de
 *     descarte, al que sólo se llega con `discard_story` (rol tech-lead + evento
 *     `story.discarded` con motivo). Sin esa exclusión una story creada de más
 *     dejaba el flow abierto para siempre.
 *  2. **Al menos una `merged`.** Un flow donde se descartaron *todas* las stories
 *     no entregó nada: cerrarlo como `merged/done` escribiría en el log que el
 *     epic se completó cuando lo que pasó es que se abandonó. `merged` es una
 *     afirmación sobre trabajo integrado, no un sinónimo de "no queda nada por
 *     hacer". Preferimos dejar el flow donde está —el backlog sigue siendo
 *     corregible con `create_stories` + `sync_backlog`— antes que inventar un
 *     cierre. Tampoco lo mandamos a `aborted` por nuestra cuenta: hoy nada en el
 *     server produce ese estado y abandonar un epic es una decisión de producto,
 *     no un efecto lateral de descartar la última story.
 *
 * Un flow ya cerrado no se vuelve a escribir (idempotente), y uno `aborted` no se
 * resucita.
 */
export async function closeFlowIfSettled(store: FlowStore, flow: Flow): Promise<FlowClosure> {
  const stories = await store.listStoriesByFlow(flow.flow_id);
  const pending = stories.filter((s) => s.status !== 'merged' && s.status !== 'discarded').length;
  const merged = stories.filter((s) => s.status === 'merged').length;

  const cierra =
    pending === 0 &&
    merged > 0 &&
    flow.status !== 'aborted' &&
    !(flow.status === 'merged' && flow.current_phase === 'done');

  if (!cierra) return { flow, closed: false, pending, merged };

  // El chequeo de `aborted` de arriba usa el flow que trajo el caller, leído antes
  // de sus side-effects; el chokepoint escribe condicionalmente y decide sobre el
  // status del momento de la escritura, no sobre el del snapshot ni sobre el de una
  // re-lectura previa. Si no escribió, el flow no cerró: es exactamente el
  // `closed: false` de siempre.
  const written = await updateFlowUnlessAborted(
    store,
    flow,
    { status: 'merged', current_phase: 'done' },
    'closeFlowIfSettled',
  );
  if (!written.ok) return { flow, closed: false, pending, merged };
  return { flow: written.flow, closed: true, pending, merged };
}
