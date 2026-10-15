import { SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import type { Attributes } from '@opentelemetry/api';
import type { TenantCtx } from '@sdlc/adapters-contracts';
import type { ToolDef, ToolRegistry } from '../mcp/tools/index.js';

/**
 * Traces de las llamadas MCP: una span por tool call.
 *
 * **Apagado por default y sin costo cuando lo está.** Lo único que este módulo carga
 * siempre es `@opentelemetry/api`, que sin un provider global registrado es un no-op. El
 * SDK y el exporter (que sí pesan) entran por `import()` dinámico dentro de
 * `startTelemetry`, así que un deploy sin observabilidad no los carga nunca. Y apagado,
 * `instrumentRegistry` devuelve el registry **tal cual**: no hay wrapper, no hay span
 * no-grabadora, no hay armado de atributos.
 *
 * **Qué se instrumenta:** el `ToolRegistry`. Es el punto por donde pasan las dos
 * superficies (HTTP y stdio) y el único que conoce a la vez el nombre de la tool, el
 * input y el `TenantCtx`. Instrumentar la ruta HTTP dejaría stdio afuera; instrumentar
 * cada tool a mano se olvidaría en la próxima.
 *
 * **Qué viaja y qué no.** Viaja lo que sirve para agrupar y comparar: tool, tenant,
 * workspace, flow, story, y si la llamada salió bien. No viaja **nada** del contenido:
 * ni el input, ni el resultado, ni el mensaje de error —un error de validación cita el
 * documento que valida—, ni la identidad de la persona. Un trace se exporta a un
 * colector de terceros: lo que no puede estar ahí no se pone, y los ids ya alcanzan para
 * volver al flow y mirar el evento en la base, que sí es nuestra.
 */

export interface TelemetryConfig {
  enabled: boolean;
  /** Base OTLP/HTTP (el exporter le agrega /v1/traces). Requerido si `enabled`. */
  endpoint?: string;
  serviceName: string;
}

export interface TelemetryHandle {
  enabled: boolean;
  /** Flushea y cierra el exporter. Seguro de llamar aunque esté apagado. */
  shutdown: () => Promise<void>;
}

const TRACER_NAME = 'sdlc-mcp';

/**
 * Lee la config del entorno. Apagado por default: la observabilidad se prende a
 * propósito, no por estar desplegado.
 *
 * `OTEL_TRACES_ENABLED=true` sin `OTEL_EXPORTER_OTLP_ENDPOINT` **rompe el arranque**:
 * prender traces y no exportarlos a ningún lado es un apagado silencioso, y el operador
 * que lo prendió va a creer que está mirando datos.
 */
export function resolveTelemetryConfig(env: Record<string, string | undefined>): TelemetryConfig {
  const raw = env.OTEL_TRACES_ENABLED?.trim().toLowerCase();
  const enabled = raw === 'true' || raw === '1';
  const serviceName = env.OTEL_SERVICE_NAME?.trim() || 'sdlc-mcp';
  if (!enabled) return { enabled: false, serviceName };

  const endpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  if (!endpoint) {
    throw new Error(
      'OTEL_TRACES_ENABLED está prendido pero falta OTEL_EXPORTER_OTLP_ENDPOINT: ' +
        'traces sin destino es peor que traces apagados, porque parece que están andando.',
    );
  }
  return { enabled: true, endpoint, serviceName };
}

/**
 * Registra el provider global de OTEL. Apagado, no importa una sola línea del SDK.
 */
export async function startTelemetry(config: TelemetryConfig): Promise<TelemetryHandle> {
  if (!config.enabled) return { enabled: false, shutdown: async () => {} };

  const [{ BasicTracerProvider, BatchSpanProcessor }, { OTLPTraceExporter }, { resourceFromAttributes }] =
    await Promise.all([
      import('@opentelemetry/sdk-trace-base'),
      import('@opentelemetry/exporter-trace-otlp-http'),
      import('@opentelemetry/resources'),
    ]);

  const exporter = new OTLPTraceExporter({ url: `${config.endpoint!.replace(/\/$/, '')}/v1/traces` });
  const provider = new BasicTracerProvider({
    resource: resourceFromAttributes({ 'service.name': config.serviceName }),
    spanProcessors: [new BatchSpanProcessor(exporter)],
  });
  trace.setGlobalTracerProvider(provider);

  return { enabled: true, shutdown: () => provider.shutdown() };
}

/**
 * Atributos de alcance de la llamada. Sólo identificadores — ver el comentario de arriba
 * sobre qué no viaja.
 *
 * El workspace sale del `flow_id` (`tenant:project:slug`, y `project` *es* el
 * workspace_id) y, cuando todavía no hay flow, del campo `project` del input, que es lo
 * que manda `start_flow`.
 */
function scopeAttributes(name: string, input: unknown, ctx: TenantCtx): Attributes {
  const attrs: Attributes = { 'mcp.tool.name': name, 'sdlc.tenant_id': ctx.tenantId };
  const fields = (input ?? {}) as Record<string, unknown>;

  const flowId = typeof fields.flow_id === 'string' ? fields.flow_id : undefined;
  const storyId = typeof fields.story_id === 'string' ? fields.story_id : undefined;
  if (flowId) attrs['sdlc.flow_id'] = flowId;
  if (storyId) attrs['sdlc.story_id'] = storyId;

  const workspace =
    (flowId ? flowId.split(':')[1] : undefined) ||
    (typeof fields.project === 'string' ? fields.project : undefined);
  if (workspace) attrs['sdlc.workspace_id'] = workspace;

  return attrs;
}

/**
 * Envuelve cada handler del registry en una span. Apagado devuelve el mismo registry:
 * la instrumentación no existe en el camino caliente de un deploy sin observabilidad.
 */
export function instrumentRegistry(registry: ToolRegistry, opts: { enabled: boolean }): ToolRegistry {
  if (!opts.enabled) return registry;

  const wrapped = new Map<string, ToolDef>();
  const wrap = (tool: ToolDef): ToolDef => {
    const already = wrapped.get(tool.name);
    if (already) return already;
    const instrumented: ToolDef = {
      ...tool,
      handler: (input, ctx) => {
        // El tracer se pide por llamada: así un provider registrado después del wrap
        // (o ninguno) funciona igual, sin capturar un no-op para siempre.
        const tracer = trace.getTracer(TRACER_NAME);
        return tracer.startActiveSpan(
          `mcp.tool ${tool.name}`,
          { kind: SpanKind.SERVER, attributes: scopeAttributes(tool.name, input, ctx) },
          async (span) => {
            try {
              const result = await tool.handler(input, ctx);
              // Las tools rechazan por negocio devolviendo `{ ok: false, error }`. El
              // hecho se marca; el mensaje no, porque suele citar el artefacto.
              const ok = !(
                result &&
                typeof result === 'object' &&
                'ok' in result &&
                (result as { ok: unknown }).ok === false
              );
              span.setAttribute('mcp.tool.ok', ok);
              span.setStatus({ code: SpanStatusCode.OK });
              return result;
            } catch (err) {
              // Sólo el tipo: el mensaje de una excepción puede traer el contenido que
              // la hizo fallar.
              span.setAttribute(
                'error.type',
                err instanceof Error ? err.constructor.name : typeof err,
              );
              span.setStatus({ code: SpanStatusCode.ERROR });
              throw err;
            } finally {
              span.end();
            }
          },
        );
      },
    };
    wrapped.set(tool.name, instrumented);
    return instrumented;
  };

  return {
    list: () => registry.list().map(wrap),
    get: (name) => {
      const tool = registry.get(name);
      return tool ? wrap(tool) : undefined;
    },
  };
}
