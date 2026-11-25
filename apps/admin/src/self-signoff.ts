/**
 * Toggle "QA y review propios" de un workspace (historia #22, épica #20).
 *
 * El panel muestra el valor nuevo apenas se hace click y lo guarda en el server. Si el
 * server falla, vuelve al valor anterior y devuelve el error para mostrarlo: el panel nunca
 * queda mostrando un valor que no se guardó.
 */
export interface ToggleOutcome {
  value: boolean;
  error: string | null;
}

export async function toggleSelfSignoff(
  previous: boolean,
  next: boolean,
  save: (value: boolean) => Promise<{ self_signoff: boolean }>,
  show: (value: boolean) => void,
): Promise<ToggleOutcome> {
  show(next);
  try {
    const saved = await save(next);
    show(saved.self_signoff);
    return { value: saved.self_signoff, error: null };
  } catch (err) {
    show(previous);
    return { value: previous, error: err instanceof Error && err.message ? err.message : 'error' };
  }
}

/** Un workspace sin el campo (server anterior a la migración 0015) vale el default: permitido. */
export function selfSignoffOf(ws: { self_signoff?: boolean }): boolean {
  return ws.self_signoff !== false;
}
