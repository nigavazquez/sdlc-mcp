import { getAccessToken, LoginRequiredError } from '../token.js';

/** Timeout de cada llamada del gate al server (RFC: 1,5 s → deny con salida por bypass). */
export const GATE_TIMEOUT_MS = 1500;

export type CheckResponse =
  | { valid: true; kind: 'story' | 'bypass'; story_id?: string; valid_until: string }
  | { valid: false; reason: string; next_step: string };

export interface GateEvent {
  kind: 'commit.allowed' | 'commit.blocked' | 'edit.blocked';
  branch?: string;
  lease_id?: string;
  reason?: string;
  detail?: Record<string, unknown>;
  at: string;
}

/** Lo que el gate necesita del server; los tests lo reemplazan o apuntan a un server falso. */
export interface GateServer {
  check(req: {
    workspace: string;
    lease_id: string;
    repo: string;
    branch: string;
    worktree: string;
  }): Promise<CheckResponse>;
  events(req: { workspace: string; repo: string; events: GateEvent[] }): Promise<void>;
}

/** Server caído, lento o respondiendo algo que no se entiende. */
export class ServerUnavailableError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = 'ServerUnavailableError';
  }
}

export { LoginRequiredError };

export function httpGateServer(serverUrl: string, timeoutMs = GATE_TIMEOUT_MS): GateServer {
  const base = serverUrl.replace(/\/+$/, '');

  async function post<T>(path: string, body: unknown): Promise<T> {
    const signal = AbortSignal.timeout(timeoutMs);
    // El token también cuenta para el timeout: una renovación colgada no puede trabar la edición.
    const token = await withTimeout(getAccessToken(serverUrl), timeoutMs);
    let res: Response;
    try {
      res = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      throw new ServerUnavailableError(`sin respuesta de ${base} (${(err as Error).name})`);
    }
    if (res.status === 401) throw new LoginRequiredError(serverUrl, 'el server rechazó el token');
    const json = (await res.json().catch(() => undefined)) as
      | { ok?: boolean; data?: T; error?: string }
      | undefined;
    if (!res.ok || !json?.ok) {
      throw new ServerUnavailableError(
        `el server respondió ${res.status}: ${json?.error ?? 'sin detalle'}`,
      );
    }
    return json.data as T;
  }

  return {
    check: (req) => post<CheckResponse>('/gate/v1/check', req),
    events: async (req) => {
      await post<unknown>('/gate/v1/events', req);
    },
  };
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new ServerUnavailableError('el login con el server tardó demasiado')),
      ms,
    );
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
