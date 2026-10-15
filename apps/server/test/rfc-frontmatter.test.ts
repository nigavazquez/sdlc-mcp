import { describe, expect, it } from 'vitest';
import { parseRfcFrontmatter } from '../src/validation/rfc-frontmatter.js';

describe('parseRfcFrontmatter', () => {
  it('parses a valid frontmatter block', () => {
    const md = `---
architecture_mode: reuse
codebase_status: existing
existing_repo: https://github.com/acme/repo
---

# RFC body`;
    const result = parseRfcFrontmatter(md);
    expect(result.issues).toEqual([]);
    expect(result.frontmatter.architecture_mode).toBe('reuse');
    expect(result.frontmatter.codebase_status).toBe('existing');
    expect(result.frontmatter.existing_repo).toBe('https://github.com/acme/repo');
    expect(result.body.trim().startsWith('# RFC body')).toBe(true);
  });

  it('reports missing frontmatter', () => {
    const result = parseRfcFrontmatter('# RFC without frontmatter\n\nBody.');
    expect(result.issues.some((i) => i.message.includes('Missing YAML frontmatter'))).toBe(true);
  });

  it('reports invalid architecture_mode', () => {
    const md = `---
architecture_mode: weird
codebase_status: greenfield
---

# RFC`;
    const result = parseRfcFrontmatter(md);
    expect(result.issues.some((i) => i.message.includes('architecture_mode'))).toBe(true);
    expect(result.frontmatter.architecture_mode).toBeUndefined();
  });

  it('requires existing_repo when codebase_status=existing', () => {
    const md = `---
architecture_mode: reuse
codebase_status: existing
---

# RFC`;
    const result = parseRfcFrontmatter(md);
    expect(result.issues.some((i) => i.message.includes('existing_repo'))).toBe(true);
  });

  it('rejects existing_repo that is still a template placeholder', () => {
    const md = `---
architecture_mode: reuse
codebase_status: existing
existing_repo: <url o path — requerido si codebase_status=existing>
---

# RFC`;
    const result = parseRfcFrontmatter(md);
    expect(result.issues.some((i) => i.message.includes('placeholder'))).toBe(true);
    expect(result.frontmatter.existing_repo).toBeUndefined();
  });

  it('allows omitting existing_repo when codebase_status=greenfield', () => {
    const md = `---
architecture_mode: new
codebase_status: greenfield
---

# RFC`;
    const result = parseRfcFrontmatter(md);
    expect(result.issues).toEqual([]);
    expect(result.frontmatter.codebase_status).toBe('greenfield');
    expect(result.frontmatter.existing_repo).toBeUndefined();
  });

  it('parses a multi-component (app + infra) registry', () => {
    const md = `---
architecture_mode: hybrid
codebase_status: existing
components:
  - name: checkout-api
    kind: app
    repo: https://github.com/acme/checkout
  - name: checkout-infra
    kind: infra
    repo: https://github.com/acme/platform-infra
    repo_project: platform
---

# RFC body`;
    const result = parseRfcFrontmatter(md);
    expect(result.issues).toEqual([]);
    expect(result.frontmatter.components).toEqual([
      { name: 'checkout-api', kind: 'app', repo: 'https://github.com/acme/checkout' },
      {
        name: 'checkout-infra',
        kind: 'infra',
        repo: 'https://github.com/acme/platform-infra',
        repo_project: 'platform',
      },
    ]);
  });

  it('synthesizes a single app component from existing_repo when components is absent', () => {
    const md = `---
architecture_mode: reuse
codebase_status: existing
existing_repo: https://github.com/acme/checkout.git
---

# RFC`;
    const result = parseRfcFrontmatter(md);
    expect(result.issues).toEqual([]);
    expect(result.frontmatter.components).toEqual([
      { name: 'checkout', kind: 'app', repo: 'https://github.com/acme/checkout.git' },
    ]);
  });

  it('strips ".git" from the synthesized name even with a trailing slash', () => {
    const md = `---
architecture_mode: reuse
codebase_status: existing
existing_repo: https://github.com/acme/checkout.git/
---

# RFC`;
    const result = parseRfcFrontmatter(md);
    expect(result.frontmatter.components?.[0]?.name).toBe('checkout');
  });

  it('rejects an invalid component kind', () => {
    const md = `---
architecture_mode: new
codebase_status: greenfield
components:
  - name: weird
    kind: database
    repo: https://github.com/acme/x
---

# RFC`;
    const result = parseRfcFrontmatter(md);
    expect(result.issues.some((i) => i.message.includes('kind'))).toBe(true);
  });

  it('rejects duplicate component names', () => {
    const md = `---
architecture_mode: new
codebase_status: greenfield
components:
  - name: dup
    kind: app
    repo: https://github.com/acme/a
  - name: dup
    kind: infra
    repo: https://github.com/acme/b
---

# RFC`;
    const result = parseRfcFrontmatter(md);
    expect(result.issues.some((i) => i.message.includes('duplicated'))).toBe(true);
  });

  it('accepts codebase_status=existing when components is provided without existing_repo', () => {
    const md = `---
architecture_mode: hybrid
codebase_status: existing
components:
  - name: svc
    kind: app
    repo: https://github.com/acme/svc
---

# RFC`;
    const result = parseRfcFrontmatter(md);
    expect(result.issues).toEqual([]);
    expect(result.frontmatter.components).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// E — el repo se revisa cuando el autor todavía tiene el RFC abierto, pero no lo
//     bloquea
//
// El gate de code review falla cerrado ante un repo que no sabe interpretar, y
// ese error aparecía semanas después, en request_code_review. La señal temprana
// se queda; lo que se fue es la severidad: era un requisito *del gate* metido en
// el *validador de documentos*, y le impedía escribir un RFC a cualquier equipo
// en GitLab o Bitbucket, incluso a uno que sólo usa PRD/RFC/shaping.
// ---------------------------------------------------------------------------

/** Arma un RFC mínimo con un `existing_repo` dado. */
function rfcConRepo(repo: string): string {
  return `---
architecture_mode: reuse
codebase_status: existing
existing_repo: ${repo}
---

# RFC body`;
}

/** Arma un RFC mínimo con un `components[0].repo` dado. */
function rfcConComponente(repo: string): string {
  return `---
architecture_mode: new
codebase_status: existing
components:
  - name: svc
    kind: app
    repo: ${repo}
---

# RFC body`;
}

describe('parseRfcFrontmatter — repos comparables por el gate de review', () => {
  const ACEPTADOS = [
    'https://github.com/acme/checkout',
    'https://github.com/acme/checkout.git',
    'https://github.com/acme/checkout/tree/main',
    'https://github.com/acme/checkout/blob/main/README.md',
    'https://github.com/acme/checkout?tab=readme',
    'https://github.com/acme/checkout#readme',
    'git@github.com:acme/checkout.git',
    'acme/checkout',
    'https://dev.azure.com/myorg/proj/_git/repo',
    'https://myorg.visualstudio.com/proj/_git/repo',
  ];

  it.each(ACEPTADOS)('existing_repo acepta %s', (repo) => {
    const result = parseRfcFrontmatter(rfcConRepo(repo));
    expect(result.issues).toEqual([]);
    expect(result.frontmatter.existing_repo).toBe(repo);
  });

  it.each(ACEPTADOS)('components[].repo acepta %s', (repo) => {
    const result = parseRfcFrontmatter(rfcConComponente(repo));
    expect(result.issues).toEqual([]);
    expect(result.frontmatter.components?.[0]?.repo).toBe(repo);
  });

  // Repos que el gate de review no sabe verificar. NO son errores: avisan y el
  // RFC sigue siendo válido. Incluyen los tres segmentos sin host, que antes se
  // truncaban en silencio a los dos primeros y pasaban como si nada.
  const ADVERTIDOS = [
    'checkout',                                 // nombre suelto: no comparable
    'https://gitlab.com/acme/checkout',         // GitLab
    'https://bitbucket.org/acme/checkout',      // Bitbucket
    'https://github.com.evil.io/acme/checkout', // host parecido, repo distinto
    'https://evil.com/acme/checkout',
    '/srv/repos/checkout',                      // path local
    'el monorepo de checkout',                  // texto descriptivo
    'monorepo/services/checkout',               // 3 segmentos sin host: se truncaba
    'internal-git/acme/checkout',               // idem, con pinta de host interno
  ];

  it.each(ADVERTIDOS)('existing_repo avisa por %s sin invalidar el RFC', (repo) => {
    const result = parseRfcFrontmatter(rfcConRepo(repo));
    const issue = result.issues.find((i) => i.message.includes('existing_repo'));
    expect(issue).toBeDefined();
    expect(issue!.severity).toBe('warning');
    expect(issue!.message).toMatch(/code review gate/);
    expect(issue!.message).toMatch(/GitHub and Azure DevOps/);
    // Ningún error: el RFC de un equipo en GitLab tiene que poder enviarse.
    expect(result.issues.filter((i) => i.severity === 'error')).toEqual([]);
    // Y el repo se persiste igual: el flow declara contra qué trabaja.
    expect(result.frontmatter.existing_repo).toBe(repo);
  });

  it.each(ADVERTIDOS)('components[].repo avisa por %s sin descartar el componente', (repo) => {
    const result = parseRfcFrontmatter(rfcConComponente(repo));
    const issue = result.issues.find((i) => i.message.includes('components[0].repo'));
    expect(issue).toBeDefined();
    expect(issue!.severity).toBe('warning');
    expect(result.issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(result.frontmatter.components).toEqual([{ name: 'svc', kind: 'app', repo }]);
  });

  it('el placeholder sí es error y tiene su propio mensaje, más específico', () => {
    const result = parseRfcFrontmatter(rfcConRepo('<url o path>'));
    const issue = result.issues.find((i) => i.message.includes('existing_repo'));
    expect(issue!.severity).toBe('error');
    expect(issue!.message).toMatch(/template placeholder/);
    expect(result.frontmatter.existing_repo).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// El segundo error, el falso: "existing_repo es requerido" cuando sí se puso
// ---------------------------------------------------------------------------

describe('parseRfcFrontmatter — no encadena un error falso sobre otro', () => {
  const REQUERIDO = /is required when codebase_status/;

  it('un existing_repo con placeholder da UN error, no dos', () => {
    const result = parseRfcFrontmatter(rfcConRepo('<url o path — requerido si codebase_status=existing>'));
    const errores = result.issues.filter((i) => i.severity === 'error');
    expect(errores).toHaveLength(1);
    expect(errores[0]!.message).toMatch(/template placeholder/);
    // El error falso: le pedía al autor que agregue un campo que ya había puesto.
    expect(result.issues.some((i) => REQUERIDO.test(i.message))).toBe(false);
  });

  it('un existing_repo vacío tampoco arrastra el "es requerido"', () => {
    const md = `---
architecture_mode: reuse
codebase_status: existing
existing_repo: ""
---

# RFC`;
    const result = parseRfcFrontmatter(md);
    expect(result.issues.some((i) => i.message.includes('non-empty string'))).toBe(true);
    expect(result.issues.some((i) => REQUERIDO.test(i.message))).toBe(false);
  });

  it('components declarado pero inválido tampoco lo arrastra', () => {
    const md = `---
architecture_mode: new
codebase_status: existing
components:
  - name: svc
    kind: database
    repo: https://github.com/acme/svc
---

# RFC`;
    const result = parseRfcFrontmatter(md);
    expect(result.issues.some((i) => i.message.includes('kind'))).toBe(true);
    expect(result.issues.some((i) => REQUERIDO.test(i.message))).toBe(false);
  });

  it('cuando de verdad no se declaró ninguno de los dos, el error sigue estando', () => {
    const md = `---
architecture_mode: reuse
codebase_status: existing
---

# RFC`;
    const result = parseRfcFrontmatter(md);
    expect(result.issues.some((i) => REQUERIDO.test(i.message))).toBe(true);
  });
});
