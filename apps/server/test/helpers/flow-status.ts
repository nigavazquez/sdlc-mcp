import type { Flow } from '@sdlc/core';
import type { FlowStatusTransition, FlowStore } from '../../src/state/index.js';

/**
 * Pone un flow en un status dado, para seedear un test.
 *
 * Existe porque `store.updateFlow` dejó de aceptar `status`: el tipo no lo tiene y
 * el store tira si el patch lo trae. La única escritura de `flow.status` es
 * `updateFlowStatus`, que es condicional; acá pasamos `blockedFrom: []` porque un
 * seed no tiene precondición — arranca desde cualquier status y se aplica siempre.
 *
 * Los tests que quieren probar la **precondición** no usan esto: llaman a
 * `store.updateFlowStatus` con su lista de status bloqueados, o al chokepoint
 * `updateFlowUnlessAborted`.
 */
export async function seedFlowStatus(
  store: FlowStore,
  flowId: string,
  transition: FlowStatusTransition,
): Promise<Flow> {
  const written = await store.updateFlowStatus(flowId, transition, []);
  if (!written.applied) throw new Error(`seedFlowStatus: no se aplicó sobre ${flowId}`);
  return written.flow;
}
