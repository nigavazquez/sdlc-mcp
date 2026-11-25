/** Workspaces de la persona, desde `whoami` (la debug surface `POST /mcp/tools/:name`). */
export async function listWorkspaces(serverUrl: string, token: string): Promise<string[]> {
  const res = await fetch(`${serverUrl}/mcp/tools/whoami`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: '{}',
  });
  const body = (await res.json().catch(() => undefined)) as
    | { ok?: boolean; error?: string; data?: { self_signoff?: Record<string, boolean> } }
    | undefined;
  if (!res.ok || !body?.ok)
    throw new Error(`whoami falló (${res.status}): ${body?.error ?? 'sin detalle'}`);
  // `self_signoff` tiene una clave por cada workspace del token.
  return Object.keys(body.data?.self_signoff ?? {}).sort();
}
