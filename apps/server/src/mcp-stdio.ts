import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Catalog } from '@sdlc/catalog';
import type { RoleId } from '@sdlc/core';
import { loadConfig } from './config.js';
import { buildToolRegistry } from './mcp/tools/index.js';
import { instrumentRegistry, resolveTelemetryConfig, startTelemetry } from './telemetry/tracing.js';
import { buildMcpServer } from './mcp/server.js';
import { createFlowStore } from './state/index.js';
import type { TenantCtx } from '@sdlc/adapters-contracts';
import { createSecretResolver } from './secrets/index.js';
import { createIntegrationConfigStore } from './integrations/index.js';
import {
  InMemoryTaskSystemAdapter,
  ConfigBackedTaskSystemProvider,
  ConfigBackedDocStoreProvider,
  ConfigBackedPullRequestProvider,
  NoOpPullRequestAdapter,
} from './adapters/index.js';

// MCP stdio transport usa stdout para el protocolo JSON-RPC.
// Todo logging debe ir a stderr para no corromper el canal.
const log = (...args: unknown[]) =>
  process.stderr.write('[sdlc-mcp] ' + args.join(' ') + '\n');

/** Opt-in explícito para dejar que stdio apunte a una base. Sólo "true" o "1". */
export const STDIO_DB_OPT_IN = 'SDLC_STDIO_ALLOW_DATABASE';

/**
 * Guarda de arranque del modo stdio, aplicada antes de abrir cualquier conexión.
 *
 * stdio **no autentica nada**: el `TenantCtx` sale entero de variables de entorno del
 * proceso (`SDLC_TENANT_ID`, `SDLC_USER_ID`, `SDLC_USER_ROLES`, `SDLC_WORKSPACES`), que
 * las pone quien lanza el proceso. Contra el store in-memory eso es aceptable —el estado
 * nace y muere con el proceso—; contra un Postgres compartido es acceso total a los datos
 * de todos los workspaces sin una sola credencial. Por eso: si hay `DATABASE_URL`, no
 * arranca salvo opt-in explícito.
 *
 * Devuelve el mensaje de rechazo, o `null` si puede arrancar.
 */
export function assertStdioBoot(env: NodeJS.ProcessEnv = process.env): string | null {
  const databaseUrl = env.DATABASE_URL?.trim();
  if (!databaseUrl) return null;
  const optIn = env[STDIO_DB_OPT_IN]?.trim().toLowerCase();
  if (optIn === 'true' || optIn === '1') return null;
  return (
    `stdio no arranca con DATABASE_URL seteado: este modo no autentica nada —la identidad ` +
    `(SDLC_TENANT_ID / SDLC_USER_ID / SDLC_USER_ROLES / SDLC_WORKSPACES) la pone quien lanza el ` +
    `proceso—, así que apuntarlo a una base compartida es acceso total sin credenciales.\n` +
    `Salidas:\n` +
    `  1. Modo local, el más simple: sacá DATABASE_URL del entorno del proceso (del bloque "env" ` +
    `de tu .mcp.json / claude_desktop_config.json, o del .env que estés cargando) y stdio corre ` +
    `contra el store in-memory. Ojo: el modo local no llega al final del ciclo — sin base no hay ` +
    `tenant_integrations, así que no hay pr_provider ni doc_store y request_code_review, ` +
    `submit_review_outcome y submit_adr fallan siempre. Sirve para PRD/RFC/backlog, no para cerrar ` +
    `una story.\n` +
    `  2. Base compartida con usuarios reales, y la única que cierra el ciclo: usá el transport HTTP ` +
    `con login OAuth (pnpm --filter @sdlc/server dev, y apuntá el cliente a <PUBLIC_URL>/mcp) en vez ` +
    `de stdio, y cargá pr_provider y doc_store en tenant_integrations.\n` +
    `  3. Base tuya de desarrollo y sabés lo que hacés: arrancá con ${STDIO_DB_OPT_IN}=true ` +
    `(usá una DB descartable, nunca la compartida).`
  );
}

/**
 * Aviso de alcance del modo local, escrito a stderr en el arranque.
 *
 * `assertStdioBoot` empuja al modo local (sin `DATABASE_URL`) como la salida
 * recomendada, pero el modo local **no llega al final del ciclo**, y callarlo
 * deja al usuario chocando contra un error que parece un bug:
 *
 *   sin `DATABASE_URL` → `createIntegrationConfigStore` devuelve el store
 *   in-memory → arranca vacío y nada lo puebla (el seed sólo escribe en
 *   Postgres) → `getPrProviderConfig` / `getDocStoreConfig` devuelven undefined
 *   → los providers caen al adapter no-op → `request_code_review`,
 *   `submit_review_outcome` y `submit_adr` rechazan el no-op y fallan siempre.
 *
 * Ese rechazo es correcto y no se toca: el no-op acepta cualquier URL sin
 * verificar nada, y dejarlo firmar el gate fabrica el PR/ADR fantasma que esta
 * tanda vino a eliminar. Lo que faltaba era que el modo local fuera honesto
 * sobre hasta dónde llega, y que nombre qué configurar para llegar al final —
 * la misma regla que el resto de los mensajes de error del repo.
 *
 * No inventamos un dry-run: un review simulado es exactamente el registro
 * fantasma que se está cerrando.
 *
 * Devuelve el aviso, o `null` si el modo no lo necesita (hay `DATABASE_URL`, o
 * sea integraciones configurables en `tenant_integrations`).
 */
export function stdioLocalModeNotice(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.DATABASE_URL?.trim()) return null;
  return (
    `modo local (store in-memory): el ciclo NO llega hasta el final. Sin DATABASE_URL el registro de ` +
    `integraciones arranca vacío y no hay dónde configurarlo, así que no hay pr_provider ni doc_store: ` +
    `request_code_review, submit_review_outcome y submit_adr rechazan el adapter no-op y van a fallar ` +
    `siempre (a propósito: el no-op no verifica nada y aprobaría un PR inexistente).\n` +
    `  Llega hasta acá: start_flow → submit_prd → submit_rfc → propose_breakdown → create_stories → ` +
    `claim_story → report_progress. La story queda en review y no se puede cerrar.\n` +
    `  Para cerrar el ciclo: usá el transport HTTP contra Postgres (pnpm --filter @sdlc/server dev, ` +
    `cliente a <PUBLIC_URL>/mcp) y cargá pr_provider (github | azure-devops-repos) y doc_store ` +
    `(google-drive) en tenant_integrations para tu workspace, desde el panel /admin o con ` +
    `pnpm --filter @sdlc/server seed:integrations.`
  );
}

/**
 * Workspaces del ctx de stdio. Sin este claim las tools de escritura rechazan todo
 * (`assertWorkspaceAccess` ya no falla abierto), así que se declara explícito por env.
 */
function stdioWorkspaces(roles: RoleId[]): Record<string, RoleId[]> {
  const ids = (process.env.SDLC_WORKSPACES ?? 'local')
    .split(',')
    .map((w) => w.trim())
    .filter(Boolean);
  return Object.fromEntries(ids.map((id) => [id, roles]));
}

async function main() {
  const denied = assertStdioBoot();
  if (denied) {
    process.stderr.write('[sdlc-mcp] ' + denied + '\n');
    process.exit(1);
  }

  const config = loadConfig();
  const catalog = await Catalog.load(config.catalogRoot);

  // logger omitido: campo opcional en CreateFlowStoreOptions;
  // stdout queda reservado para el protocolo MCP.
  const storeHandle = createFlowStore({ databaseUrl: config.databaseUrl });
  const secretResolver = createSecretResolver(config.secretsBackend);
  const integrationConfig = createIntegrationConfigStore({ databaseUrl: config.databaseUrl });
  const taskSystemProvider = new ConfigBackedTaskSystemProvider({
    configStore: integrationConfig.store,
    inMemory: new InMemoryTaskSystemAdapter(),
  });
  const docStoreProvider = new ConfigBackedDocStoreProvider({
    configStore: integrationConfig.store,
  });
  const pullRequestProvider = new ConfigBackedPullRequestProvider({
    configStore: integrationConfig.store,
    noOp: new NoOpPullRequestAdapter(),
  });
  // Mismo tracing que el transport HTTP: se instrumenta el registry, que es el punto por
  // donde pasan las dos superficies. Apagado por default (ver src/telemetry/tracing.ts).
  const telemetry = await startTelemetry(resolveTelemetryConfig(process.env));
  const registry = instrumentRegistry(
    buildToolRegistry({ catalog, store: storeHandle.store, taskSystemProvider, docStoreProvider, pullRequestProvider }),
    { enabled: telemetry.enabled },
  );

  const roles = (process.env.SDLC_USER_ROLES ?? 'developer')
    .split(',')
    .map((r) => r.trim()) as RoleId[];
  const workspaces = stdioWorkspaces(roles);
  const ctx: TenantCtx = {
    tenantId: process.env.SDLC_TENANT_ID ?? 'local',
    userId: process.env.SDLC_USER_ID ?? 'claude-user',
    roles,
    workspaces,
    resolveSecret: (ref: string) => secretResolver.resolve(ref),
  };

  const server = buildMcpServer({ registry, resolveCtx: () => ctx });
  const transport = new StdioServerTransport();

  process.on('SIGINT', () => void telemetry.shutdown().finally(() => process.exit(0)));
  process.on('SIGTERM', () => void telemetry.shutdown().finally(() => process.exit(0)));

  await server.connect(transport);
  log(`ready — ${registry.list().length} tools`);
  log(
    `store: ${config.databaseUrl ? 'postgres' : 'in-memory'} — ` +
      `workspaces del ctx: ${Object.keys(workspaces).join(', ') || '(ninguno)'} ` +
      `(cambialos con SDLC_WORKSPACES=<ids,separados,por,coma>)`,
  );

  // El aviso va después del "ready" para no parecer un error de arranque: el
  // server sí levantó, lo que está acotado es el alcance del ciclo.
  const notice = stdioLocalModeNotice();
  if (notice) log(notice);
}

/**
 * Sólo arranca cuando el módulo es el entrypoint del proceso. Así los tests pueden
 * importar `assertStdioBoot` sin levantar un servidor MCP.
 */
function isEntrypoint(): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntrypoint()) {
  main().catch((err) => {
    process.stderr.write('[sdlc-mcp] Fatal: ' + String(err) + '\n');
    process.exit(1);
  });
}
