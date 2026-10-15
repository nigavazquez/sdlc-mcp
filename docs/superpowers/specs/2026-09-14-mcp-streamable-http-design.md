# El transport Streamable HTTP del MCP — Design

**Fecha:** 2026-09-14
**Estado:** implementado (`apps/server/src/http/mcp-transport.ts`). Dos desvíos respecto de
lo escrito abajo, decididos al implementar:

- **El seam no es el app completo.** La ruta vive en `registerMcpTransport(app, deps)`, y los
  tests la montan sobre un Fastify pelado vía `inject()`. Entrar por `main()` no era posible
  sin el refactor que § Riesgos deja para otro diff; esto lo evita sin hacerlo.
- **`{ ok: false }` sale con `isError: true`.** Las guardas no tiran: devuelven un resultado.
  Sin marcarlo, un cliente MCP leía el rechazo como éxito. El cambio vive en `buildMcpServer`,
  así que también corrige stdio.

Y una aclaración al § 3: el test de tokens en paralelo fija que el ctx **sobrevive** al
transport (mutar el `run` lo rompe), no que no se **comparta** entre requests — con `inject()`
los requests no se intercalan dentro del handler. Eso lo garantiza el ALS por construcción.

## Problema

El server anuncia un endpoint que no existe.

```js
// apps/server/src/index.ts
app.get('/.well-known/mcp', async () => ({
  server: { name: 'sdlc-mcp', version: '0.0.1' },
  transport: 'http',
  endpoint: '/mcp',     // ← 404
  auth: 'bearer',
  tools: describeTools(registry),
}));
```

Lo único que existe es `POST /mcp/tools/:name`, un JSON-over-HTTP mínimo con un comentario
al lado que dice que el transport del SDK "se cablea en Fase 1". Vamos por la Fase 5.

No es una inconsistencia de documentación: es el **discovery del propio server** mandando a
sus clientes a un 404. Un cliente MCP estándar —Claude Code, Claude Desktop, cualquiera que
siga el spec— no puede conectarse. `CONNECTING_CLIENTS.md` § B y `runbook-google-sso.md` § 4
documentan `https://<dominio>/mcp` como la URL a configurar, así que la instrucción escrita
tampoco funciona.

Hasta ahora eso costaba poco, porque no había dónde conectarse: el server corría local y por
stdio. Con el deploy de la Fase 4 mergeado, la primera persona que siga el runbook hasta el
final y apunte un cliente al dominio se come el 404. **Es la única promesa del deploy que el
server todavía no cumple.**

### Lo que ya está puesto y no se usa

El trabajo grande está hecho, y eso condiciona el diseño entero:

- **`buildMcpServer()`** (`src/mcp/server.ts`) ya construye un `McpServer` del SDK y le
  registra las tools del registry, con su `inputSchema` de zod. Hoy lo usa **sólo stdio**.
- **`authenticate(req)`** ya resuelve el `TenantCtx` desde el Bearer y devuelve el 401 con
  `WWW-Authenticate` que el flujo OAuth 2.1 necesita.
- **`ctxStorage`**, un `AsyncLocalStorage<TenantCtx>`, ya existe en `index.ts` y ya envuelve
  las llamadas del endpoint viejo.
- El SDK instalado es **1.29.0**, que trae `StreamableHTTPServerTransport`.

No falta construir el server MCP. Falta **montarlo sobre HTTP**.

## Objetivo

Que `POST /mcp` hable el protocolo MCP de verdad, autenticado con el mismo Bearer que ya
usa el resto del server, de modo que un cliente MCP estándar apuntado al dominio del deploy
liste las tools y las ejecute.

## No-goals

- **Sesiones y stream server→cliente.** Modo stateless (ver Diseño §2). Sin `Mcp-Session-Id`,
  sin GET SSE, sin notificaciones ni progreso.
- **Sacar `POST /mcp/tools/:name`.** Queda, y pasa a estar documentado como lo que es: la
  superficie curl-eable para verificar un deploy y debuggear una tool (ver §5).
- **Arreglar el resto de `CONNECTING_CLIENTS` § B**, que además sigue documentando API keys
  que ya no existen. Se anota; es otro PR.
- **Tocar el rate limit.** `bucketFor` hace `startsWith('/mcp')`: el endpoint nuevo ya cae en
  el bucket `mcp` sin cambiar una línea.

## Diseño

### 1. Dónde se monta, y por qué ahí

`POST /mcp`, en el mismo Fastify que ya sirve el panel, el OAuth y el endpoint viejo. El
transport del SDK se maneja con los objetos de node (`req.raw` / `reply.raw`), que Fastify
expone nativamente:

```ts
const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
const server = buildMcpServer({ registry, resolveCtx });
await server.connect(transport);
await ctxStorage.run(ctx, () => transport.handleRequest(req.raw, reply.raw, req.body));
```

Se evaluaron dos alternativas y se descartan por escrito, porque las dos vuelven solas en el
próximo review:

- **`webStandardStreamableHttp`** (Request/Response web) tiene fronteras más limpias y se
  testea sin levantar server. Pero Fastify es node-streams: habría que convertir en las dos
  direcciones, y esa conversión es **código nuestro** en el borde que menos queremos frágil.
  Cambiar un bug del SDK por un bug propio no es un avance.
- **Un Express embebido** sólo para `/mcp`, aprovechando los helpers del SDK: dos frameworks
  HTTP en el mismo proceso para ahorrar treinta líneas.

### 2. Stateless, y qué cede

`sessionIdGenerator: undefined`: un transport efímero por request, sin estado entre llamadas.
`GET /mcp` y `DELETE /mcp` contestan 405 — en stateless no hay stream que abrir ni sesión que
borrar, y un 404 ahí haría pensar que el endpoint no existe.

Encaja con lo que somos: las 28 tools son todas request/response, ninguna notifica ni streamea
progreso. Y sobrevive a un reinicio sin que el cliente note nada, que con un deploy de una sola
instancia y `restart: unless-stopped` no es teórico.

**Lo que cede:** el server no puede iniciar nada hacia el cliente. El día que una tool larga
quiera reportar progreso —`sync_backlog` contra un backlog grande es el candidato— hay que
volver acá, y ese cambio trae sesiones en memoria por proceso, que a su vez traen sticky
routing si alguna vez hay dos réplicas. Es una puerta que queda cerrada a propósito y con la
llave a la vista.

### 3. El ctx, que es donde está el riesgo

`buildMcpServer` recibe un `resolveCtx: () => TenantCtx` y lo llama **dentro** del handler de
cada tool. En HTTP eso significa leer del `AsyncLocalStorage` que el preHandler dejó cargado.

Todo el diseño se apoya en que ese contexto **sobreviva los awaits internos del transport**.
Si el SDK ejecuta el handler fuera del `run` —otro tick, un `queueMicrotask`, un stream que
se procesa después—, `resolveCtx()` devuelve `undefined` y toda tool falla. El modo de falla
peor no es ése: es que bajo concurrencia un request tome el ctx de otro, que no se ve en
ningún test secuencial y es una fuga de datos entre workspaces.

Por eso el **primer** test es `tools/call` de `whoami` con **dos tokens distintos en paralelo**,
verificando que cada respuesta trae su propia identidad. Si el ALS no sostiene, el diseño
cambia ahí mismo: `buildMcpServer` pasa a recibir el ctx explícito por llamada en vez de leerlo
del almacenamiento ambiente. Esa variante es más fea —obliga a construir el `McpServer` por
request, no sólo el transport— pero es correcta por construcción, y es la que gana si el test
falla.

### 4. Auth: la misma que ya hay

El preHandler llama a `authenticate(req)` y devuelve el mismo 401 con `WWW-Authenticate` que
hoy devuelve `/mcp/tools/:name`. No hay camino de auth nuevo: el `.well-known/oauth-*` y el
flujo OAuth 2.1 que ya funcionan para el endpoint viejo sirven igual, que es justamente lo que
un cliente MCP estándar espera encontrar cuando recibe el 401.

El orden importa: **autenticar antes de instanciar nada**. Un request sin token no debe llegar
a construir un transport ni un `McpServer`.

### 5. El endpoint viejo queda, con un rol escrito

`POST /mcp/tools/:name` no se toca ni se deprecia. Pasa a estar documentado como **la
superficie de debug**: un tool call con `curl`, sin handshake ni JSON-RPC, que es lo que usan
los dos runbooks para verificar un deploy y lo que uno quiere a mano cuando algo falla a las
tres de la mañana. Hacer eso mismo contra un transport MCP real requiere un cliente.

Son dos superficies con dos razones distintas de existir, y así queda dicho en ARCHITECTURE
para que la próxima persona no las lea como duplicación y borre la que no entiende.

### 6. Lo que no se toca, verificado

- **OTEL**: las spans salen igual. El `McpServer` llama a los `tool.handler` del registry, y el
  registry que recibe ya viene envuelto por `instrumentRegistry`.
- **Rate limit**: `bucketFor` hace `startsWith('/mcp')` → el endpoint nuevo cae en el bucket
  `mcp` (240/min) sin tocar nada.
- **stdio**: sigue usando `buildMcpServer` igual que hoy. El transport nuevo es un consumidor
  más del mismo constructor.

## Manejo de errores

| Situación | Respuesta |
|---|---|
| Sin `Authorization`, o token inválido | 401 + `WWW-Authenticate`, antes de instanciar el transport |
| `GET /mcp` / `DELETE /mcp` | 405 con cuerpo JSON-RPC que dice que el server es stateless |
| Tool rechazada por rol o por guarda de negocio | Error **JSON-RPC**, no 500: es una respuesta válida del protocolo |
| Input que no pasa el schema zod | Error JSON-RPC de validación, con el detalle que ya arma el schema |
| El request excede el rate limit | 429 + `Retry-After`, por el hook que ya existe |

La distinción que importa es la tercera: una tool que dice "no" es el protocolo funcionando.
Un 500 ahí haría que el cliente reintente algo que nunca va a andar.

## Testing

**El seam es el borde HTTP**, vía `app.inject()`. No se testea el transport por dentro, ni el
`McpServer`, ni `buildMcpServer` —ya está cubierto por los tests de stdio—: entra un request
HTTP, sale una respuesta HTTP, y en el medio está todo lo que el cliente va a ejercitar.

| Caso | Qué fija |
|---|---|
| `whoami` con **dos tokens en paralelo** | Que el ALS sostiene el ctx bajo concurrencia — se escribe **primero** |
| `initialize` | protocolVersion y `capabilities.tools` |
| `tools/list` | Las 28 tools con su JSON Schema |
| `tools/call` de `whoami` | El ctx del token, de punta a punta |
| Sin `Authorization` | 401 con `WWW-Authenticate` |
| `GET /mcp` | 405 |
| Tool rechazada por rol | Error JSON-RPC, no 500 |

## Riesgos

**El ALS bajo concurrencia** (§3) es el único riesgo de diseño, y tiene su test como primer
paso y su plan B escrito.

**El rango del SDK.** `package.json` declara `^1.0.4` y el lockfile tiene 1.29.0. Hasta hoy
daba igual; a partir de este cambio dependemos de APIs que en 1.0.4 no existían. Sube a
`^1.29.0` en este mismo diff: un `pnpm install` en una máquina limpia que resolviera 1.0.x
fallaría en el build, no en los tests, y el mensaje no diría por qué.

**La deuda que este cambio hace visible.** `main()` en `index.ts` son ~200 líneas sin seam, lo
que obliga a que estos tests entren por `inject()` contra el app completo. No se arregla acá
—es un refactor y el refactor va en su propio diff— pero cada feature nueva del borde HTTP lo
paga.

## Documentación

- `ARCHITECTURE.md`: la superficie MCP (las dos, con su rol), y el roadmap.
- `CONNECTING_CLIENTS.md` § B: la URL pasa a ser cierta. Se anota, sin arreglar, que la sección
  sigue documentando API keys que ya no existen.
- `runbook-deploy-prod.md`: la verificación suma un cliente MCP real y **mantiene** el `curl`.
- `runbook-google-sso.md` § 4: misma corrección de URL.
