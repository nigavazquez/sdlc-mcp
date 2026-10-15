# El repro antes del fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que toda nota de cambio declare `repro` o `no_repro` en su frontmatter, que eso quede en el evento `change_note.submitted`, y que una skill nueva guíe el diagnóstico en `change-note` e `implement` (esta última sólo para `fix`/`improvement`).

**Architecture:** Un piso mecánico en `validateChangeNote` (existencia, exclusividad, relleno, largo), la declaración parseada viaja al payload del evento sin migración, y un eje de escenario nuevo (`initiative_type`) en el catálogo adjunta la skill a `developer.implement` sin tocar a las features.

**Tech Stack:** TypeScript, zod, gray-matter, vitest, pnpm workspaces (`apps/server`, `packages/catalog`).

**Spec:** `docs/superpowers/specs/2026-09-28-repro-antes-del-fix-design.md`

## Global Constraints

- Exactamente una de dos claves en el frontmatter: `repro` o `no_repro`. Ausencia, ambas, no-string, relleno o placeholder `<...>` → **error**, no warning.
- Tope: **500 caracteres** después de `trim`.
- Relleno = `isPlaceholderText` (`apps/server/src/validation/qa-envelope.ts`); placeholder de template = `hasAngleBracketPlaceholder` (`apps/server/src/validation/markdown-sections.ts`, hoy privada, se exporta).
- La declaración se guarda en el payload de `change_note.submitted` como `repro: { kind, value }`. **Sin migración, sin columna.**
- Los errores se acumulan con los de secciones y repo: el autor recibe todo junto.
- Skill: `skill-repro-antes-del-fix`. Base en `developer.change-note`; en `developer.implement` sólo por el eje `initiative_type` (`fix`, `improvement`).
- Catálogo **0.12.0**, resellado con `pnpm --filter @sdlc/catalog seal`. Cada entrada tocada bumpea su versión en `catalog.yaml` **y** en su frontmatter (el loader lo exige).
- Idioma de mensajes, comentarios y commits: castellano rioplatense, como el resto del repo. Commits terminan con `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.

## Review Focus

1. **Un `repro` con `": "` sin comillas** (`-t "claim: bloqueada"`) rompe el YAML con "incomplete explicit mapping pair". Se espera que el error diga que el valor va entre comillas. → Task 1, test "el error de YAML sugiere comillas".
2. **Una clave casi correcta** (`no-repro`, `Repro`, `norepro`) hoy sería "falta la declaración", y el autor no entiende qué hizo mal. Se espera "¿quisiste decir `no_repro`?". → Task 1, test "una clave parecida".
3. **El borde del tope**: 500 caracteres pasa, 501 no. → Task 1, test "500 pasa, 501 no".
4. **Un flow sin `initiative_type`** (los creados antes de que existiera) no tiene que romper ni adjuntar la skill en `implement`. → Task 3, test "sin initiative_type".
5. **El template sin completar** se rechaza por `repro` además de por sus secciones: si el placeholder de `repro` pasara, el campo se llenaría solo. → Task 4, test "el template tal cual no valida".

---

## File Structure

| Archivo | Qué cambia |
|---|---|
| `apps/server/src/validation/markdown-sections.ts` | Exporta `hasAngleBracketPlaceholder` |
| `apps/server/src/validation/change-note.ts` | `ReproDeclaration`, `REPRO_MAX_LENGTH`, `reproDelFrontmatter`, pista de comillas en el error de YAML |
| `apps/server/test/helpers/change-note.ts` | **Nuevo.** La nota válida compartida (`NOTA_OK`) y `STORY_OK` |
| `apps/server/test/change-note-validation.test.ts` | Usa el helper; casos de `repro` |
| `apps/server/src/mcp/tools/submit-change-note.ts` | `repro` en el payload del evento |
| `apps/server/test/submit-change-note.test.ts` | Usa el helper; evento con `repro`; regex de "sin repo" |
| `apps/server/test/track-liviano-e2e.test.ts` | Usa el helper; `claim_story` trae la skill |
| `packages/catalog/src/index.ts` | Eje `initiative_type` en `ScenarioSkillMap`, `ScenarioContext`, `resolveSkillIds` |
| `apps/server/src/mcp/tools/story-component.ts` | `scenarioForStory` pasa `initiative_type` |
| `apps/server/src/mcp/tools/get-role-prompt.ts` | El escenario del flow pasa `initiative_type` |
| `apps/server/test/scenario-skills.test.ts` | Tests del eje nuevo contra un catálogo fixture y contra el real |
| `packages/catalog/skills/skill-repro-antes-del-fix.md` | **Nuevo.** La skill |
| `packages/catalog/catalog.yaml` | Skill nueva, base de `change-note`, `scenario_skills.developer.implement.initiative_type`, bumps, 0.12.0, sello |
| `packages/catalog/templates/change-note-template.md` | Clave `repro` en el frontmatter y línea en "Cómo lo sé" |
| `packages/catalog/roles/developer/phases/change-note.md` | Paso 2 suma la declaración y el puntero a la skill |
| `docs/superpowers/specs/2026-09-28-repro-antes-del-fix-design.md` | Estado → implementado; corrección de la cuenta de fixtures |
| `docs/superpowers/specs/2026-09-14-analisis-tanda-3-design.md` | Candidato 4 → implementado |

---

### Task 1: El piso mecánico en `validateChangeNote`

**Files:**
- Modify: `apps/server/src/validation/markdown-sections.ts:106` (exportar la función)
- Modify: `apps/server/src/validation/change-note.ts`
- Create: `apps/server/test/helpers/change-note.ts`
- Modify: `apps/server/test/change-note-validation.test.ts`

**Interfaces:**
- Produces:
  - `export interface ReproDeclaration { kind: 'repro' | 'no_repro'; value: string }` en `change-note.ts`
  - `export const REPRO_MAX_LENGTH = 500` en `change-note.ts`
  - `ChangeNoteValidation.repro?: ReproDeclaration`
  - `export function hasAngleBracketPlaceholder(body: string): boolean` en `markdown-sections.ts`
  - `export const NOTA_OK: string` y `export const STORY_OK` en `test/helpers/change-note.ts`

- [ ] **Step 1: Crear el helper con la nota compartida**

`apps/server/test/helpers/change-note.ts`:

```ts
/**
 * Una nota de cambio válida, compartida por los tests que necesitan una.
 *
 * Existe para que el próximo campo obligatorio de la nota se agregue en un lugar y no
 * en tres copias: `repro` tocó las tres.
 */
export const NOTA_OK = `---
repo: acme/sdlc-mcp
repro: 'pnpm --filter @sdlc/server test -- -t "refresh sin workspaces"'
---

# Fix: el claim de workspaces no llega en el refresh

## Qué pasa

Al refrescar el token, ctx.workspaces viene vacío y toda tool falla cerrado.

## Cómo lo sé

Repro en staging y el log sdlc-2026-09-01T10:22Z.

## Qué cambio

Propagar el claim en oauth/routes.ts al emitir el access token del refresh.

## Cómo se verifica

Test nuevo en oauth-refresh.test.ts y login manual contra staging.
`;

export const STORY_OK = {
  title: 'Propagar el claim workspaces en el refresh',
  description: 'El access token emitido por el refresh tiene que llevar el mismo claim que el del login.',
  acceptance_criteria: ['El token del refresh trae workspaces', 'Hay test que lo cubre'],
};

/** Reemplaza la declaración de repro del frontmatter de `NOTA_OK` por `lineas` (o la saca). */
export function conRepro(lineas: string): string {
  return NOTA_OK.replace(/^repro:.*\n/m, lineas ? `${lineas}\n` : '');
}
```

- [ ] **Step 2: Pasar `change-note-validation.test.ts` al helper y escribir los tests que fallan**

En `apps/server/test/change-note-validation.test.ts`, borrar la constante local `NOTA_OK` (líneas 9-29) e importar:

```ts
import { NOTA_OK, conRepro } from './helpers/change-note.js';
import { REPRO_MAX_LENGTH } from '../src/validation/change-note.js';
```

Agregar al final del archivo:

```ts
/** Los mensajes de error de la validación, para buscar el de repro. */
const errores = (markdown: string) =>
  validateChangeNote(markdown)
    .issues.filter((i) => i.severity === 'error')
    .map((i) => i.message);

describe('validateChangeNote — repro / no_repro', () => {
  it('una nota con repro valida y devuelve la declaración con trim', () => {
    const res = validateChangeNote(conRepro("repro: '  pnpm test -- -t refresh  '"));
    expect(res.ok).toBe(true);
    expect(res.repro).toEqual({ kind: 'repro', value: 'pnpm test -- -t refresh' });
  });

  it('una nota con no_repro valida: no reproducirlo es una respuesta legítima', () => {
    const res = validateChangeNote(conRepro('no_repro: reportado por soporte, sólo pasa con datos de prod'));
    expect(res.ok).toBe(true);
    expect(res.repro).toEqual({
      kind: 'no_repro',
      value: 'reportado por soporte, sólo pasa con datos de prod',
    });
  });

  it('sin ninguna de las dos no valida, y el mensaje nombra las dos salidas', () => {
    const [msg] = errores(conRepro(''));
    expect(msg).toMatch(/repro/);
    expect(msg).toMatch(/no_repro/);
  });

  it('las dos a la vez no valida', () => {
    expect(errores(conRepro("repro: 'pnpm test'\nno_repro: no se pudo")).join()).toMatch(/a la vez/);
  });

  it.each([
    ['un número', 'repro: 42'],
    ['una lista', 'repro: [a, b]'],
  ])('un valor que no es string no valida (%s)', (_caso, linea) => {
    expect(errores(conRepro(linea)).join()).toMatch(/tiene que ser un string/);
  });

  it.each(['repro:', 'repro: n/a', "repro: ' TBD '", 'no_repro: ---', 'no_repro: ???'])(
    'un valor vacío o de relleno no valida (%s)',
    (linea) => {
      expect(errores(conRepro(linea)).join()).toMatch(/placeholder/);
    },
  );

  it('un placeholder de template sin completar no valida', () => {
    expect(errores(conRepro("repro: '<comando que falla hoy>'")).join()).toMatch(/placeholder/);
  });

  it('500 caracteres pasa, 501 no', () => {
    const cmd = (n: number) => `repro: '${'a'.repeat(n)}'`;
    expect(validateChangeNote(conRepro(cmd(REPRO_MAX_LENGTH))).ok).toBe(true);
    expect(errores(conRepro(cmd(REPRO_MAX_LENGTH + 1))).join()).toMatch(/500/);
  });

  it('una clave parecida no cuenta, y el error dice cuál quisiste decir', () => {
    expect(errores(conRepro('no-repro: no se pudo')).join()).toMatch(/quisiste decir "no_repro"/);
    expect(errores(conRepro("Repro: 'pnpm test'")).join()).toMatch(/quisiste decir "repro"/);
  });

  it('el error de YAML sugiere comillas cuando el valor tiene ": "', () => {
    const msg = errores(conRepro('repro: pnpm test -t "claim: bloqueada"')).join();
    expect(msg).toMatch(/comillas/);
  });

  it('el error de repro se acumula con los de secciones y repo', () => {
    const sinNada = conRepro('').replace(/^repo:.*\n/m, '').replace(/## Cómo lo sé[\s\S]*?(?=## Qué cambio)/, '');
    const msgs = errores(sinNada);
    expect(msgs.some((m) => /no_repro/.test(m))).toBe(true);
    expect(msgs.some((m) => /repo/.test(m) && /owner/.test(m))).toBe(true);
    expect(msgs.some((m) => /evidence/.test(m))).toBe(true);
  });
});
```

- [ ] **Step 3: Correr y ver que fallan**

Run: `cd apps/server && npx vitest run test/change-note-validation.test.ts`
Expected: FAIL. Los tests de repro fallan (`res.repro` undefined, sin error de "placeholder"). El test de YAML falla porque el mensaje no dice "comillas". Si el test existente "una nota completa valida" falla, es un error de import del helper: corregilo antes de seguir.

- [ ] **Step 4: Exportar `hasAngleBracketPlaceholder`**

En `apps/server/src/validation/markdown-sections.ts:106`, cambiar `function hasAngleBracketPlaceholder` por `export function hasAngleBracketPlaceholder`.

- [ ] **Step 5: Implementar en `change-note.ts`**

Imports nuevos arriba:

```ts
import { hasAngleBracketPlaceholder, validateMarkdownSections, type SectionRule } from './markdown-sections.js';
import { isPlaceholderText } from './qa-envelope.js';
```

(reemplaza el import existente de `markdown-sections.js`).

Después de `ChangeNoteValidation`, agregar el tipo y el tope, y el campo en la interfaz:

```ts
/**
 * Cómo se reproduce lo que la nota arregla o mejora, o por qué no se pudo.
 *
 * Es el piso del lado del diagnóstico: QA exige un comando que alguien corrió para la
 * entrega, y hasta acá nada lo pedía para el bug. `no_repro` es una salida legítima;
 * lo único que se rechaza es el silencio. El juicio —si el comando reproduce *este*
 * síntoma— es de `skill-repro-antes-del-fix`, no del server.
 */
export interface ReproDeclaration {
  kind: 'repro' | 'no_repro';
  value: string;
}

/**
 * Un comando o una o dos frases. El valor va al payload de `change_note.submitted`, que
 * es un campo abierto: sin tope, un log pegado entra entero al event log.
 */
export const REPRO_MAX_LENGTH = 500;
```

Y en `ChangeNoteValidation`:

```ts
  /** La declaración de repro, si la nota trae una válida. */
  repro?: ReproDeclaration;
```

En el `catch` del parseo, reemplazar el mensaje:

```ts
      message:
        `Failed to parse YAML frontmatter: ${(err as Error).message}. ` +
        'Si un valor tiene ": " adentro (un comando con -t "a: b", por ejemplo), ponelo entre comillas simples.',
```

En `validateChangeNote`, después de `const components = componentsDelFrontmatter(data, issues);`:

```ts
  const repro = reproDelFrontmatter(data, issues);
```

y el `return` final:

```ts
  return { ok, issues, body, ...(components ? { components } : {}), ...(repro ? { repro } : {}) };
```

Al final del archivo:

```ts
const CLAVES_REPRO = ['repro', 'no_repro'] as const;

function reproIssue(message: string): ValidationIssue {
  return { severity: 'error', section: 'frontmatter', message };
}

/**
 * Saca la declaración de repro del frontmatter. Exactamente una de las dos claves, con un
 * string que no sea relleno ni placeholder y que entre en el tope.
 */
function reproDelFrontmatter(
  data: Record<string, unknown>,
  issues: ValidationIssue[],
): ReproDeclaration | undefined {
  const presentes = CLAVES_REPRO.filter((k) => data[k] !== undefined);

  if (presentes.length === 0) {
    // `no-repro:` o `Repro:` son el error más probable, y "falta la declaración" no le
    // diría al autor qué hizo mal.
    const parecida = Object.keys(data).find((k) => /^(no[-_ ]?)?repro$/i.test(k));
    if (parecida) {
      const quiso = /^no/i.test(parecida) ? 'no_repro' : 'repro';
      issues.push(reproIssue(`"${parecida}" no es una clave que la nota reconozca: ¿quisiste decir "${quiso}"?`));
      return undefined;
    }
    issues.push(
      reproIssue(
        'La nota tiene que declarar en su frontmatter "repro: <comando que reproduce el problema>" o, si no ' +
          'lo pudiste reproducir, "no_repro: <por qué>". Las dos son válidas; lo que no vale es no decir nada.',
      ),
    );
    return undefined;
  }

  if (presentes.length === 2) {
    issues.push(
      reproIssue(
        'La nota declara "repro" y "no_repro" a la vez: elegí una. Si lo reproduciste, queda "repro"; ' +
          'si no, "no_repro" con el por qué.',
      ),
    );
    return undefined;
  }

  const kind = presentes[0]!;
  // `repro:` sin valor llega como null: es un vacío, no un tipo equivocado.
  const raw = data[kind] === null ? '' : data[kind];
  if (typeof raw !== 'string') {
    issues.push(
      reproIssue(
        `"${kind}" tiene que ser un string (el comando, o el por qué). ` +
          'Si el valor tiene ": " adentro, ponelo entre comillas simples.',
      ),
    );
    return undefined;
  }

  const value = raw.trim();
  if (isPlaceholderText(value) || hasAngleBracketPlaceholder(value)) {
    issues.push(
      reproIssue(
        kind === 'repro'
          ? `"repro" es un placeholder (${JSON.stringify(value)}). Escribí el comando que reproduce el problema, ` +
              'o cambiá a "no_repro: <por qué>" si no lo pudiste reproducir.'
          : `"no_repro" es un placeholder (${JSON.stringify(value)}). Escribí por qué no se pudo reproducir: ` +
              'de dónde viene el reporte y qué lo impide.',
      ),
    );
    return undefined;
  }

  if (value.length > REPRO_MAX_LENGTH) {
    issues.push(
      reproIssue(
        `"${kind}" tiene ${value.length} caracteres; el tope es ${REPRO_MAX_LENGTH}. Es un comando o una o dos ` +
          'frases: si hace falta un log, va en la sección "Cómo lo sé".',
      ),
    );
    return undefined;
  }

  return { kind, value };
}
```

- [ ] **Step 6: Correr y ver que pasan**

Run: `cd apps/server && npx vitest run test/change-note-validation.test.ts`
Expected: PASS, todos.

- [ ] **Step 7: Correr la suite y anotar qué rompe**

Run: `cd apps/server && pnpm test 2>&1 | grep -E "FAIL|Tests "`
Expected: fallan `submit-change-note.test.ts` y `track-liviano-e2e.test.ts`, porque sus notas locales no tienen `repro`. Es esperado; los arregla la Task 2. Cualquier **otro** archivo que falle es un hallazgo: anotalo y resolvelo acá.

- [ ] **Step 8: Commit**

```bash
git add apps/server/src/validation/markdown-sections.ts apps/server/src/validation/change-note.ts \
  apps/server/test/helpers/change-note.ts apps/server/test/change-note-validation.test.ts
git commit -m "feat(change-note): la nota declara repro o no_repro, y el silencio no pasa

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `repro` en el evento `change_note.submitted`

**Files:**
- Modify: `apps/server/src/mcp/tools/submit-change-note.ts:256-266`
- Modify: `apps/server/test/submit-change-note.test.ts`
- Modify: `apps/server/test/track-liviano-e2e.test.ts`

**Interfaces:**
- Consumes: `validation.repro: ReproDeclaration` (Task 1); `NOTA_OK`, `STORY_OK`, `conRepro` (Task 1 helper)
- Produces: payload de `change_note.submitted` con `repro: { kind, value }`

- [ ] **Step 1: Pasar los dos archivos al helper**

En `apps/server/test/submit-change-note.test.ts`: borrar las constantes locales `NOTA` (líneas 18-39) y `STORY` (41-45) y agregar:

```ts
import { NOTA_OK as NOTA, STORY_OK as STORY, conRepro } from './helpers/change-note.js';
```

En el test `'una nota sin repo declarado no escribe nada'`, la regex asume que `repo` es la única línea del frontmatter. Reemplazar:

```ts
        change_note_markdown: NOTA.replace(/^---\nrepo:.*\n---\n/, ''),
```

por:

```ts
        change_note_markdown: NOTA.replace(/^repo:.*\n/m, ''),
```

En `apps/server/test/track-liviano-e2e.test.ts`: borrar la constante local `NOTA` (desde la línea 27 hasta el cierre del template string) y, si define una `STORY` idéntica a `STORY_OK`, también. Agregar:

```ts
import { NOTA_OK as NOTA } from './helpers/change-note.js';
```

(y `STORY_OK as STORY` si se borró la local).

- [ ] **Step 2: Escribir los tests que fallan**

En `submit-change-note.test.ts`, dentro de `describe('submit_change_note — el camino feliz', ...)`, agregar:

```ts
  it('el evento lleva la declaración de repro, que es lo que permite medir si el campo sirve', async () => {
    const { store, registry } = await armar();
    const flow = await flowEn(store, 'fix');
    await registry.get('submit_change_note')!.handler(
      { flow_id: flow.flow_id, change_note_markdown: NOTA, stories: [STORY] } as never,
      DEV,
    );

    const nota = (await store.listEvents(flow.flow_id)).find((e) => e.type === 'change_note.submitted');
    expect(nota!.payload.repro).toEqual({
      kind: 'repro',
      value: 'pnpm --filter @sdlc/server test -- -t "refresh sin workspaces"',
    });
  });

  it('con no_repro, el evento lo registra igual', async () => {
    const { store, registry } = await armar();
    const flow = await flowEn(store, 'fix');
    await registry.get('submit_change_note')!.handler(
      {
        flow_id: flow.flow_id,
        change_note_markdown: conRepro('no_repro: sólo pasa con datos de prod'),
        stories: [STORY],
      } as never,
      DEV,
    );

    const nota = (await store.listEvents(flow.flow_id)).find((e) => e.type === 'change_note.submitted');
    expect(nota!.payload.repro).toEqual({ kind: 'no_repro', value: 'sólo pasa con datos de prod' });
  });
```

Y dentro de `describe('submit_change_note — guardas', ...)`:

```ts
  it('una nota sin repro ni no_repro no escribe nada, ni el evento', async () => {
    const { store, registry } = await armar();
    const flow = await flowEn(store, 'fix');

    const res = (await registry.get('submit_change_note')!.handler(
      { flow_id: flow.flow_id, change_note_markdown: conRepro(''), stories: [STORY] } as never,
      DEV,
    )) as Resultado;

    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/no_repro/);
    expect((await store.getFlow(flow.flow_id))?.status).toBe('draft');
    expect((await store.listEvents(flow.flow_id)).some((e) => e.type === 'change_note.submitted')).toBe(false);
  });
```

- [ ] **Step 3: Correr y ver que fallan los dos del evento**

Run: `cd apps/server && npx vitest run test/submit-change-note.test.ts`
Expected: FAIL en los dos tests del evento (`payload.repro` undefined). El de "sin repro" ya pasa gracias a la Task 1; está para fijar que no se escribe el evento.

- [ ] **Step 4: Implementar**

En `apps/server/src/mcp/tools/submit-change-note.ts`, en el `appendEvent` de `change_note.submitted`, agregar al payload después de `story_count`:

```ts
          // Lo único de la nota que se guarda además del sha256: sin esto no hay forma de
          // medir si el campo sirve (ver el spec 2026-09-28-repro-antes-del-fix § "Cómo se
          // sabría si sirvió"). La validación ya garantizó que existe.
          repro: validation.repro ?? null,
```

- [ ] **Step 5: Correr los dos archivos**

Run: `cd apps/server && npx vitest run test/submit-change-note.test.ts test/track-liviano-e2e.test.ts`
Expected: PASS.

- [ ] **Step 6: Suite completa**

Run: `cd apps/server && pnpm typecheck && pnpm test 2>&1 | grep -E "FAIL|Tests "`
Expected: typecheck limpio, 0 FAIL.

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/mcp/tools/submit-change-note.ts apps/server/test/submit-change-note.test.ts \
  apps/server/test/track-liviano-e2e.test.ts
git commit -m "feat(change-note): el evento change_note.submitted registra el repro

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: El eje de escenario `initiative_type`

**Files:**
- Modify: `packages/catalog/src/index.ts` (`ScenarioSkillMap` ~l.28, `ScenarioContext` ~l.130, `resolveSkillIds`)
- Modify: `apps/server/src/mcp/tools/story-component.ts:26-32`
- Modify: `apps/server/src/mcp/tools/get-role-prompt.ts:41-44`
- Modify: `apps/server/test/scenario-skills.test.ts`

**Interfaces:**
- Produces: `ScenarioContext.initiative_type?: 'improvement' | 'feature' | 'refactor' | 'fix'`; `scenario_skills.<role>.<phase>.initiative_type.<valor>: string[]` en `catalog.yaml`

El test usa un catálogo **fixture**: la skill real llega recién en la Task 4, y este eje tiene que poder revisarse sin ella.

- [ ] **Step 1: Escribir los tests que fallan**

Al principio de `apps/server/test/scenario-skills.test.ts`, agregar imports y un fixture:

```ts
import { afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Catálogo mínimo con una skill atada al eje initiative_type de developer.implement. */
function catalogoConEje(): string {
  const root = mkdtempSync(join(tmpdir(), 'sdlc-catalog-eje-'));
  temps.push(root);
  const write = (rel: string, content: string) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), content, 'utf8');
  };
  write(
    'catalog.yaml',
    [
      'schema: 1',
      'catalog_version: 1.0.0',
      'roles:',
      '  developer:',
      '    role_prompt: roles/dev/role.md',
      '    version: 1.0.0',
      '    phases:',
      '      implement:',
      '        path: roles/dev/implement.md',
      '        version: 1.0.0',
      '        skills: [skill-base]',
      '        templates: []',
      'skills:',
      '  skill-base:',
      '    path: skills/base.md',
      '    version: 1.0.0',
      '  skill-del-fix:',
      '    path: skills/fix.md',
      '    version: 1.0.0',
      'templates: {}',
      'scenario_skills:',
      '  developer.implement:',
      '    initiative_type:',
      '      fix: [skill-del-fix]',
      '      improvement: [skill-del-fix]',
      '',
    ].join('\n'),
  );
  write('roles/dev/role.md', '---\nid: roles.developer\nversion: 1.0.0\n---\nRol.\n');
  write('roles/dev/implement.md', '---\nid: roles.developer.phases.implement\nversion: 1.0.0\n---\nFase.\n');
  write('skills/base.md', '---\nid: skill-base\nversion: 1.0.0\ndescription: Base.\n---\nBase.\n');
  write('skills/fix.md', '---\nid: skill-del-fix\nversion: 1.0.0\ndescription: Del fix.\n---\nFix.\n');
  return root;
}
```

Y un `describe` nuevo al final:

```ts
describe('catalog — scenario_skills por initiative_type', () => {
  it.each(['fix', 'improvement'] as const)('%s suma la skill del eje', async (initiative_type) => {
    const catalog = await Catalog.load(catalogoConEje());
    const bundle = await catalog.getRolePrompt('developer', 'implement', { initiative_type });
    expect(bundle.skills.map((s) => s.id)).toEqual(['skill-base', 'skill-del-fix']);
  });

  it.each(['feature', 'refactor'] as const)('%s no la suma', async (initiative_type) => {
    const catalog = await Catalog.load(catalogoConEje());
    const bundle = await catalog.getRolePrompt('developer', 'implement', { initiative_type });
    expect(bundle.skills.map((s) => s.id)).toEqual(['skill-base']);
  });

  it('sin initiative_type (un flow viejo) no la suma y no rompe', async () => {
    const catalog = await Catalog.load(catalogoConEje());
    const bundle = await catalog.getRolePrompt('developer', 'implement', {});
    expect(bundle.skills.map((s) => s.id)).toEqual(['skill-base']);
  });
});
```

Y para el camino real, en el mismo `describe`:

```ts
  it('scenarioForStory toma el initiative_type del flow', async () => {
    const { scenarioForStory } = await import('../src/mcp/tools/story-component.js');
    const flow = { initiative_type: 'fix' } as never;
    const story = {} as never;
    expect(scenarioForStory(flow, story)).toEqual({ initiative_type: 'fix' });
    expect(scenarioForStory({} as never, story)).toEqual({});
  });
```

- [ ] **Step 2: Correr y ver que fallan**

Run: `cd apps/server && npx vitest run test/scenario-skills.test.ts`
Expected: FAIL. `Catalog.load` del fixture tira por `initiative_type` desconocido en `scenario_skills`, o carga y no suma la skill. `scenarioForStory` devuelve `{}`.

- [ ] **Step 3: Implementar en el catálogo**

En `packages/catalog/src/index.ts`, dentro de `ScenarioSkillMap`, después de `component_kind`:

```ts
    initiative_type: z
      .object({
        improvement: z.array(z.string()).default([]),
        feature: z.array(z.string()).default([]),
        refactor: z.array(z.string()).default([]),
        fix: z.array(z.string()).default([]),
      })
      .partial()
      .optional(),
```

En `ScenarioContext`:

```ts
  initiative_type?: 'improvement' | 'feature' | 'refactor' | 'fix';
```

En `resolveSkillIds`:

```ts
    const dimensions = ['architecture_mode', 'codebase_status', 'component_kind', 'initiative_type'] as const;
```

- [ ] **Step 4: Implementar en el server**

`apps/server/src/mcp/tools/story-component.ts`, en `scenarioForStory`, antes del `return`:

```ts
  if (flow.initiative_type) scenario.initiative_type = flow.initiative_type;
```

`apps/server/src/mcp/tools/get-role-prompt.ts`, después de `if (flow.codebase_status) ...`:

```ts
        if (flow.initiative_type) scenarioObj.initiative_type = flow.initiative_type;
```

- [ ] **Step 5: Build del catálogo y tests**

Run: `pnpm --filter @sdlc/catalog build && cd apps/server && npx vitest run test/scenario-skills.test.ts`
Expected: PASS.

- [ ] **Step 6: Suite completa**

Run: `cd apps/server && pnpm typecheck && pnpm test 2>&1 | grep -E "FAIL|Tests "`
Expected: 0 FAIL. El catálogo bundleado no cambió, así que el sello sigue valiendo.

- [ ] **Step 7: Commit**

```bash
git add packages/catalog/src/index.ts apps/server/src/mcp/tools/story-component.ts \
  apps/server/src/mcp/tools/get-role-prompt.ts apps/server/test/scenario-skills.test.ts
git commit -m "feat(catalog): initiative_type como eje de las skills de escenario

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: La skill, el cableado y los textos

**Files:**
- Create: `packages/catalog/skills/skill-repro-antes-del-fix.md`
- Modify: `packages/catalog/catalog.yaml`
- Modify: `packages/catalog/templates/change-note-template.md`
- Modify: `packages/catalog/roles/developer/phases/change-note.md`
- Modify: `apps/server/test/scenario-skills.test.ts`
- Modify: `apps/server/test/track-liviano-e2e.test.ts`
- Modify: `apps/server/test/change-note-validation.test.ts`
- Modify: `docs/superpowers/specs/2026-09-28-repro-antes-del-fix-design.md`, `docs/superpowers/specs/2026-09-14-analisis-tanda-3-design.md`

**Interfaces:**
- Consumes: el eje `initiative_type` (Task 3); `validateChangeNote` (Task 1)

- [ ] **Step 1: Escribir los tests que fallan**

En `apps/server/test/scenario-skills.test.ts`, en el `describe` de la Task 3:

```ts
  it('el catálogo real: implement de un fix trae skill-repro-antes-del-fix, el de una feature no', async () => {
    const catalog = await Catalog.load(CATALOG_ROOT);
    const ids = async (initiative_type: 'fix' | 'feature') =>
      (await catalog.getRolePrompt('developer', 'implement', { initiative_type })).skills.map((s) => s.id);
    expect(await ids('fix')).toContain('skill-repro-antes-del-fix');
    expect(await ids('feature')).not.toContain('skill-repro-antes-del-fix');
  });

  it('el catálogo real: change-note trae la skill siempre', async () => {
    const catalog = await Catalog.load(CATALOG_ROOT);
    const bundle = await catalog.getRolePrompt('developer', 'change-note');
    expect(bundle.skills.map((s) => s.id)).toContain('skill-repro-antes-del-fix');
  });
```

En `apps/server/test/track-liviano-e2e.test.ts`, después de `expect(reclamada.ok).toBe(true);` (~l.104):

```ts
    // El camino real por el que la skill llega al developer de un fix.
    const skills = (reclamada.data as { skills: Array<{ id: string }> }).skills.map((s) => s.id);
    expect(skills).toContain('skill-repro-antes-del-fix');
```

(Si `llamar` no expone `data` con ese tipo, castear como en el resto del archivo.)

En `apps/server/test/change-note-validation.test.ts`, en el `describe` de repro:

```ts
  it('el template tal cual no valida, y uno de los errores es el de repro', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const template = readFileSync(
      resolve(__dirname, '../../../packages/catalog/templates/change-note-template.md'),
      'utf8',
    );
    const msgs = errores(template);
    expect(msgs.some((m) => /"repro" es un placeholder/.test(m))).toBe(true);
  });
```

- [ ] **Step 2: Correr y ver que fallan**

Run: `cd apps/server && npx vitest run test/scenario-skills.test.ts test/track-liviano-e2e.test.ts test/change-note-validation.test.ts`
Expected: FAIL en los cuatro tests nuevos. La skill no existe, y el template no tiene `repro`, así que el error es "falta la declaración" y no "placeholder".

- [ ] **Step 3: Escribir la skill**

`packages/catalog/skills/skill-repro-antes-del-fix.md`:

```markdown
---
id: skill-repro-antes-del-fix
version: 0.1.0
description: "En un fix o un improvement: construir la señal roja antes de tocar código (el repro que declara la nota, o por qué no se pudo) y diagnosticar desde ahí, con el test de regresión escrito primero."
---

# Skill: El repro antes del fix

Un fix sin una señal roja es una hipótesis que nadie vio fallar. Esta skill cubre los dos
momentos donde eso se decide: cuando escribís la nota de cambio y cuando implementás.

## Al escribir la nota: la señal roja primero

La nota declara en su frontmatter **una** de dos cosas:

- `repro: '<comando>'` — un comando que hoy falla **por este problema**. En un `improvement`,
  el comando que muestra el comportamiento actual: la línea base contra la que se mide la
  mejora.
- `no_repro: <por qué>` — cuando no lo pudiste reproducir. Es una respuesta honesta y válida.

Un buen `repro`:

1. **Falla por este bug, no por uno vecino.** Si el test falla, el mensaje tiene que ser el
   síntoma que reportaron. Un test que falla por un timeout cuando el bug es un dato mal
   calculado reproduce otra cosa.
2. **Es determinista.** Corrido tres veces, falla las tres. Si falla a veces, todavía no es un
   repro: es una pista, y va en `no_repro` con lo que sabés del disparador.
3. **Es lo más acotado posible.** Un test filtrado (`-t "..."`) antes que la suite entera; un
   `curl` a un endpoint antes que "levantar la app y navegar".
4. **Se puede pegar y correr.** Sin tokens, sin ids de clientes, sin rutas de tu máquina. El
   valor queda registrado en el log de eventos del flow.
5. **Va entre comillas simples** si tiene `": "` adentro: si no, rompe el YAML.

Un buen `no_repro` le dice a quien verifique qué mirar: *"reportado por soporte en el ticket
4411; sólo pasa con el catálogo de prod, que no tenemos en staging"*. Dos frases como mucho.
El detalle largo va en la sección "Cómo lo sé".

## Al implementar: el bucle

1. **Minimizá el repro.** Sacale todo lo que no hace falta para que falle. El repro mínimo
   suele señalar la causa por sí solo.
2. **Escribí 3 a 5 hipótesis falsables antes de tocar código.** Cada una dice qué observación
   la descartaría. Si sólo tenés una, todavía no entendiste el problema.
3. **Instrumentá cambiando una variable por vez.** Un log, un breakpoint, un valor fijo. Dos
   cambios a la vez no te dicen cuál de los dos importó.
4. **El arreglo arranca con el test de regresión.** Escribilo en el seam correcto —el borde
   donde el síntoma se observa, no el helper que sospechás— y **miralo fallar** antes de
   arreglar. Si pasa antes del arreglo, no reproduce el bug.
5. **Limpiá la instrumentación.** Los logs y los valores fijos del paso 3 no van en el PR.

Ese test de regresión, o el `repro` de la nota, es el candidato natural para el
`test_command` que QA va a exigir en su envelope: es el comando que muestra que lo que antes
fallaba ahora pasa.
```

- [ ] **Step 4: Cablearla en `catalog.yaml`**

En `packages/catalog/catalog.yaml`:

1. En `roles.developer.phases.change-note`, `skills: []` → `skills: [skill-repro-antes-del-fix]`, y `version: 0.1.1` → `0.2.0`.
2. En `templates.change-note-template`, `version: 0.1.0` → `0.2.0`.
3. En `skills:`, agregar:

```yaml
  skill-repro-antes-del-fix:
    path: skills/skill-repro-antes-del-fix.md
    version: 0.1.0
```

4. En `scenario_skills.developer.implement`, agregar después de `component_kind`:

```yaml
    initiative_type:
      fix: [skill-repro-antes-del-fix]
      improvement: [skill-repro-antes-del-fix]
```

5. `catalog_version: 0.11.0` → `0.12.0`.

- [ ] **Step 5: El template**

En `packages/catalog/templates/change-note-template.md`, el frontmatter pasa a:

```markdown
---
repo: <owner>/<repo>
# El comando que hoy falla por este problema, entre comillas simples. Si no lo pudiste
# reproducir, reemplazá la línea por: no_repro: <por qué>
repro: '<comando que falla hoy>'
---
```

Y en la sección "Cómo lo sé", al final del primer párrafo (después de "no tiene contra qué contrastar."), agregar:

```markdown
El comando va además en el frontmatter (`repro`), que es lo que queda registrado; acá va el
detalle que no entra en una línea.
```

- [ ] **Step 6: La fase**

En `packages/catalog/roles/developer/phases/change-note.md`:
- frontmatter `version: 0.1.1` → `0.2.0`;
- en el paso 2 ("Declará el repo en el frontmatter..."), al final del paso, agregar como párrafo del mismo ítem:

```markdown
   Declará también **cómo se reproduce**: `repro: '<comando que falla hoy>'`, o
   `no_repro: <por qué>` si no lo pudiste reproducir. Las dos son válidas; el server
   rechaza la nota si no dice ninguna. Leé `skill-repro-antes-del-fix` para qué hace bueno
   a un repro.
```

- [ ] **Step 7: Resellar y correr**

Run:

```bash
pnpm --filter @sdlc/catalog build && pnpm --filter @sdlc/catalog seal
cd apps/server && npx vitest run test/scenario-skills.test.ts test/track-liviano-e2e.test.ts test/change-note-validation.test.ts
```

Expected: `Sellado: catálogo 0.12.0 → sha256:…`, y PASS.

- [ ] **Step 8: Suite completa**

Run: `cd apps/server && pnpm typecheck && pnpm test 2>&1 | grep -E "FAIL|Tests "`
Expected: 0 FAIL. `catalog-frontmatter` valida la skill nueva, `catalog-tool-calls` revisa las menciones y `catalog-version` el sello, sin tocarlos.

- [ ] **Step 9: Los specs**

En `docs/superpowers/specs/2026-09-28-repro-antes-del-fix-design.md`:
- `**Estado:** aprobado, sin implementar.` → `**Estado:** implementado.`
- El párrafo "Los fixtures que hoy mandan una nota válida sin `repro`…" pasa a decir que son **dos** archivos (`submit-change-note`, `track-liviano-e2e`) más la copia de `change-note-validation`. Los otros cinco mandan `'x'.repeat(60)`, que ya se rechazaba, o no validan. Las tres copias quedaron en `test/helpers/change-note.ts`.

En `docs/superpowers/specs/2026-09-14-analisis-tanda-3-design.md`:
- el `**Estado:**` pasa a: `los cuatro candidatos están implementados (ver sus secciones).`
- al final de la sección del candidato 4, justo antes de `### El orden, y por qué`, agregar:

```markdown
**Implementado** (catálogo 0.12.0; diseño en `2026-09-28-repro-antes-del-fix-design.md`),
aplicado a `fix` **y** `improvement` (en un improvement, `repro` es la línea base). La
declaración viaja en el payload de `change_note.submitted`, así que la señal de § "Cómo se
sabría" es una consulta sobre `flow_events`.
```

- [ ] **Step 10: Commit**

```bash
git add packages/catalog apps/server/test docs/superpowers/specs
git commit -m "feat(catalog): skill-repro-antes-del-fix, en change-note y en el implement de un fix

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

## Cierre

- [ ] `pnpm --filter @sdlc/server test`, `pnpm --filter @sdlc/server typecheck` y `pnpm --filter @sdlc/server build` limpios.
- [ ] Push de `feat/repro-antes-del-fix` y PR a `main`, con la consulta de medición del spec en la descripción.
