#!/usr/bin/env node
//
// examples/lib/mint-token.mjs
//
// Firma un access token HS256 equivalente al que emite /oauth/token del server
// (mismo formato que `signJwt` en apps/server/src/oauth/crypto.ts), para que los
// ejemplos hablen con /mcp sin pasar por el login OIDC.
//
// Sólo sirve contra un server cuyo OAUTH_SIGNING_SECRET conocés: es una
// herramienta de desarrollo local, nunca para un deploy compartido.
//
// Uso:
//   node mint-token.mjs --secret <s> --iss <PUBLIC_URL> --sub <user> \
//     --tenant <tenant> --roles pm,tech-lead --workspaces ws1,ws2 [--ttl 3600]
//
// Cada workspace de --workspaces recibe los mismos --roles. Imprime el token en
// stdout, sin newline.
//
import { createHmac } from 'node:crypto';
import { parseArgs } from 'node:util';

export function mintToken({ secret, iss, sub, tenant, roles, workspaces, ttl = 3600, now = Date.now() }) {
  if (!secret) throw new Error('mintToken: falta secret');
  if (!iss) throw new Error('mintToken: falta iss (el PUBLIC_URL del server)');
  if (!sub) throw new Error('mintToken: falta sub');
  if (!roles?.length) throw new Error('mintToken: falta al menos un rol');
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const iat = Math.floor(now / 1000);
  const head = b64({ alg: 'HS256', typ: 'JWT' });
  const body = b64({
    iss,
    aud: 'sdlc-mcp',
    sub,
    tenant_id: tenant ?? 'default',
    roles,
    workspaces: Object.fromEntries((workspaces ?? []).map((w) => [w, roles])),
    iat,
    exp: iat + ttl,
  });
  const sig = createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}

const csv = (v) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values } = parseArgs({
    options: {
      secret: { type: 'string' },
      iss: { type: 'string' },
      sub: { type: 'string' },
      tenant: { type: 'string', default: 'default' },
      roles: { type: 'string' },
      workspaces: { type: 'string' },
      ttl: { type: 'string', default: '3600' },
    },
  });
  try {
    process.stdout.write(
      mintToken({
        secret: values.secret,
        iss: values.iss,
        sub: values.sub,
        tenant: values.tenant,
        roles: csv(values.roles),
        workspaces: csv(values.workspaces),
        ttl: Number(values.ttl),
      }),
    );
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
