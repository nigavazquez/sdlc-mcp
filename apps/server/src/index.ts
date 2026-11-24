import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { Catalog } from '@sdlc/catalog';
import type { TenantCtx } from '@sdlc/adapters-contracts';
import { loadConfig } from './config.js';
import { AuthError, createOAuthBearerAuth } from './auth/oauth-bearer.js';
import {
  OidcIdentityProvider,
  createDirectoryStore,
  createOAuthStore,
  registerOAuthRoutes,
} from './oauth/index.js';
import { buildToolRegistry } from './mcp/tools/index.js';
import { describeTools } from './mcp/server.js';
import { createFlowStore } from './state/index.js';
import { createSecretResolver } from './secrets/index.js';
import { createIntegrationConfigStore } from './integrations/index.js';
import type { IntegrationConfigAdmin, IntegrationConfigStore } from './integrations/types.js';
import { createAdminStore } from './admin/index.js';
import { registerAdminRoutes } from './admin/routes.js';
import { registerRateLimit, resolveRateLimitConfig } from './http/rate-limit.js';
import { registerMcpTransport } from './http/mcp-transport.js';
import { instrumentRegistry, resolveTelemetryConfig, startTelemetry } from './telemetry/tracing.js';
import { loadFileConfig } from './config/file-config.js';
import { reconcileStructure } from './config/reconcile.js';
import { resolveLabels } from './config/labels.js';
import { resolveEffectiveConfig } from './config/resolve.js';
import { resolveConfigSecretRefs } from './config/secret-env.js';
import {
  InMemoryTaskSystemAdapter,
  ConfigBackedTaskSystemProvider,
  ConfigBackedDocStoreProvider,
  ConfigBackedPullRequestProvider,
  NoOpPullRequestAdapter,
} from './adapters/index.js';

async function main() {
  const envConfig = loadConfig();
  const secretResolver = createSecretResolver(envConfig.secretsBackend);
  // Las env vars sensibles pueden llegar como `aws-sm://…` en vez del valor: en la EC2
  // las resuelve el instance role y nunca se escriben en disco. Ver config/secret-env.ts.
  const { config, resolved: resolvedSecretFields } = await resolveConfigSecretRefs(
    envConfig,
    secretResolver,
  );
  const catalog = await Catalog.load(config.catalogRoot);
  const adminStoreHandle = createAdminStore({ databaseUrl: config.databaseUrl });
  const directoryHandle = createDirectoryStore({ databaseUrl: config.databaseUrl });
  const oauthStoreHandle = createOAuthStore({ databaseUrl: config.databaseUrl });

  // Sin OAUTH_SIGNING_SECRET los tokens no sobreviven reinicios (solo aceptable en dev).
  const signingSecret = config.oauthSigningSecret || randomBytes(32).toString('hex');

  // Config declarativa (sdlc.config.yaml). Se carga acá —antes del IdP— porque su
  // bloque `auth.oidc` puede definir el proveedor. El archivo gana sobre env.
  const fileCfg = loadFileConfig(config.sdlcConfigPath);
  const labels = resolveLabels(fileCfg);
  const effective = await resolveEffectiveConfig({ env: config, fileCfg, secretResolver });

  const idp = effective.oidc
    ? await OidcIdentityProvider.fromDiscovery({
        discoveryUrl: effective.oidc.discoveryUrl,
        clientId: effective.oidc.clientId,
        clientSecret: effective.oidc.clientSecret,
        scopes: effective.oidc.scopes,
      })
    : undefined;
  const authenticate = createOAuthBearerAuth(
    { signingSecret, publicUrl: config.publicUrl },
    secretResolver,
  );

  const app = Fastify({
    logger:
      process.env.NODE_ENV === 'production'
        ? { level: config.logLevel }
        : {
            level: config.logLevel,
            transport: { target: 'pino-pretty', options: { colorize: true } },
          },
  });

  // Contra qué catálogo corre este proceso. El sello cruza `catalog_version` con el
  // contenido en disco: sin esto, la versión que el server reporta (whoami, /health) es
  // un número que nadie verificó. Un catálogo propio vía CATALOG_ROOT puede no estar
  // sellado y eso no es un error; drift sí, y por eso se loguea distinto.
  const sealCheck = await catalog.verifySeal();
  app.log[sealCheck.status === 'ok' ? 'info' : sealCheck.status === 'unsealed' ? 'warn' : 'error'](
    {
      catalog_version: sealCheck.version,
      catalog_digest: sealCheck.digest,
      seal_status: sealCheck.status,
    },
    sealCheck.message,
  );

  // Rate limit del borde HTTP. Va antes que cualquier ruta para que cubra también
  // al 404 y a los estáticos del panel. Ver src/http/rate-limit.ts por el eje.
  const rateLimit = resolveRateLimitConfig(process.env);
  registerRateLimit(app, { config: rateLimit });
  app.log.info(
    { enabled: rateLimit.enabled, windowMs: rateLimit.windowMs, buckets: rateLimit.buckets },
    'rate limit configured',
  );

  const storeHandle = createFlowStore({ databaseUrl: config.databaseUrl, logger: app.log });
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
  // Traces de las tool calls. Apagado por default: prendido, envuelve el registry; apagado,
  // el registry pasa tal cual y el SDK de OTEL ni se importa. Ver src/telemetry/tracing.ts.
  const telemetry = await startTelemetry(resolveTelemetryConfig(process.env));
  app.log.info(
    { enabled: telemetry.enabled, endpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? null },
    'telemetry configured',
  );

  const registry = instrumentRegistry(
    buildToolRegistry({
      catalog,
      store: storeHandle.store,
      taskSystemProvider,
      docStoreProvider,
      pullRequestProvider,
      // Sin esto la ruta de publicación de documentos no se deriva del modelo.
      adminStore: adminStoreHandle.store,
      signoffLogger: app.log,
    }),
    { enabled: telemetry.enabled },
  );

  // El archivo gana sobre env, así que dejamos asentado de dónde salió cada valor:
  // sin esto, agregar un sdlc.config.yaml a un deploy existente cambia el auth en silencio.
  app.log.info(
    {
      sources: effective.sources,
      configPath: fileCfg ? config.sdlcConfigPath : null,
      // Sólo los nombres: un deploy que arranca sin la credencial esperada tiene que
      // notarse en el log, y el valor nunca puede aparecer ahí.
      secretRefsResolved: resolvedSecretFields,
    },
    'effective config resolved',
  );

  // ── Boot-time structure reconciliation ────────────────────────────────────
  // Only runs when a persistent store is in use (DATABASE_URL set). Skipped in
  // dev/demo/in-memory mode to avoid side-effects on ephemeral stores.
  if (config.databaseUrl) {
    if (fileCfg) {
      app.log.info({ path: config.sdlcConfigPath }, 'reconciling org structure from config');
      const result = await reconcileStructure(adminStoreHandle.store, fileCfg, app.log);
      app.log.info({ created: result.created, drift: result.drift }, 'reconcile complete');
    }
  }

  app.addHook('onClose', async () => {
    await telemetry.shutdown();
    await storeHandle.close();
    await integrationConfig.close();
    await adminStoreHandle.close();
    await directoryHandle.close();
    await oauthStoreHandle.close();
  });

  const adminSessionSecret = config.adminSessionSecret ?? randomBytes(32).toString('hex');
  const { adminEmails, allowedEmailDomains } = effective;

  registerOAuthRoutes(app, {
    oauthStore: oauthStoreHandle.store,
    directory: directoryHandle.store,
    idp,
    config: {
      publicUrl: config.publicUrl,
      tenantId: effective.tenantId,
      signingSecret,
      allowedEmailDomains,
      adminEmails,
      adminSessionSecret,
      secureCookies: process.env.NODE_ENV === 'production',
      labels,
    },
  });

  registerAdminRoutes(app, {
    adminStore: adminStoreHandle.store,
    flowStore: storeHandle.store,
    integrations: integrationConfig.store as IntegrationConfigStore & IntegrationConfigAdmin,
    directory: directoryHandle.store,
    tenantId: effective.tenantId,
    sessionSecret: adminSessionSecret,
    labels,
  });

  // SPA del panel: solo si el build existe (apps/admin/dist o ADMIN_UI_DIR).
  const adminUiDir =
    config.adminUiDir ?? resolvePath(dirname(fileURLToPath(import.meta.url)), '../../admin/dist');
  if (existsSync(adminUiDir)) {
    await app.register(fastifyStatic, { root: adminUiDir, prefix: '/admin/', decorateReply: false });
    // Fallback del router del SPA: GET /admin/* que no sea api ni archivo → index.html.
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && req.url.startsWith('/admin') && !req.url.startsWith('/admin/api')) {
        return reply.type('text/html').send(readFileSync(join(adminUiDir, 'index.html'), 'utf8'));
      }
      return reply.code(404).send({ ok: false, error: 'Not found' });
    });
    app.log.info({ adminUiDir }, 'admin UI enabled');
  }

  app.get('/health', async () => ({
    ok: true,
    catalog_version: catalog.version,
    store: storeHandle.kind,
  }));

  app.get('/.well-known/mcp', async () => ({
    server: { name: 'sdlc-mcp', version: '0.0.1' },
    transport: 'http',
    endpoint: '/mcp',
    auth: 'bearer',
    tools: describeTools(registry),
  }));

  // El transport MCP de verdad: lo que un cliente estándar usa (Claude Code, Desktop).
  registerMcpTransport(app, { registry, authenticate });

  // Superficie de debug: un tool call con curl, sin handshake ni JSON-RPC. Es lo que usan
  // los runbooks para verificar un deploy. No es un duplicado de `/mcp`: ver ARCHITECTURE.
  app.post('/mcp/tools/:name', async (req, reply) => {
    let ctx: TenantCtx;
    try {
      ctx = await authenticate(req);
    } catch (err) {
      if (err instanceof AuthError) {
        if (err.wwwAuthenticate) reply.header('www-authenticate', err.wwwAuthenticate);
        return reply.code(err.status).send({ ok: false, error: err.message });
      }
      throw err;
    }

    const { name } = req.params as { name: string };
    const tool = registry.get(name);
    if (!tool) {
      return reply.code(404).send({ ok: false, error: `Unknown tool: ${name}` });
    }

    const parsed = tool.inputSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ ok: false, error: 'Invalid input', issues: parsed.error.issues });
    }

    return tool.handler(parsed.data, ctx);
  });

  app.get('/mcp/tools', async () => ({ tools: describeTools(registry) }));

  await app.listen({ port: config.port, host: config.host });
  app.log.info(
    {
      port: config.port,
      catalog_version: catalog.version,
      tools: registry.list().length,
      store: storeHandle.kind,
    },
    'sdlc-mcp ready',
  );

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      app.log.info({ signal }, 'shutting down');
      app.close().catch((err) => {
        app.log.error({ err }, 'error during shutdown');
        process.exit(1);
      });
    });
  }
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
