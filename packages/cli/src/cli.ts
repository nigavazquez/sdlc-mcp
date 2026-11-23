import { spawn } from 'node:child_process';
import { login } from './login.js';

const DEFAULT_SERVER = 'http://localhost:3100';

const USAGE = `Uso: sdlc <comando>

Comandos:
  login [--server URL]   Inicia sesión en el server sdlc (default ${DEFAULT_SERVER})
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

export async function main(argv: string[]): Promise<number> {
  const [command, ...args] = argv;
  if (command === 'login') {
    await login({
      serverUrl: flag(args, '--server') ?? DEFAULT_SERVER,
      openBrowser,
      log: (line) => process.stdout.write(`${line}\n`),
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
