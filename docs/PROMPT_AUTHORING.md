# Authoring de prompts y skills

El catálogo (`packages/catalog/`) es el corazón del proyecto. Editarlo bien es la diferencia entre un agente útil y uno ruidoso.

Esta guía es para quien escribe la próxima entrada. Lo que se puede verificar sin leer el
contenido ya lo verifican los tests (ver [Lo que la suite ya chequea](#lo-que-la-suite-ya-chequea));
lo de acá es juicio, y el único lugar donde se aplica es el review del PR.

## Estructura

```
packages/catalog/
├── catalog.yaml                          Índice + semver por entrada + sello del contenido
├── roles/<role>/role.md                  System prompt base del rol
├── roles/<role>/phases/<phase>.md        Override específico para una fase
├── skills/<skill-id>.md                  Skill transversal reutilizable
└── templates/<template-id>.md            Plantilla de artefacto (PRD, RFC, …)
```

## Cómo se escribe para un agente

Cuatro reglas que valen para roles, fases y skills por igual.

### Nombrá la conducta buena, no prohibas la mala

Una prohibición mete en el contexto justamente lo que querías evitar: "no inventes datos"
deja "inventar datos" en la cabeza del agente. Escribí lo que sí tiene que hacer, con la
precisión suficiente para que la mala conducta no entre: *"los datos que aparecen son los que
alguien afirmó o los que vos leíste"*.

La excepción es una conducta concreta, frecuente y con nombre propio —`--no-verify`, "LGTM
sin leer el diff"—. Ahí nombrarla es más barato que describir su contrario, y se puede dejar.

### Cada paso dice cuándo está hecho

Un paso sin criterio de completitud invita a cerrarlo antes de tiempo. "Revisá el plan" no
termina nunca, o termina enseguida; *"revisá el plan: cada AC tiene al menos un caso, y los
EDGE que no aplican quedan como `passed` con `notes:"N/A"`"* termina en un lugar que se puede
verificar. Si el paso es una llamada, el criterio es lo que la respuesta tiene que traer para
seguir.

### Apuntá al material que no está cargado

El agente sólo tiene lo que le pasaron. Cuando un paso depende de algo que vive en otro
lado —una skill, una sección del RFC, el resultado de una tool—, nombralo como un puntero:
dónde está y qué sacar de ahí. *"Leé `skill-review-dos-ejes` antes de empezar: define cómo se
corren los dos ejes"* le dice qué abrir y para qué. *"Seguí las buenas prácticas de review"* no
le dice nada.

Las llamadas a tools son punteros también, y van con la forma canónica
`` `nombre({a, b?})` `` en una línea: así las cruza contra el registry
`apps/server/test/catalog-tool-calls.test.ts`. Escribí la firma que la tool acepta, no la que
parecería lógica.

### El test del no-op

Borrá una frase y preguntate si el agente se comportaría distinto sin ella. Si no, borrala
entera en vez de recortarla. "Sé claro y conciso", "asegurate de la calidad", "pensá paso a
paso" casi nunca cambian nada y ocupan el lugar de algo que sí.

## Reglas para system prompts

- **Empezá por la identidad del rol, no por instrucciones.** Quién es el agente, qué decide y qué le toca a otro.
- **Principios > checklists.** Un agente que entiende los principios maneja casos no previstos. Un agente con checklist falla en lo que no está listado.
- **Hand-off claro.** Cada fase termina diciendo dónde sigue el trabajo y de quién es: "la fase RFC es del Tech Lead, en otra sesión".
- **La secuencia de tools va también en el frontmatter** (`next_actions`), en orden. La prosa la explica; el frontmatter es lo que `get_role_prompt` devuelve.

## Reglas para skills

- Una skill = una capacidad cohesiva. No "skill-paymentstuff", sí "skill-idempotency-key".
- Las reglas no negociables van al inicio, escritas como la conducta que se espera.
- Si la skill aplica a un solo rol, vive en `roles/<role>/...`. Si es transversal, en `skills/`.

### La `description`

Es lo primero que el agente lee de una skill, y muchas veces lo único antes de decidir si
abrirla. Acá el server decide qué skills adjuntar por fase y escenario, así que la descripción
no gobierna la invocación; lo que hace es decirle al agente **por qué le adjuntaron este
documento y cuándo usarlo**, que en `developer.implement` —hasta cuatro skills de escenario
además de la base— es lo que le deja decidir en qué orden leerlas.

Una buena descripción dice cuándo aplica y qué cambia en la conducta: *"Cuando el RFC reusa
componentes existentes: cómo verificar que la integración no rompió los contratos que ya
consumían otros"*. Una que repite el título (*"Checklist de review de reuso"*) no hace ningún
trabajo.

## Reglas para templates

- El template es el formato del output, no el contenido. Placeholders `<...>`.
- Si requerís 3 ítems de algo, dejá 3 filas vacías; el agente las completará.
- Tablas para datos estructurados (métricas, riesgos), bullets para listas, prosa solo para context.

## Frontmatter

| Campo | Dónde | Qué es |
|---|---|---|
| `id` | roles, fases, skills | La clave con la que `catalog.yaml` indexa la entrada: `roles.<rol>`, `roles.<rol>.phases.<fase>` o el id de la skill |
| `version` | roles, fases, skills | La misma que declara `catalog.yaml` para esa entrada |
| `description` | skills | Ver [La `description`](#la-description) |
| `required_sections` / `conditional_sections` | fases con validador | Las secciones que el validador del server exige. Se cruzan contra él |
| `next_actions` | fases | La secuencia de tools de la fase, en orden: nombres o llamadas `nombre({a, b?})` |

Los templates **no** llevan frontmatter: `getTemplate` devuelve el archivo crudo y se filtraría
al artefacto. Su versión vive sólo en `catalog.yaml`.

## Versionado

Cada entrada (`role`, `phase`, `skill`, `template`) tiene su propio semver en `catalog.yaml`, y
el catálogo entero lleva `catalog_version`:

- **Patch** (0.1.0 → 0.1.1): typos, aclaraciones, una firma corregida.
- **Minor** (0.1.0 → 0.2.0): reglas o pasos nuevos, secciones agregadas; no rompe outputs previos.
- **Major** (0.1.0 → 1.0.0): cambios estructurales que rompen outputs previos (un `required_sections` distinto, un artefacto con otra forma).

## Workflow de cambios

El catálogo es un workspace del monorepo: se cambia con un PR a este repo, como cualquier código.

```bash
# 1. editar roles/, skills/, templates/
# 2. bumpear la versión de cada entrada tocada, en catalog.yaml y en su frontmatter
# 3. bumpear catalog_version en catalog.yaml
pnpm --filter @sdlc/catalog seal        # 4. reescribe el sello; se niega si no moviste catalog_version
pnpm --filter @sdlc/server test         # 5. la suite que cruza el catálogo contra el server
```

### Lo que la suite ya chequea

| Test | Qué da en rojo |
|---|---|
| `Catalog.load` (cualquier test que cargue el catálogo) | Un `id`, una `version` o una `description` de skill que no coinciden con `catalog.yaml`. El catálogo directamente no carga, y el error enumera todo lo que hay que corregir |
| `catalog-version.test.ts` | El sello no corresponde al contenido (tocaste algo y no reselaste) |
| `catalog-tool-calls.test.ts` | Una llamada a tool narrada con un nombre, argumento o valor que no existe, o sin un obligatorio |
| `required-sections-catalogo.test.ts` | `required_sections` de una fase distinto de lo que exige su validador |
| `catalog.smoke.test.ts` | Contenido con referencias a una organización concreta: el catálogo es genérico |

Lo que ninguno de esos puede medir —si una descripción hace trabajo, si un paso tiene criterio
de completitud, si una frase pasa el test del no-op— es lo que se mira en el review.
