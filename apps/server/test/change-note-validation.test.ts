import { describe, expect, it } from 'vitest';
import { REPRO_MAX_LENGTH, validateChangeNote } from '../src/validation/change-note.js';
import { NOTA_OK, conRepro } from './helpers/change-note.js';

/** Saca una sección de la nota, para probar que su ausencia es error. */
function sinSeccion(markdown: string, heading: string): string {
  const lines = markdown.split('\n');
  const start = lines.findIndex((l) => l.trim() === `## ${heading}`);
  if (start === -1) throw new Error(`La nota de prueba no tiene la sección "${heading}"`);
  const rest = lines.slice(start + 1).findIndex((l) => l.startsWith('## '));
  const end = rest === -1 ? lines.length : start + 1 + rest;
  return [...lines.slice(0, start), ...lines.slice(end)].join('\n');
}

describe('validateChangeNote', () => {
  it('una nota completa valida y sintetiza el componente desde el repo', () => {
    const res = validateChangeNote(NOTA_OK);

    expect(res.ok).toBe(true);
    expect(res.issues.filter((i) => i.severity === 'error')).toEqual([]);
    // El repo del frontmatter se convierte en el registro de componentes que
    // `create_stories` exige: 1 story = 1 repo = 1 PR.
    expect(res.components).toEqual([
      { name: 'sdlc-mcp', kind: 'app', repo: 'acme/sdlc-mcp' },
    ]);
  });

  it.each([
    ['Qué pasa', 'what'],
    ['Cómo lo sé', 'evidence'],
    ['Qué cambio', 'change'],
    ['Cómo se verifica', 'verification'],
  ])('sin la sección "%s" la nota se rechaza', (heading, sectionId) => {
    const res = validateChangeNote(sinSeccion(NOTA_OK, heading));

    expect(res.ok).toBe(false);
    expect(res.issues.some((i) => i.severity === 'error' && i.section === sectionId)).toBe(true);
  });

  it('acepta los encabezados en inglés', () => {
    const enIngles = NOTA_OK.replace('## Qué pasa', '## What happened')
      .replace('## Cómo lo sé', '## Evidence')
      .replace('## Qué cambio', '## Change')
      .replace('## Cómo se verifica', '## Verification');

    expect(validateChangeNote(enIngles).ok).toBe(true);
  });

  it('sin frontmatter se rechaza: sin repo, el gate de code review queda ciego', () => {
    // `submit_review_outcome` compara el PR contra el repo de la story. Es la única
    // parte del RFC que la nota no puede soltar.
    const res = validateChangeNote(NOTA_OK.replace(/^---\n[\s\S]*?\n---\n/, ''));

    expect(res.ok).toBe(false);
    expect(res.issues.some((i) => i.severity === 'error' && i.section === 'frontmatter')).toBe(true);
  });

  it('un repo que el gate de review no puede verificar es error, no warning', () => {
    const res = validateChangeNote(NOTA_OK.replace('acme/sdlc-mcp', 'el repo de siempre'));

    expect(res.ok).toBe(false);
    expect(res.issues.some((i) => i.severity === 'error' && i.section === 'frontmatter')).toBe(true);
  });

  it('un placeholder sin completar es error', () => {
    const res = validateChangeNote(NOTA_OK.replace('acme/sdlc-mcp', '<owner>/<repo>'));

    expect(res.ok).toBe(false);
  });

  it('un fix que toca dos repos declara components, igual que el RFC', () => {
    const dosRepos = NOTA_OK.replace(
      'repo: acme/sdlc-mcp',
      `components:
  - { name: api, kind: app, repo: acme/sdlc-mcp }
  - { name: infra, kind: infra, repo: acme/sdlc-infra }`,
    );

    const res = validateChangeNote(dosRepos);

    expect(res.ok).toBe(true);
    expect(res.components?.map((c) => c.name)).toEqual(['api', 'infra']);
  });
});

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

  it('un placeholder de template a mitad de comando tampoco valida', () => {
    expect(errores(conRepro("repro: 'pnpm test -t <nombre del test>'")).join()).toMatch(/placeholder/);
  });

  it('un no_repro con placeholder sin completar tampoco valida', () => {
    expect(errores(conRepro("no_repro: '<por qué>'")).join()).toMatch(/placeholder/);
  });

  it('el mensaje de placeholder cita el fragmento que matcheó', () => {
    expect(errores(conRepro("repro: '<comando que falla hoy>'")).join()).toContain(
      '<comando que falla hoy>',
    );
    expect(errores(conRepro("repro: 'pnpm test -t <nombre del test>'")).join()).toContain(
      '<nombre del test>',
    );
    expect(errores(conRepro("no_repro: '<por qué>'")).join()).toContain('<por qué>');
  });

  it('una redirección de shell no es un placeholder', () => {
    const res = validateChangeNote(conRepro("repro: 'mysql -u root < dump.sql > out.log'"));
    expect(res.ok).toBe(true);
    expect(res.repro).toEqual({ kind: 'repro', value: 'mysql -u root < dump.sql > out.log' });
  });

  it('una sustitución de proceso no es un placeholder', () => {
    const res = validateChangeNote(conRepro("repro: 'diff <(pnpm test) expected.txt'"));
    expect(res.ok).toBe(true);
    expect(res.repro).toEqual({ kind: 'repro', value: 'diff <(pnpm test) expected.txt' });
  });

  it.each([
    ['redirección de entrada de un comando real', "repro: 'sort <in.txt 2>err.log'"],
    ['redirección de entrada con stderr', "repro: 'pnpm test <fixture.json 2>&1'"],
    ['una etiqueta HTML de una sola palabra', 'repro: \'grep "<title>" out.html\''],
    [
      'una etiqueta HTML de una sola palabra dentro de un pipe',
      "repro: 'echo \"<script>alert(1)</script>\" | node x'",
    ],
  ])('un comando real no es un placeholder aunque tenga "<…>" (%s)', (_caso, linea) => {
    const res = validateChangeNote(conRepro(linea));
    expect(res.ok).toBe(true);
  });

  it('un no_repro que menciona un tipo genérico no es un placeholder', () => {
    const res = validateChangeNote(conRepro("no_repro: 'falla con Array<string> vacío'"));
    expect(res.ok).toBe(true);
    expect(res.repro).toEqual({ kind: 'no_repro', value: 'falla con Array<string> vacío' });
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
});

/** Los warnings de la validación, para buscar el de clave desconocida. */
const warnings = (markdown: string) =>
  validateChangeNote(markdown)
    .issues.filter((i) => i.severity === 'warning')
    .map((i) => i.message);

describe('validateChangeNote — claves de frontmatter desconocidas', () => {
  it('una comilla simple sin duplicar dentro del comando trunca el valor, pero avisa con warning y no rompe la nota', () => {
    // gray-matter parsea esto sin error a { repro: 'pnpm test -t ', claim: "x''" }: el
    // repro queda truncado y "claim" es la clave fantasma que quedó del corte.
    const res = validateChangeNote(conRepro("repro: 'pnpm test -t 'claim: x''"));

    expect(res.ok).toBe(true);
    expect(warnings(conRepro("repro: 'pnpm test -t 'claim: x''")).some((m) => /"claim"/.test(m))).toBe(
      true,
    );
  });

  it('una nota con repro y no-repro (con guion) avisa con warning por la clave sobrante', () => {
    const msgs = warnings(conRepro("repro: 'pnpm test'\nno-repro: no se pudo"));
    expect(msgs.some((m) => /"no-repro"/.test(m))).toBe(true);
  });

  it('NOTA_OK no tiene warnings', () => {
    expect(warnings(NOTA_OK)).toEqual([]);
  });

  it('una clave parecida que ya generó el error de "¿quisiste decir…?" no se reporta dos veces', () => {
    const msgs = warnings(conRepro('no-repro: no se pudo'));
    expect(msgs.some((m) => /"no-repro"/.test(m))).toBe(false);
  });
});
