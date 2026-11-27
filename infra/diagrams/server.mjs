// Servicio de diagramas (historia #55): recibe el fuente mermaid y devuelve el PNG.
//
// Vive en su propio contenedor para que Chromium y mermaid-cli (~1,7 GB) no engorden la
// imagen del server. Sólo escucha en la red interna del compose y no tiene dependencias:
// node:http y el `mmdc` instalado en la imagen.
//
//   POST /render   body: texto mermaid (máx. 100 KB)  →  200 image/png | 422 | 413 | 504
//   GET  /health   →  200 { ok: true }
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = Number(process.env.PORT ?? 3100);
const MAX_BYTES = 100 * 1024;
const TIMEOUT_MS = Number(process.env.RENDER_TIMEOUT_MS ?? 15000);
// Ancho útil de la página de un Google Doc. El import de Drive pone la imagen a su tamaño en
// píxeles, así que se dibuja a ese ancho y a escala 1: a escala 2 sale el doble y se sale.
const WIDTH_PX = Number(process.env.RENDER_WIDTH_PX ?? 624);
// Un Chromium por vez: el contenedor tiene memoria acotada.
let queue = Promise.resolve();

function mmdc(args, env) {
  return new Promise((resolve, reject) => {
    execFile('mmdc', args, { timeout: TIMEOUT_MS, env }, (err, _out, stderr) => {
      if (err) {
        const e = new Error(err.killed ? 'timeout' : (stderr || err.message).trim().slice(0, 500));
        e.timeout = Boolean(err.killed);
        reject(e);
      } else resolve();
    });
  });
}

async function render(source) {
  const dir = await mkdtemp(join(tmpdir(), 'mermaid-'));
  try {
    await writeFile(join(dir, 'in.mmd'), source);
    await writeFile(join(dir, 'config.json'), JSON.stringify({ securityLevel: 'strict' }));
    await writeFile(
      join(dir, 'puppeteer.json'),
      JSON.stringify({
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
        // Sin red: un diagrama no tiene por qué pedir nada afuera.
        args: ['--no-sandbox', '--host-resolver-rules=MAP * ~NOTFOUND'],
      }),
    );
    await mmdc(
      ['-i', join(dir, 'in.mmd'), '-o', join(dir, 'out.png'), '-c', join(dir, 'config.json'),
        '-p', join(dir, 'puppeteer.json'), '-b', 'white', '-w', String(WIDTH_PX), '-s', '1', '-q'],
      // HOME en el temporal: el contenedor es read-only y Chromium escribe su perfil.
      { ...process.env, HOME: dir },
    );
    return await readFile(join(dir, 'out.png'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const server = createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
    return;
  }
  if (req.method !== 'POST' || req.url !== '/render') {
    res.writeHead(404).end();
    return;
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BYTES) {
      res.writeHead(413).end('diagrama demasiado grande');
      return;
    }
    chunks.push(chunk);
  }
  const job = queue.then(() => render(Buffer.concat(chunks).toString('utf8')));
  queue = job.catch(() => {});
  try {
    const png = await job;
    res.writeHead(200, { 'content-type': 'image/png' }).end(png);
  } catch (err) {
    res.writeHead(err.timeout ? 504 : 422, { 'content-type': 'text/plain' }).end(err.message);
  }
});

server.listen(PORT, '0.0.0.0', () => console.log(JSON.stringify({ evt: 'diagrams.listening', port: PORT })));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
