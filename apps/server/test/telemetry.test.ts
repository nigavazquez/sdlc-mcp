import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { z } from 'zod';
import { trace } from '@opentelemetry/api';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { instrumentRegistry, resolveTelemetryConfig, startTelemetry } from '../src/telemetry/tracing.js';
import type { ToolDef, ToolRegistry } from '../src/mcp/tools/index.js';
import { testCtx } from './helpers/tenant-ctx.js';

/**
 * Seam: el `ToolRegistry` (entra un registry, sale un registry con el mismo contrato) y
 * las spans que salen por la API global de OTEL. Nada de mirar el wrapper por dentro: lo
 * que importa es qué span se emite, con qué atributos, y —sobre todo— qué **no** viaja.
 */

const SECRETO = 'contenido-del-prd-que-no-tiene-que-viajar';

function fakeRegistry(handler: (input: unknown, ctx: unknown) => Promise<unknown>): ToolRegistry {
  const tool = {
    name: 'submit_prd',
    description: 'fake',
    inputSchema: z.object({}).passthrough(),
    handler,
  } as unknown as ToolDef;
  return { list: () => [tool], get: (name) => (name === 'submit_prd' ? tool : undefined) };
}

let provider: BasicTracerProvider | undefined;

function recordSpans(): InMemorySpanExporter {
  const exporter = new InMemorySpanExporter();
  provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  trace.setGlobalTracerProvider(provider);
  return exporter;
}

afterEach(async () => {
  await provider?.shutdown();
  provider = undefined;
  trace.disable();
});

/** Todo lo que la span lleva escrito, aplanado, para buscar fugas de contenido. */
function dump(span: ReadableSpan): string {
  return JSON.stringify({
    name: span.name,
    attributes: span.attributes,
    status: span.status,
    events: span.events,
  });
}

describe('instrumentRegistry — una span por tool call', () => {
  it('abre una span con el nombre de la tool', async () => {
    const exporter = recordSpans();
    const registry = instrumentRegistry(fakeRegistry(async () => ({ ok: true })), { enabled: true });

    await registry.get('submit_prd')!.handler({}, testCtx());

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0]!.name).toBe('mcp.tool submit_prd');
    expect(spans[0]!.attributes['mcp.tool.name']).toBe('submit_prd');
  });

  it('lleva tenant, workspace y flow como atributos', async () => {
    const exporter = recordSpans();
    const registry = instrumentRegistry(fakeRegistry(async () => ({ ok: true })), { enabled: true });

    await registry
      .get('submit_prd')!
      .handler({ flow_id: 'default:pagos:checkout-v2' }, testCtx({ tenantId: 'default' }));

    const attrs = exporter.getFinishedSpans()[0]!.attributes;
    expect(attrs['sdlc.tenant_id']).toBe('default');
    expect(attrs['sdlc.workspace_id']).toBe('pagos');
    expect(attrs['sdlc.flow_id']).toBe('default:pagos:checkout-v2');
  });

  it('cuando la tool todavía no tiene flow, el workspace sale del input (start_flow)', async () => {
    const exporter = recordSpans();
    const registry = instrumentRegistry(fakeRegistry(async () => ({ ok: true })), { enabled: true });

    await registry.get('submit_prd')!.handler({ project: 'pagos' }, testCtx());

    const attrs = exporter.getFinishedSpans()[0]!.attributes;
    expect(attrs['sdlc.workspace_id']).toBe('pagos');
    expect(attrs['sdlc.flow_id']).toBeUndefined();
  });

  it('no manda contenido de artefactos ni el resto del input', async () => {
    const exporter = recordSpans();
    const registry = instrumentRegistry(
      fakeRegistry(async () => ({ ok: true, data: { markdown: SECRETO } })),
      { enabled: true },
    );

    await registry.get('submit_prd')!.handler(
      { flow_id: 'default:pagos:checkout-v2', markdown: SECRETO, evidence_url: `https://x/${SECRETO}` },
      testCtx(),
    );

    expect(dump(exporter.getFinishedSpans()[0]!)).not.toContain(SECRETO);
  });

  it('no manda la identidad del usuario: el eje es el tenant, no la persona', async () => {
    const exporter = recordSpans();
    const registry = instrumentRegistry(fakeRegistry(async () => ({ ok: true })), { enabled: true });

    await registry.get('submit_prd')!.handler({}, testCtx({ userId: 'ana@example.com' }));

    expect(dump(exporter.getFinishedSpans()[0]!)).not.toContain('ana@example.com');
  });

  it('un rechazo de negocio (ok:false) queda marcado sin copiar el mensaje', async () => {
    const exporter = recordSpans();
    const registry = instrumentRegistry(
      fakeRegistry(async () => ({ ok: false, error: `El PRD dice ${SECRETO}` })),
      { enabled: true },
    );

    await registry.get('submit_prd')!.handler({}, testCtx());

    const span = exporter.getFinishedSpans()[0]!;
    expect(span.attributes['mcp.tool.ok']).toBe(false);
    expect(dump(span)).not.toContain(SECRETO);
  });

  it('una excepción marca la span como error, con el tipo pero sin el mensaje', async () => {
    const exporter = recordSpans();
    const registry = instrumentRegistry(
      fakeRegistry(async () => {
        throw new TypeError(`explotó con ${SECRETO}`);
      }),
      { enabled: true },
    );

    await expect(registry.get('submit_prd')!.handler({}, testCtx())).rejects.toThrow(/explotó/);

    const span = exporter.getFinishedSpans()[0]!;
    expect(span.status.code).toBe(2); // SpanStatusCode.ERROR
    expect(span.attributes['error.type']).toBe('TypeError');
    expect(dump(span)).not.toContain(SECRETO);
  });

  it('devuelve el resultado de la tool tal cual: instrumentar no cambia el contrato', async () => {
    recordSpans();
    const registry = instrumentRegistry(
      fakeRegistry(async (input) => ({ ok: true, echo: input })),
      { enabled: true },
    );
    const res = await registry.get('submit_prd')!.handler({ a: 1 }, testCtx());
    expect(res).toEqual({ ok: true, echo: { a: 1 } });
    // Y la lista de tools sigue siendo la misma superficie.
    expect(registry.list().map((t) => t.name)).toEqual(['submit_prd']);
  });

  it('apagado no envuelve nada: devuelve el mismo registry', async () => {
    const exporter = recordSpans(); // hay provider, pero la instrumentación está apagada
    const original = fakeRegistry(async () => ({ ok: true }));
    const registry = instrumentRegistry(original, { enabled: false });

    expect(registry).toBe(original);
    await registry.get('submit_prd')!.handler({}, testCtx());
    expect(exporter.getFinishedSpans()).toHaveLength(0);
  });

  it('prendido pero sin provider registrado, las tools siguen funcionando', async () => {
    trace.disable();
    const registry = instrumentRegistry(fakeRegistry(async () => ({ ok: true })), { enabled: true });
    await expect(registry.get('submit_prd')!.handler({}, testCtx())).resolves.toEqual({ ok: true });
  });
});

describe('resolveTelemetryConfig', () => {
  it('apagado por default', () => {
    expect(resolveTelemetryConfig({}).enabled).toBe(false);
  });

  it('se prende con OTEL_TRACES_ENABLED y un endpoint', () => {
    const cfg = resolveTelemetryConfig({
      OTEL_TRACES_ENABLED: 'true',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318',
      OTEL_SERVICE_NAME: 'sdlc-mcp-prod',
    });
    expect(cfg.enabled).toBe(true);
    expect(cfg.endpoint).toBe('http://collector:4318');
    expect(cfg.serviceName).toBe('sdlc-mcp-prod');
  });

  it('prendido sin endpoint es un error de config, no un apagado silencioso', () => {
    expect(() => resolveTelemetryConfig({ OTEL_TRACES_ENABLED: 'true' })).toThrow(
      /OTEL_EXPORTER_OTLP_ENDPOINT/,
    );
  });

  it('un endpoint sin el flag no prende nada', () => {
    expect(
      resolveTelemetryConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318' }).enabled,
    ).toBe(false);
  });
});

describe('startTelemetry', () => {
  it('apagado no registra provider ni exporta', async () => {
    const handle = await startTelemetry(resolveTelemetryConfig({}));
    expect(handle.enabled).toBe(false);
    await handle.shutdown();
  });

  it('prendido exporta las spans al endpoint OTLP configurado', async () => {
    const bodies: string[] = [];
    const collector = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        bodies.push(`${req.url} ${raw}`);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
      });
    });
    await new Promise<void>((ok) => collector.listen(0, '127.0.0.1', ok));
    const port = (collector.address() as AddressInfo).port;

    const handle = await startTelemetry(
      resolveTelemetryConfig({
        OTEL_TRACES_ENABLED: 'true',
        OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${port}`,
      }),
    );
    expect(handle.enabled).toBe(true);

    try {
      const registry = instrumentRegistry(fakeRegistry(async () => ({ ok: true })), {
        enabled: true,
      });
      await registry
        .get('submit_prd')!
        .handler({ flow_id: 'default:pagos:checkout-v2', markdown: SECRETO }, testCtx());
      await handle.shutdown();
    } finally {
      await new Promise<void>((ok) => collector.close(() => ok()));
      trace.disable();
    }

    const payload = bodies.join('\n');
    expect(payload).toContain('/v1/traces');
    expect(payload).toContain('mcp.tool submit_prd');
    expect(payload).toContain('checkout-v2');
    expect(payload).not.toContain(SECRETO);
  });
});
