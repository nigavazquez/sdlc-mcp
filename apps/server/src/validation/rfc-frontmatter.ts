import matter from 'gray-matter';
import { ComponentKind, type FlowComponent, type ValidationIssue } from '@sdlc/core';
// La MISMA función que usa el gate de code review para decidir si un repo
// declarado es comparable contra el PR. Acá se usa como señal temprana —warning,
// no error—, porque el requisito es del gate y no del documento. Ver `repoIssue`.
import { isComparableRepo } from '../repos/identity.js';

export type ArchitectureMode = 'new' | 'reuse' | 'hybrid';
export type CodebaseStatus = 'greenfield' | 'existing';

/** Component entry as declared in the RFC frontmatter — same shape the flow persists. */
export type RfcComponent = FlowComponent;

export interface RfcFrontmatter {
  architecture_mode?: ArchitectureMode;
  codebase_status?: CodebaseStatus;
  existing_repo?: string;
  /**
   * Component registry: the repos (app + infra/Terraform) the epic touches.
   * When omitted but `existing_repo` is present, a single app component is
   * synthesized for backward compatibility.
   */
  components?: RfcComponent[];
}

export interface ParsedRfcFrontmatter {
  /** Parsed values when known to be valid. Missing/invalid fields are absent. */
  frontmatter: RfcFrontmatter;
  /** Markdown body (frontmatter stripped). Falls back to original input on parse failure. */
  body: string;
  /** Validation issues — empty on full success. */
  issues: ValidationIssue[];
}

const ARCH_VALUES: ReadonlySet<string> = new Set(['new', 'reuse', 'hybrid']);
const CODEBASE_VALUES: ReadonlySet<string> = new Set(['greenfield', 'existing']);
const COMPONENT_KINDS: ReadonlySet<string> = new Set(ComponentKind.options);

/** Derives a component name from a repo URL/path (last segment, ".git" stripped). */
export function componentNameFromRepo(repo: string): string {
  const trimmed = repo.replace(/\/+$/, '').replace(/\.git$/i, '');
  const segment = trimmed.split(/[/:]/).filter(Boolean).pop();
  return segment && segment.length > 0 ? segment : 'app';
}

/** Problema con un repo declarado: `error` invalida el RFC, `warning` sólo avisa. */
interface RepoIssue {
  severity: 'error' | 'warning';
  message: string;
}

/**
 * Revisa un repo declarado en el frontmatter.
 *
 * Dos problemas de peso muy distinto, y por eso dos severidades:
 *
 *  - **Placeholder sin reemplazar** (`<url o path>`): error. El documento quedó a
 *    medio llenar; no hay lectura en la que eso sea un repo.
 *  - **Repo que el gate de review no sabe interpretar**: warning. El gate compara
 *    el repo declarado contra el del PR y falla cerrado si no puede leer alguno de
 *    los dos lados, pero eso vale sólo para GitHub y Azure DevOps, que son los
 *    únicos `pr_provider` que existen. Cuando esto era error, GitLab, Bitbucket,
 *    un path absoluto o una descripción en prosa **bloqueaban `submit_rfc`
 *    entero**: un equipo en GitLab no podía escribir un RFC aunque usara sólo la
 *    mitad PRD/RFC/shaping y nunca tocara un `pr_provider`. Era un requisito del
 *    *gate de review* metido dentro del *validador de documentos*, extendido a
 *    fases que no lo necesitan. El chequeo duro vive donde el flow se compromete a
 *    producir PRs: `create_stories` exige que toda story nazca con repo declarado,
 *    y `request_code_review` / `submit_review_outcome` fallan cerrado si no pueden
 *    verificarlo. Acá queda la señal temprana, que es lo útil sin ser bloqueante.
 *
 * Devuelve el problema, o `null` si el repo está bien.
 */
export function repoIssue(repo: string): RepoIssue | null {
  if (/<[^>]+>/.test(repo)) {
    return {
      severity: 'error',
      message: 'still contains a template placeholder ("<...>"). Replace it with a real URL or path',
    };
  }
  if (!isComparableRepo(repo)) {
    return {
      severity: 'warning',
      message:
        `is not a repo the code review gate can verify a PR against (got ${JSON.stringify(repo)}) — ` +
        'the gate only knows how to verify GitHub and Azure DevOps repos, so on this one ' +
        'request_code_review and submit_review_outcome will refuse to sign. The RFC is accepted anyway: ' +
        'if this flow never opens PRs through the server, nothing else changes. To get the gate working, ' +
        'declare a GitHub repo (https://github.com/<owner>/<repo>, git@github.com:<owner>/<repo>.git or ' +
        'exactly <owner>/<repo>) or an Azure DevOps one (https://dev.azure.com/<org>/<project>/_git/<repo>) ' +
        'and resubmit with submit_rfc. A URL pointing at a branch, file, query or fragment inside the repo ' +
        'is fine — the extra path is ignored',
    };
  }
  return null;
}

/** Parses + validates the optional `components` array, pushing issues as needed. */
export function parseComponents(raw: unknown, issues: ValidationIssue[]): RfcComponent[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    issues.push({
      severity: 'error',
      section: 'frontmatter',
      message: '"components" must be a list of { name, kind, repo } objects.',
    });
    return undefined;
  }

  const components: RfcComponent[] = [];
  const seen = new Set<string>();
  raw.forEach((item, i) => {
    if (typeof item !== 'object' || item === null) {
      issues.push({
        severity: 'error',
        section: 'frontmatter',
        message: `components[${i}] must be an object with name, kind and repo.`,
      });
      return;
    }
    const c = item as Record<string, unknown>;
    const name = typeof c.name === 'string' ? c.name.trim() : '';
    const kind = typeof c.kind === 'string' ? c.kind.trim() : '';
    const repo = typeof c.repo === 'string' ? c.repo.trim() : '';
    let valid = true;

    if (!name) {
      issues.push({ severity: 'error', section: 'frontmatter', message: `components[${i}].name is required.` });
      valid = false;
    } else if (seen.has(name)) {
      issues.push({ severity: 'error', section: 'frontmatter', message: `components[${i}].name "${name}" is duplicated; names must be unique within the flow.` });
      valid = false;
    }
    if (!COMPONENT_KINDS.has(kind)) {
      issues.push({ severity: 'error', section: 'frontmatter', message: `components[${i}].kind must be one of: ${ComponentKind.options.join(', ')} (got ${JSON.stringify(c.kind)}).` });
      valid = false;
    }
    if (!repo) {
      issues.push({ severity: 'error', section: 'frontmatter', message: `components[${i}].repo is required.` });
      valid = false;
    } else {
      const problema = repoIssue(repo);
      if (problema) {
        issues.push({
          severity: problema.severity,
          section: 'frontmatter',
          message: `components[${i}].repo ${problema.message}.`,
        });
        // Un warning avisa pero no descarta el componente: descartarlo dejaría el
        // registro vacío y con él el flow sin repos, que es peor que el aviso.
        if (problema.severity === 'error') valid = false;
      }
    }

    if (valid) {
      seen.add(name);
      const repoProject = typeof c.repo_project === 'string' && c.repo_project.trim().length > 0 ? c.repo_project.trim() : undefined;
      components.push({ name, kind: kind as ComponentKind, repo, ...(repoProject ? { repo_project: repoProject } : {}) });
    }
  });

  return components;
}

export function parseRfcFrontmatter(markdown: string): ParsedRfcFrontmatter {
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
      message: `Failed to parse YAML frontmatter: ${(err as Error).message}`,
    });
    return { frontmatter: {}, body, issues };
  }

  if (!data || Object.keys(data).length === 0) {
    issues.push({
      severity: 'error',
      section: 'frontmatter',
      message:
        'Missing YAML frontmatter. The RFC must start with a "---" block declaring architecture_mode and codebase_status.',
    });
    return { frontmatter: {}, body, issues };
  }

  const fm: RfcFrontmatter = {};

  const mode = data.architecture_mode;
  if (typeof mode !== 'string' || !ARCH_VALUES.has(mode)) {
    issues.push({
      severity: 'error',
      section: 'frontmatter',
      message: `Field "architecture_mode" must be one of: new, reuse, hybrid (got ${JSON.stringify(mode)}).`,
    });
  } else {
    fm.architecture_mode = mode as ArchitectureMode;
  }

  const status = data.codebase_status;
  if (typeof status !== 'string' || !CODEBASE_VALUES.has(status)) {
    issues.push({
      severity: 'error',
      section: 'frontmatter',
      message: `Field "codebase_status" must be one of: greenfield, existing (got ${JSON.stringify(status)}).`,
    });
  } else {
    fm.codebase_status = status as CodebaseStatus;
  }

  const repo = data.existing_repo;
  if (repo !== undefined) {
    if (typeof repo !== 'string' || repo.trim().length === 0) {
      issues.push({
        severity: 'error',
        section: 'frontmatter',
        message: '"existing_repo" must be a non-empty string when provided.',
      });
    } else {
      const problema = repoIssue(repo.trim());
      if (problema) {
        issues.push({
          severity: problema.severity,
          section: 'frontmatter',
          message: `"existing_repo" ${problema.message}.`,
        });
      }
      // Un warning no descarta el valor: el repo se persiste igual y el flow sigue
      // teniendo declarado contra qué trabajar. Sólo un error lo deja afuera.
      if (!problema || problema.severity === 'warning') fm.existing_repo = repo.trim();
    }
  }

  const components = parseComponents(data.components, issues);
  if (components && components.length > 0) {
    fm.components = components;
  } else if (fm.existing_repo) {
    // Backward compat: single-repo flow → synthesize one app component.
    fm.components = [{ name: componentNameFromRepo(fm.existing_repo), kind: 'app', repo: fm.existing_repo }];
  }

  // "Falta el repo" sólo si el autor no declaró ninguno de los dos campos.
  //
  // Antes esto se encadenaba: cuando `existing_repo` no pasaba su propia
  // validación no se seteaba `fm.existing_repo`, así que el RFC recibía dos
  // errores y el segundo era falso —"«existing_repo» es requerido" cuando el
  // usuario sí lo había puesto—. Un error que le dice al autor que agregue algo
  // que ya está no es un mensaje pobre: es una instrucción incorrecta. Si el campo
  // está declarado, el error específico de arriba ya dice qué corregir.
  const repoDeclarado = data.existing_repo !== undefined || data.components !== undefined;
  if (
    fm.codebase_status === 'existing' &&
    !fm.existing_repo &&
    !(fm.components && fm.components.length > 0) &&
    !repoDeclarado
  ) {
    issues.push({
      severity: 'error',
      section: 'frontmatter',
      message:
        '"existing_repo" (or at least one entry in "components") is required when codebase_status="existing".',
    });
  }

  return { frontmatter: fm, body, issues };
}
