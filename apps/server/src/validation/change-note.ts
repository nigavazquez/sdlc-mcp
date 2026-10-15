import matter from 'gray-matter';
import type { FlowComponent, ValidationIssue, ValidationResult } from '@sdlc/core';
import { validateMarkdownSections, type SectionRule } from './markdown-sections.js';
import { componentNameFromRepo, parseComponents, repoIssue } from './rfc-frontmatter.js';
import { isPlaceholderText } from './qa-envelope.js';

/**
 * Las cuatro secciones de una nota de cambio.
 *
 * No son un PRD recortado: son lo que un fix sí tiene. "Cómo lo sé" es el repro o la
 * evidencia del bug —el dato que un PRD de métricas de éxito no captura y que quien
 * revise el PR va a querer— y ninguna pide proyecciones, que es lo que para un cambio
 * chico obliga a inventar.
 *
 * `minContentLines: 1` en las cuatro, a propósito: la nota vale por ser corta. Si
 * alguna vez esta lista tiene ocho entradas, el track liviano dejó de existir.
 */
export const CHANGE_NOTE_RULES: SectionRule[] = [
  {
    id: 'what',
    aliases: ['Qué pasa', 'Que pasa', 'What', 'What happened', 'What happens'],
    minContentLines: 1,
  },
  {
    id: 'evidence',
    aliases: ['Cómo lo sé', 'Como lo se', 'Evidencia', 'Evidence'],
    minContentLines: 1,
  },
  {
    id: 'change',
    aliases: ['Qué cambio', 'Que cambio', 'Cambio', 'Change'],
    minContentLines: 1,
  },
  {
    id: 'verification',
    aliases: ['Cómo se verifica', 'Como se verifica', 'Verificación', 'Verificacion', 'Verification'],
    minContentLines: 1,
  },
];

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

export interface ChangeNoteValidation extends ValidationResult {
  /** El registro de componentes derivado del frontmatter, si se pudo armar. */
  components?: FlowComponent[];
  /** La declaración de repro, si la nota trae una válida. */
  repro?: ReproDeclaration;
  /** El cuerpo sin frontmatter. */
  body: string;
}

/**
 * Valida una nota de cambio: sus cuatro secciones y el repo contra el que se va a
 * trabajar.
 *
 * El repo no es documentación: `create_stories` exige que toda story nazca con uno
 * declarado porque `submit_review_outcome` compara el PR contra él, y sin eso el gate
 * de code review no tiene contra qué comparar. Es la única parte del frontmatter del
 * RFC que la nota no puede soltar, y por eso su ausencia es error y no warning.
 *
 * El parseo y la validación del repo son **los mismos** que usa el RFC
 * (`rfc-frontmatter.ts`): una nota y un RFC que declaren el mismo repo tienen que
 * producir el mismo componente, y dos copias de `isComparableRepo` se despegan.
 */
export function validateChangeNote(markdown: string): ChangeNoteValidation {
  const issues: ValidationIssue[] = [];
  let data: Record<string, unknown> = {};
  let body = markdown;

  try {
    const parsed = matter(markdown);
    data = (parsed.data ?? {}) as Record<string, unknown>;
    body = parsed.content;
  } catch (err) {
    issues.push({
      severity: 'error',
      section: 'frontmatter',
      message:
        `Failed to parse YAML frontmatter: ${(err as Error).message}. ` +
        'Si un valor tiene ": " adentro (un comando con -t "a: b", por ejemplo), ponelo entre comillas simples. ' +
        "Si el comando tiene una comilla simple adentro, duplicala ('') o usá comillas dobles para ese tramo.",
    });
    return { ok: false, issues, body };
  }

  const components = componentsDelFrontmatter(data, issues);
  const { repro, claveConfundida } = reproDelFrontmatter(data, issues);
  advertenciasClavesDesconocidas(data, issues, claveConfundida);

  // Las secciones se validan siempre, aunque el frontmatter haya fallado: al autor le
  // sirve más recibir todo lo que hay que corregir de una que de a un error por vez.
  issues.push(...validateMarkdownSections(body, CHANGE_NOTE_RULES).issues);

  const ok = issues.every((i) => i.severity !== 'error');
  return { ok, issues, body, ...(components ? { components } : {}), ...(repro ? { repro } : {}) };
}

/**
 * Saca el registro de componentes del frontmatter. Dos formas, como en el RFC:
 * `repo` para el caso normal de un fix (un repo, un PR) y `components` para el fix
 * que toca dos.
 */
function componentsDelFrontmatter(
  data: Record<string, unknown>,
  issues: ValidationIssue[],
): FlowComponent[] | undefined {
  if (data.components !== undefined) {
    const parsed = parseComponents(data.components, issues);
    if (parsed && parsed.length > 0) return parsed;
    // parseComponents ya explicó qué tiene de malo cada entrada; agregar acá un
    // "falta el repo" sería mandar al autor a corregir algo que sí declaró.
    return undefined;
  }

  const repo = data.repo;
  if (repo === undefined) {
    issues.push({
      severity: 'error',
      section: 'frontmatter',
      message:
        'La nota de cambio tiene que declarar el repo en su frontmatter ("repo: <owner>/<repo>", ' +
        'o "components" si el cambio toca más de uno). Sin repo declarado, el gate de code review ' +
        'no tiene contra qué comparar el PR.',
    });
    return undefined;
  }

  if (typeof repo !== 'string' || repo.trim().length === 0) {
    issues.push({
      severity: 'error',
      section: 'frontmatter',
      message: '"repo" tiene que ser un string no vacío.',
    });
    return undefined;
  }

  const limpio = repo.trim();
  const problema = repoIssue(limpio);
  if (problema) {
    // En el RFC un repo raro puede ser warning porque el documento igual sirve. Acá
    // la nota es el único lugar donde el repo se declara, así que un repo que el gate
    // no puede verificar deja el flow sin poder cerrar un review: es error.
    issues.push({
      severity: 'error',
      section: 'frontmatter',
      message: `"repo" ${problema.message}.`,
    });
    return undefined;
  }

  return [{ name: componentNameFromRepo(limpio), kind: 'app', repo: limpio }];
}

const CLAVES_REPRO = ['repro', 'no_repro'] as const;

function reproIssue(message: string): ValidationIssue {
  return { severity: 'error', section: 'frontmatter', message };
}

/**
 * Detecta un placeholder de template sin completar (`<comando que falla hoy>`), sin usar
 * el detector de prosa de `markdown-sections.ts`: ese matchea cualquier `<...>`, y un repro
 * suele ser un comando de shell real, donde `cmd < in > out` (redirección), `<(cmd)`
 * (sustitución de proceso) o una etiqueta de una sola palabra (`<title>`, `Array<string>`)
 * son legítimos y no tienen nada de relleno. Lo que se rechaza acá es específicamente la
 * forma del template: un placeholder es de **varias palabras** (todo lo que el template trae
 * es `<comando que falla hoy>`, `<por qué>`, etc.), formadas sólo por letras, `_` o `-`. Un
 * tag de una sola palabra o una redirección con espacio antes de la letra no matchean.
 */
const TEMPLATE_PLACEHOLDER_RE = /<\p{L}[\p{L}_-]*(?:\s+[\p{L}_-]+)+>/u;

/** Devuelve el fragmento que matchea el placeholder de template, si hay alguno. */
function templatePlaceholderFragment(value: string): string | undefined {
  return TEMPLATE_PLACEHOLDER_RE.exec(value)?.[0];
}

/** Lo que devuelve `reproDelFrontmatter`: la declaración, si hay una válida, y la clave
 * "parecida" que ya generó su propio error, para que el aviso de claves desconocidas no la
 * reporte una segunda vez. */
interface ReproResult {
  repro?: ReproDeclaration;
  claveConfundida?: string;
}

/**
 * Saca la declaración de repro del frontmatter. Exactamente una de las dos claves, con un
 * string que no sea relleno ni placeholder y que entre en el tope.
 */
function reproDelFrontmatter(data: Record<string, unknown>, issues: ValidationIssue[]): ReproResult {
  const presentes = CLAVES_REPRO.filter((k) => data[k] !== undefined);

  if (presentes.length === 0) {
    // `no-repro:` o `Repro:` son el error más probable, y "falta la declaración" no le
    // diría al autor qué hizo mal.
    const parecida = Object.keys(data).find((k) => /^(no[-_ ]?)?repro$/i.test(k));
    if (parecida) {
      const quiso = /^no/i.test(parecida) ? 'no_repro' : 'repro';
      issues.push(reproIssue(`"${parecida}" no es una clave que la nota reconozca: ¿quisiste decir "${quiso}"?`));
      return { claveConfundida: parecida };
    }
    issues.push(
      reproIssue(
        "La nota tiene que declarar en su frontmatter \"repro: '<comando que reproduce el problema>'\" o, si no " +
          'lo pudiste reproducir, "no_repro: <por qué>". Las dos son válidas; lo que no vale es no decir nada.',
      ),
    );
    return {};
  }

  if (presentes.length === 2) {
    issues.push(
      reproIssue(
        'La nota declara "repro" y "no_repro" a la vez: elegí una. Si lo reproduciste, queda "repro"; ' +
          'si no, "no_repro" con el por qué.',
      ),
    );
    return {};
  }

  const kind = presentes[0]!;
  // `repro:` sin valor llega como null: es un vacío, no un tipo equivocado.
  const raw = data[kind] === null ? '' : data[kind];
  if (typeof raw !== 'string') {
    issues.push(
      reproIssue(
        `"${kind}" tiene que ser un string (el comando, o el por qué). ` +
          'Si el valor tiene ": " adentro, ponelo entre comillas simples. ' +
          "Si tiene una comilla simple adentro, duplicala ('') o usá comillas dobles para ese tramo.",
      ),
    );
    return {};
  }

  const value = raw.trim();
  const fragmento = templatePlaceholderFragment(value);
  if (isPlaceholderText(value) || fragmento) {
    const citado = fragmento ? `"${fragmento}"` : JSON.stringify(value);
    issues.push(
      reproIssue(
        kind === 'repro'
          ? `"repro" es un placeholder: ${citado}. Escribí el comando que reproduce el problema, ` +
              'o cambiá a "no_repro: <por qué>" si no lo pudiste reproducir.'
          : `"no_repro" es un placeholder: ${citado}. Escribí por qué no se pudo reproducir: ` +
              'de dónde viene el reporte y qué lo impide.',
      ),
    );
    return {};
  }

  if (value.length > REPRO_MAX_LENGTH) {
    issues.push(
      reproIssue(
        `"${kind}" tiene ${value.length} caracteres; el tope es ${REPRO_MAX_LENGTH}. Es un comando o una o dos ` +
          'frases: si hace falta un log, va en la sección "Cómo lo sé".',
      ),
    );
    return {};
  }

  return { repro: { kind, value } };
}

const CLAVES_FRONTMATTER_CONOCIDAS = new Set(['repo', 'components', 'repro', 'no_repro']);

/**
 * Avisa (warning, no error) de cualquier clave del frontmatter que la nota no reconozca.
 * No es sólo cosmética: gray-matter parsea `repro: 'pnpm test -t 'claim: x''` sin error a
 * `{ repro: "pnpm test -t ", claim: "x''" }` — una comilla simple sin duplicar adentro del
 * comando trunca el valor en silencio, y la clave fantasma que queda del corte (acá
 * "claim") es la señal de que pasó. No se reporta la clave que ya generó el error de
 * "¿quisiste decir…?": ya tiene su propio mensaje, y duplicarlo no ayuda.
 */
function advertenciasClavesDesconocidas(
  data: Record<string, unknown>,
  issues: ValidationIssue[],
  claveConfundida: string | undefined,
): void {
  for (const key of Object.keys(data)) {
    if (CLAVES_FRONTMATTER_CONOCIDAS.has(key) || key === claveConfundida) continue;
    issues.push({
      severity: 'warning',
      section: 'frontmatter',
      message:
        `"${key}" no es una clave de la nota y se ignora. Si quedó de un valor entre comillas simples que se ` +
        "cortó, duplicá la comilla de adentro ('').",
    });
  }
}
