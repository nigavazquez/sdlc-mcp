import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import matter from 'gray-matter';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import type { PhaseId, RoleId } from '@sdlc/core';

const PhaseEntry = z.object({
  path: z.string(),
  version: z.string(),
  skills: z.array(z.string()).default([]),
  templates: z.array(z.string()).default([]),
});

const RoleEntry = z.object({
  role_prompt: z.string(),
  version: z.string(),
  phases: z.record(PhaseEntry),
});

const SimpleEntry = z.object({
  path: z.string(),
  version: z.string(),
});

const ScenarioSkillMap = z
  .object({
    architecture_mode: z
      .object({
        new: z.array(z.string()).default([]),
        reuse: z.array(z.string()).default([]),
        hybrid: z.array(z.string()).default([]),
      })
      .partial()
      .optional(),
    codebase_status: z
      .object({
        greenfield: z.array(z.string()).default([]),
        existing: z.array(z.string()).default([]),
      })
      .partial()
      .optional(),
    component_kind: z
      .object({
        app: z.array(z.string()).default([]),
        infra: z.array(z.string()).default([]),
      })
      .partial()
      .optional(),
    initiative_type: z
      .object({
        improvement: z.array(z.string()).default([]),
        feature: z.array(z.string()).default([]),
        refactor: z.array(z.string()).default([]),
        fix: z.array(z.string()).default([]),
      })
      .partial()
      .optional(),
  })
  .partial();

/**
 * Sello: el digest del contenido al que corresponde `sealed_version`.
 *
 * Es lo que convierte a `catalog_version` en algo verificable en vez de un número
 * que alguien se acuerda de mover. Lo escribe `pnpm --filter @sdlc/catalog seal`.
 */
const Seal = z.object({
  sealed_version: z.string(),
  digest: z.string(),
});
export type CatalogSeal = z.infer<typeof Seal>;

const CatalogIndex = z.object({
  schema: z.literal(1),
  catalog_version: z.string(),
  /** Opcional: un catálogo propio (CATALOG_ROOT) puede no sellar. */
  seal: Seal.optional(),
  roles: z.record(RoleEntry),
  skills: z.record(SimpleEntry).default({}),
  templates: z.record(SimpleEntry).default({}),
  scenario_skills: z.record(ScenarioSkillMap).default({}),
});
export type CatalogIndex = z.infer<typeof CatalogIndex>;

/**
 * Resultado del chequeo del sello.
 *
 * - `ok`: el contenido en disco es exactamente el que declara `catalog_version`.
 * - `drift`: el contenido cambió y la versión no se movió — el caso que este
 *   mecanismo existe para agarrar.
 * - `stale-version`: se bumpeó la versión pero no se reselló.
 * - `unsealed`: el catálogo no declara sello (catálogo propio vía CATALOG_ROOT).
 */
export type SealStatus = 'ok' | 'drift' | 'stale-version' | 'unsealed';

export interface SealCheck {
  status: SealStatus;
  /** `catalog_version` que declara el índice. */
  version: string;
  /** Digest calculado del contenido en disco. */
  digest: string;
  /** El sello declarado, si hay. */
  sealed?: CatalogSeal;
  /** Mensaje accionable: qué pasó y qué hacer. */
  message: string;
}

const SEAL_CMD = 'pnpm --filter @sdlc/catalog seal';

export interface PromptDocument {
  frontmatter: Record<string, unknown>;
  content: string;
}

export interface RolePromptBundle {
  role: RoleId;
  phase: PhaseId;
  version: string;
  system_prompt: string;
  skills: Array<{ id: string; version: string; markdown: string }>;
  templates: Array<{ id: string; content: string }>;
}

/**
 * Las secciones que una fase declara obligatorias en su frontmatter.
 *
 * `condicionales` son las que dependen del caso (p. ej. `integration_points`, que el
 * RFC exige sólo con architecture_mode reuse/hybrid o más de un componente). Van
 * aparte para que `siempre` se pueda leer como "esto va sí o sí".
 */
export interface RequiredSections {
  siempre: string[];
  condicionales: string[];
}

export interface ScenarioContext {
  architecture_mode?: 'new' | 'reuse' | 'hybrid';
  codebase_status?: 'greenfield' | 'existing';
  component_kind?: 'app' | 'infra';
  initiative_type?: 'improvement' | 'feature' | 'refactor' | 'fix';
}

export class Catalog {
  private constructor(
    private readonly index: CatalogIndex,
    private readonly rootDir: string,
  ) {}

  static async load(rootDir?: string): Promise<Catalog> {
    const root = rootDir ?? defaultRoot();
    const yamlPath = join(root, 'catalog.yaml');
    const raw = await readFile(yamlPath, 'utf8');
    const parsed = parseYaml(raw);
    const index = CatalogIndex.parse(parsed);
    await assertFrontmatter(index, root);
    return new Catalog(index, root);
  }

  get version(): string {
    return this.index.catalog_version;
  }

  /** El sello declarado en `catalog.yaml`, si el catálogo está sellado. */
  get seal(): CatalogSeal | undefined {
    return this.index.seal;
  }

  /**
   * Digest del **contenido** del catálogo: el índice (sin `catalog_version` ni `seal`)
   * más los bytes de cada archivo que el índice referencia, en orden estable.
   *
   * Deja afuera la versión y el sello a propósito: así el digest responde una sola
   * pregunta —"¿qué contenido hay acá?"— y mover la versión no lo cambia. Si el digest
   * también dependiera de la versión, un bump y una edición serían indistinguibles y el
   * mensaje de error no podría decir cuál de las dos cosas pasó.
   */
  async contentDigest(): Promise<string> {
    const { catalog_version: _v, seal: _s, ...content } = this.index;
    const hash = createHash('sha256');
    hash.update(stableStringify(content));
    for (const rel of this.referencedPaths()) {
      hash.update('\0');
      hash.update(rel);
      hash.update('\0');
      hash.update(await readFile(join(this.rootDir, rel)));
    }
    return `sha256:${hash.digest('hex')}`;
  }

  /**
   * Cruza el contenido en disco contra el sello. El chequeo que hace enforceable al
   * versionado: sin esto, `catalog_version` es un número que nadie verifica y el server
   * puede estar sirviendo prompts que no son los de la versión que reporta.
   */
  async verifySeal(): Promise<SealCheck> {
    const digest = await this.contentDigest();
    const version = this.index.catalog_version;
    const sealed = this.index.seal;

    if (!sealed) {
      return {
        status: 'unsealed',
        version,
        digest,
        message: `El catálogo ${version} no declara sello: no hay contra qué verificar su contenido. Sellalo con \`${SEAL_CMD}\`.`,
      };
    }
    if (sealed.digest !== digest) {
      return {
        status: 'drift',
        version,
        digest,
        sealed,
        message:
          `El contenido del catálogo cambió y catalog_version sigue en ${version} ` +
          `(sello: ${sealed.digest}, contenido: ${digest}). Bumpeá catalog_version y corré \`${SEAL_CMD}\`.`,
      };
    }
    if (sealed.sealed_version !== version) {
      return {
        status: 'stale-version',
        version,
        digest,
        sealed,
        message:
          `catalog_version es ${version} pero el sello quedó en ${sealed.sealed_version}. ` +
          `Corré \`${SEAL_CMD}\` para resellar.`,
      };
    }
    return {
      status: 'ok',
      version,
      digest,
      sealed,
      message: `Catálogo ${version} sellado y sin drift.`,
    };
  }

  /** Todos los archivos que el índice referencia, deduplicados y ordenados. */
  private referencedPaths(): string[] {
    const paths = new Set<string>();
    for (const role of Object.values(this.index.roles)) {
      paths.add(role.role_prompt);
      for (const phase of Object.values(role.phases)) paths.add(phase.path);
    }
    for (const skill of Object.values(this.index.skills)) paths.add(skill.path);
    for (const tpl of Object.values(this.index.templates)) paths.add(tpl.path);
    return [...paths].sort();
  }

  listRoles(): Array<{ role: RoleId; phases: PhaseId[] }> {
    return Object.entries(this.index.roles).map(([role, entry]) => ({
      role: role as RoleId,
      phases: Object.keys(entry.phases) as PhaseId[],
    }));
  }

  /**
   * Las secciones obligatorias que declara una fase.
   *
   * Existe para que el validador y el catálogo se puedan cruzar: son dos copias de
   * la misma lista —el catálogo se edita por PR aparte y lleva su propio semver, y
   * las aliases y los mínimos de contenido son enforcement y no contenido— y sin un
   * cruce se despegan en silencio. Un agente que lea `required_sections` para saber
   * qué escribir necesita que esa lista sea cierta.
   */
  async getRequiredSections(role: RoleId, phase: PhaseId): Promise<RequiredSections> {
    return {
      siempre: await this.phaseList(role, phase, 'required_sections'),
      condicionales: await this.phaseList(role, phase, 'conditional_sections'),
    };
  }

  /**
   * La secuencia de tools que la fase declara en su frontmatter (`next_actions`), en orden.
   * Cada entrada es un nombre de tool o una llamada con la forma `nombre({a, b?})`.
   *
   * Vive al lado de `required_sections` por la misma razón: la prosa del prompt la narra
   * y el frontmatter la vuelve algo que `get_role_prompt` puede devolver y un test cruzar
   * contra el registry.
   */
  async getNextActions(role: RoleId, phase: PhaseId): Promise<string[]> {
    return this.phaseList(role, phase, 'next_actions');
  }

  /** Una lista de strings del frontmatter de la fase; ausente = vacía. */
  private async phaseList(role: RoleId, phase: PhaseId, clave: string): Promise<string[]> {
    const roleEntry = this.index.roles[role];
    if (!roleEntry) throw new Error(`Unknown role: ${role}`);
    const phaseEntry = roleEntry.phases[phase];
    if (!phaseEntry) throw new Error(`Unknown phase ${phase} for role ${role}`);

    const raw = (await this.readDoc(phaseEntry.path)).frontmatter[clave];
    if (raw === undefined) return [];
    if (!Array.isArray(raw) || raw.some((x) => typeof x !== 'string')) {
      throw new Error(`"${clave}" de ${role}/${phase} tiene que ser una lista de strings`);
    }
    return raw as string[];
  }

  async getRolePrompt(
    role: RoleId,
    phase: PhaseId,
    scenario?: ScenarioContext,
  ): Promise<RolePromptBundle> {
    const roleEntry = this.index.roles[role];
    if (!roleEntry) throw new Error(`Unknown role: ${role}`);
    const phaseEntry = roleEntry.phases[phase];
    if (!phaseEntry) throw new Error(`Unknown phase ${phase} for role ${role}`);

    const roleDoc = await this.readDoc(roleEntry.role_prompt);
    const phaseDoc = await this.readDoc(phaseEntry.path);
    const systemPrompt = `${roleDoc.content.trim()}\n\n---\n\n${phaseDoc.content.trim()}\n`;

    const skillIds = this.resolveSkillIds(role, phase, phaseEntry.skills, scenario);

    const skills = await Promise.all(
      skillIds.map(async (id) => {
        const entry = this.index.skills[id];
        if (!entry) throw new Error(`Unknown skill: ${id}`);
        const doc = await this.readDoc(entry.path);
        return { id, version: entry.version, markdown: doc.content };
      }),
    );

    const templates = await Promise.all(
      phaseEntry.templates.map(async (id) => {
        const entry = this.index.templates[id];
        if (!entry) throw new Error(`Unknown template: ${id}`);
        const content = await readFile(join(this.rootDir, entry.path), 'utf8');
        return { id, content };
      }),
    );

    return {
      role,
      phase,
      version: phaseEntry.version,
      system_prompt: systemPrompt,
      skills,
      templates,
    };
  }

  private resolveSkillIds(
    role: RoleId,
    phase: PhaseId,
    base: string[],
    scenario?: ScenarioContext,
  ): string[] {
    const merged = new Set<string>(base);
    if (!scenario) return [...merged];

    const key = `${role}.${phase}`;
    const map = this.index.scenario_skills[key];
    if (!map) return [...merged];

    const dimensions = ['architecture_mode', 'codebase_status', 'component_kind', 'initiative_type'] as const;
    for (const dim of dimensions) {
      const value = scenario[dim];
      const dimMap = map[dim] as Record<string, string[] | undefined> | undefined;
      if (!value || !dimMap) continue;
      for (const id of dimMap[value] ?? []) merged.add(id);
    }
    return [...merged];
  }

  async getSkill(id: string): Promise<{ id: string; version: string; markdown: string }> {
    const entry = this.index.skills[id];
    if (!entry) throw new Error(`Unknown skill: ${id}`);
    const doc = await this.readDoc(entry.path);
    return { id, version: entry.version, markdown: doc.content };
  }

  async getTemplate(id: string): Promise<{ id: string; content: string }> {
    const entry = this.index.templates[id];
    if (!entry) throw new Error(`Unknown template: ${id}`);
    const content = await readFile(join(this.rootDir, entry.path), 'utf8');
    return { id, content };
  }

  private async readDoc(relPath: string): Promise<PromptDocument> {
    const abs = join(this.rootDir, relPath);
    const raw = await readFile(abs, 'utf8');
    const parsed = matter(raw);
    return { frontmatter: parsed.data, content: parsed.content };
  }
}

/**
 * El frontmatter de cada rol, fase y skill tiene que coincidir con el índice que lo apunta:
 * `id` igual a la clave que lo indexa, `version` igual a la de `catalog.yaml` y, en las
 * skills, una `description` no vacía. Son comparaciones de strings sin juicio sobre prosa;
 * qué dice una descripción lo mira el review (docs/PROMPT_AUTHORING.md).
 *
 * Los templates quedan afuera: `getTemplate` devuelve el archivo crudo, y un frontmatter
 * se filtraría al artefacto. Tira con todos los problemas juntos, no con el primero.
 */
async function assertFrontmatter(index: CatalogIndex, root: string): Promise<void> {
  const docs: Array<{ path: string; id: string; version: string; needsDescription: boolean }> = [];
  for (const [role, entry] of Object.entries(index.roles)) {
    docs.push({ path: entry.role_prompt, id: `roles.${role}`, version: entry.version, needsDescription: false });
    for (const [phase, p] of Object.entries(entry.phases)) {
      docs.push({ path: p.path, id: `roles.${role}.phases.${phase}`, version: p.version, needsDescription: false });
    }
  }
  for (const [id, skill] of Object.entries(index.skills)) {
    docs.push({ path: skill.path, id, version: skill.version, needsDescription: true });
  }

  const problems: string[] = [];
  for (const doc of docs) {
    const raw = await readFile(join(root, doc.path), 'utf8');
    if (!matter.test(raw)) {
      problems.push(`${doc.path}: no tiene frontmatter`);
      continue;
    }
    const fm = matter(raw).data as Record<string, unknown>;
    if (fm.id !== doc.id) {
      problems.push(`${doc.path}: id "${String(fm.id)}" no es la clave que lo indexa, "${doc.id}"`);
    }
    if (String(fm.version) !== doc.version) {
      problems.push(`${doc.path}: version ${String(fm.version)} no coincide con catalog.yaml, ${doc.version}`);
    }
    if (doc.needsDescription && (typeof fm.description !== 'string' || !fm.description.trim())) {
      problems.push(`${doc.path}: falta description`);
    }
  }
  if (problems.length > 0) {
    throw new Error(`Frontmatter del catálogo inconsistente con catalog.yaml:\n- ${problems.join('\n- ')}`);
  }
}

/**
 * JSON con las claves ordenadas, para que el digest no dependa del orden en que el
 * parser de YAML devolvió los objetos.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
  return `{${entries.join(',')}}`;
}

function defaultRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '..');
}
