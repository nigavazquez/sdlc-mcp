import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ZodObject, ZodRawShape, ZodTypeAny } from 'zod';
import { Catalog } from '@sdlc/catalog';
import { InMemoryFlowStore } from '../src/state/in-memory.js';
import { InMemoryTaskSystemAdapter } from '../src/adapters/in-memory-task-system.js';
import { ConfigBackedTaskSystemProvider } from '../src/adapters/task-system-provider.js';
import { InMemoryIntegrationConfigStore } from '../src/integrations/in-memory.js';
import { buildToolRegistry, type ToolRegistry } from '../src/mcp/tools/index.js';
import { testCtx } from './helpers/tenant-ctx.js';
import { parseToolMentions, type ToolMention } from './helpers/tool-mentions.js';

/**
 * Las llamadas a tools que el catálogo narra, cruzadas contra el registry.
 *
 * Los prompts de fase le dicen al agente qué tool llamar y con qué argumentos, y el
 * schema de la tool dice qué acepta: son dos copias de la misma verdad. Se despegaron
 * en silencio —el prompt de review describía un review de un eje cuando el server exige
 * dos, el de QA omitía el envelope que es su gate— porque nada las miraba. Un agente que
 * sigue un prompt falso recibe un error de zod e improvisa.
 *
 * Mismo espíritu que required-sections-catalogo.test.ts. Por qué y con qué alcance:
 * docs/superpowers/specs/2026-09-14-analisis-tanda-3-design.md § 1.
 */

const REPO = resolve(__dirname, '../../..');
const CATALOG_ROOT = join(REPO, 'packages/catalog');
const TOOLS_DIR = join(REPO, 'apps/server/src/mcp/tools');

/**
 * Obligatorios que el schema declara `optional()` porque los exige el handler, para poder
 * devolver un error que enumere todo lo que falta. El schema solo no los ve.
 */
const REQUIRED_BY_HANDLER: Record<string, string[]> = {
  submit_qa_results: ['envelope'],
};

interface Located extends ToolMention {
  where: string;
}

function walk(dir: string, ext: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return walk(path, ext);
    return path.endsWith(ext) ? [path] : [];
  });
}

function mentionsIn(files: string[], extract: (text: string) => string[]): Located[] {
  return files.flatMap((file) =>
    readFileSync(file, 'utf8')
      .split('\n')
      .flatMap((line, i) =>
        extract(line).flatMap((chunk) =>
          parseToolMentions(chunk).map((m) => ({ ...m, where: `${relative(REPO, file)}:${i + 1}` })),
        ),
      ),
  );
}

/** En el markdown, sólo lo que va entre backticks: la forma canónica. */
const backticked = (line: string) => [...line.matchAll(/`([^`]+)`/g)].map((m) => m[1]!);

/** En las tools, sólo los literales de `next_actions`: strings entre comillas simples. */
const quoted = (line: string) => [...line.matchAll(/'([^']+)'/g)].map((m) => m[1]!);

function catalogMentions(): Located[] {
  const files = ['roles', 'skills', 'templates'].flatMap((d) => walk(join(CATALOG_ROOT, d), '.md'));
  return mentionsIn(files, backticked);
}

function nextActionLiterals(): Located[] {
  const files = walk(TOOLS_DIR, '.ts');
  return mentionsIn(files, (line) => (line.includes('next_actions') ? quoted(line) : []));
}

async function makeRegistry(): Promise<ToolRegistry> {
  const catalog = await Catalog.load(CATALOG_ROOT);
  return buildToolRegistry({
    catalog,
    store: new InMemoryFlowStore(),
    taskSystemProvider: new ConfigBackedTaskSystemProvider({
      configStore: new InMemoryIntegrationConfigStore(),
      inMemory: new InMemoryTaskSystemAdapter(),
    }),
  });
}

/** Lo que está mal en una mención, en una línea por problema. Vacío = coincide. */
function problems(m: Located, registry: ToolRegistry, opts: { requireAll: boolean }): string[] {
  const tool = registry.get(m.tool);
  if (!tool) return [`${m.where} ${m.raw}: no existe la tool "${m.tool}"`];

  const shape = (tool.inputSchema as ZodObject<ZodRawShape>).shape as Record<string, ZodTypeAny>;
  const out: string[] = [];
  const named = new Set(m.args.map((a) => a.key));

  for (const arg of m.args) {
    const field = shape[arg.key];
    if (!field) {
      out.push(`${m.where} ${m.raw}: "${arg.key}" no es un argumento de ${m.tool}`);
      continue;
    }
    if (arg.value !== undefined && !field.safeParse(arg.value).success) {
      out.push(`${m.where} ${m.raw}: "${arg.value}" no es un valor válido de ${m.tool}.${arg.key}`);
    }
  }
  if (opts.requireAll) {
    const required = [
      ...Object.entries(shape).filter(([, field]) => !field.isOptional()).map(([key]) => key),
      ...(REQUIRED_BY_HANDLER[m.tool] ?? []),
    ];
    for (const key of required) {
      if (!named.has(key)) out.push(`${m.where} ${m.raw}: falta "${key}", que ${m.tool} exige`);
    }
  }
  return out;
}

describe('las llamadas que el catálogo narra existen tal como las narra', () => {
  it('el parser encuentra las menciones (si da cero, el test no está mirando nada)', () => {
    expect(catalogMentions().length).toBeGreaterThanOrEqual(19);
  });

  it('cada mención del catálogo nombra una tool, argumentos y valores que existen, sin omitir los obligatorios', async () => {
    const registry = await makeRegistry();
    const found = catalogMentions().flatMap((m) => problems(m, registry, { requireAll: true }));
    expect(found).toEqual([]);
  });

  // Los literales de `next_actions` son una pista dentro de una respuesta que ya tiene
  // el contexto (el story_id, el flow_id): se les exige que lo que nombran exista, no
  // que repitan cada argumento obligatorio.
  it('cada literal con forma de llamada en next_actions nombra una tool y argumentos que existen', async () => {
    const registry = await makeRegistry();
    const literals = nextActionLiterals();
    expect(literals.length).toBeGreaterThan(0);
    const found = literals.flatMap((m) => problems(m, registry, { requireAll: false }));
    expect(found).toEqual([]);
  });

  it('cada next_action declarada en el frontmatter de una fase nombra una tool y argumentos que existen', async () => {
    const catalog = await Catalog.load(CATALOG_ROOT);
    const registry = await makeRegistry();
    const found: string[] = [];
    for (const { role, phases } of catalog.listRoles()) {
      for (const phase of phases) {
        for (const action of await catalog.getNextActions(role, phase)) {
          const where = `${role}/${phase} next_actions`;
          // Un nombre pelado es una mención sin argumentos.
          const [mention] = parseToolMentions(action);
          const m = mention ?? { tool: action, args: [], raw: action };
          found.push(...problems({ ...m, where }, registry, { requireAll: false }));
        }
      }
    }
    expect(found).toEqual([]);
  });
});

/**
 * La otra mitad: que la secuencia correcta tenga dónde vivir. `get_role_prompt` la lee del
 * frontmatter de la fase en vez de tener una tabla horneada que cubría 2 fases de 10.
 */
describe('get_role_prompt devuelve la secuencia que la fase declara', () => {
  it('toda fase declara su secuencia, y get_role_prompt la devuelve tal cual', async () => {
    const catalog = await Catalog.load(CATALOG_ROOT);
    const tool = (await makeRegistry()).get('get_role_prompt')!;
    for (const { role, phases } of catalog.listRoles()) {
      for (const phase of phases) {
        const declared = await catalog.getNextActions(role, phase);
        expect(declared, `${role}/${phase} no declara next_actions`).not.toEqual([]);
        const res = (await tool.handler({ role, phase }, testCtx())) as { next_actions: string[] };
        expect(res.next_actions, `${role}/${phase}`).toEqual(declared);
      }
    }
  });
});
