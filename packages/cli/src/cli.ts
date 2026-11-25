import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { DEFAULT_SERVER, runInit, type Prompter } from './init/init.js';
import { terminalPrompter } from './init/prompter.js';
import { listWorkspaces } from './init/whoami.js';
import { login } from './login.js';

const USAGE = `Uso: sdlc <comando>

Comandos:
  login [--server URL]   Inicia sesión en el server sdlc (default ${DEFAULT_SERVER})
  init                   Habilita el SDLC obligatorio en este repo (interactivo)
         [--server URL] [--workspace W] [--exclude a,b] [--yes]
`;

/** Abre la URL con el navegador del sistema. Si falla, el login ya imprimió la URL. */
async function openBrowser(url: string): Promise<void> {
  const cmd =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
  try {
    spawn(cmd, [url], { stdio: 'ignore', detached: true })
      .on('error', () => {})
      .unref();
  } catch {
    // Sin navegador (SSH, contenedor): queda la URL impresa.
  }
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}

const log = (line: string) => process.stdout.write(`${line}\n`);

/** El gate viaja al lado del CLI (`dist/gate.mjs`) tanto en el monorepo como en npm. */
function bundledGate(): string {
  return readFileSync(new URL('./gate.mjs', import.meta.url), 'utf8');
}

/** Con todo por flag no se pregunta nada; si igual hiciera falta, es un error. */
const noPrompts: Prompter = {
  ask: async (q) => {
    throw new Error(`falta un flag para: ${q}`);
  },
  confirm: async () => true,
};

export async function main(argv: string[]): Promise<number> {
  const [command, ...args] = argv;
  if (command === 'init') {
    const exclude = flag(args, '--exclude');
    const flags = {
      ...(flag(args, '--server') ? { server: flag(args, '--server')! } : {}),
      ...(flag(args, '--workspace') ? { workspace: flag(args, '--workspace')! } : {}),
      ...(exclude !== undefined
        ? {
            exclude: exclude
              .split(',')
              .map((e) => e.trim())
              .filter(Boolean),
          }
        : {}),
      ...(args.includes('--yes') ? { yes: true } : {}),
    };
    const unattended = flags.server && flags.workspace && flags.exclude && flags.yes;
    const result = await runInit({
      cwd: process.cwd(),
      prompter: unattended ? noPrompts : terminalPrompter(),
      log,
      gateSource: bundledGate(),
      login: (serverUrl) => login({ serverUrl, openBrowser, log }),
      listWorkspaces,
      flags,
    });
    return result.applied ? 0 : 1;
  }
  if (command === 'login') {
    await login({
      serverUrl: flag(args, '--server') ?? DEFAULT_SERVER,
      openBrowser,
      log,
    });
    return 0;
  }
  process.stderr.write(USAGE);
  return command === undefined || command === '--help' ? 0 : 1;
}

// exitCode y no process.exit(): en macOS stdout/stderr hacia un pipe son asíncronos y
// process.exit() corta la salida antes de que se escriba.
main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    process.stderr.write(`sdlc: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  },
);
