#!/usr/bin/env tsx
/**
 * Obtiene la credencial `authorized_user` para el doc store google-drive en "Mi unidad"
 * (settings.rootFolderId), con el login de la cuenta dueña de los documentos.
 *
 * Usage:
 *   GOOGLE_DRIVE_CLIENT_ID=... GOOGLE_DRIVE_CLIENT_SECRET=... \
 *     pnpm --filter @sdlc/server drive:auth <archivo-de-salida.json>
 *
 * El client OAuth tiene que ser de tipo "Desktop app": acepta el redirect a
 * http://127.0.0.1:<puerto> que levanta este script, sin registrarlo.
 *
 * Scope `drive.file`: el server sólo ve lo que él mismo creó, no el resto del Drive de la
 * cuenta. Es un scope no sensible, así que la app no necesita verificación de Google y el
 * refresh token no vence a los 7 días (eso pasa con scopes sensibles en modo "Testing").
 * Consecuencia: `rootFolderId` tiene que ser `root` o una carpeta creada por el server.
 *
 * El archivo de salida es un secreto (tiene el refresh token): se escribe con modo 0600.
 */
import { createServer } from 'node:http';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { google } from 'googleapis';

const SCOPE = 'https://www.googleapis.com/auth/drive.file';

const clientId = process.env.GOOGLE_DRIVE_CLIENT_ID;
const clientSecret = process.env.GOOGLE_DRIVE_CLIENT_SECRET;
const outArg = process.argv[2];
if (!clientId || !clientSecret || !outArg) {
  console.error(
    'Usage: GOOGLE_DRIVE_CLIENT_ID=... GOOGLE_DRIVE_CLIENT_SECRET=... ' +
      'pnpm --filter @sdlc/server drive:auth <archivo-de-salida.json>',
  );
  process.exit(1);
}
// Mismo criterio que seed-integrations: el path es relativo a donde se invocó pnpm.
const outPath = resolve(process.env.INIT_CWD ?? process.cwd(), outArg);

const server = createServer();
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const redirectUri = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const oauth = new google.auth.OAuth2(clientId, clientSecret, redirectUri);

const code = await new Promise<string>((done, fail) => {
  server.on('request', (req, res) => {
    const url = new URL(req.url ?? '/', redirectUri);
    const error = url.searchParams.get('error');
    const got = url.searchParams.get('code');
    if (!error && !got) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(error ? `Error: ${error}. Volvé a la terminal.` : 'Listo. Podés cerrar esta pestaña.');
    if (error) fail(new Error(`Google devolvió ${error}`));
    else done(got!);
  });
  // prompt=consent: sin él, una cuenta que ya autorizó al client no recibe refresh_token.
  const authUrl = oauth.generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: [SCOPE] });
  console.log(`Abrí esta URL y elegí la cuenta dueña de los documentos:\n\n${authUrl}\n`);
});
server.close();

const { tokens } = await oauth.getToken(code);
if (!tokens.refresh_token) {
  console.error('Google no devolvió refresh_token. Revocá el acceso en myaccount.google.com/permissions y reintentá.');
  process.exit(1);
}

const credentials = {
  type: 'authorized_user',
  client_id: clientId,
  client_secret: clientSecret,
  refresh_token: tokens.refresh_token,
};
await writeFile(outPath, JSON.stringify(credentials) + '\n', { mode: 0o600 });
console.log(`Credencial escrita en ${outPath} (0600). No la commitees.`);
