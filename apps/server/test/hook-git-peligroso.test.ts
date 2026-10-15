import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const HOOK = resolve(__dirname, '../../../.claude/hooks/block-dangerous-git.sh');

/**
 * El hook es el único freno del harness que no se puede ignorar: una instrucción en
 * CLAUDE.md la puede saltear el modelo, un `exit 2` no. Por eso vive con test — un
 * guardarraíl sin verificar es una promesa, que es exactamente lo que este repo
 * decidió no aceptar en ningún otro lado.
 *
 * El contrato de Claude Code: el hook recibe el tool call por stdin como JSON, sale 0
 * para dejar pasar y 2 para bloquear, con el motivo en stderr.
 */
function correr(comando: string) {
  const res = spawnSync(HOOK, {
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: comando } }),
    encoding: 'utf8',
  });
  return { code: res.status, stderr: res.stderr ?? '' };
}

describe('el hook bloquea lo que destruye trabajo sin rastro', () => {
  it.each([
    ['git push --force origin feat/x', 'reescribe la historia'],
    ['git push -f origin feat/x', 'reescribe la historia'],
    ['git reset --hard HEAD~1', 'sin guardarlos'],
    ['git clean -fd', 'no hay reflog'],
    ['git branch -D feat/x', 'sin verificar'],
    ['git checkout .', 'working tree'],
    ['git restore .', 'working tree'],
  ])('%s', (comando, motivo) => {
    const { code, stderr } = correr(comando);

    expect(code).toBe(2);
    // El mensaje explica por qué y ofrece la salida: un bloqueo sin alternativa
    // deja al agente reintentando lo mismo.
    expect(stderr).toContain(motivo);
  });

  it('push directo a main, que CONTRIBUTING ya prohibía por escrito', () => {
    const { code, stderr } = correr('git push origin main');

    expect(code).toBe(2);
    expect(stderr).toContain('nunca directo a main');
  });

  it('no se escapa por el formato del comando', () => {
    // `git   push   --force` con espacios de más es el mismo comando.
    expect(correr('git   push   --force  origin  x').code).toBe(2);
  });

  it('bloquea el segmento peligroso aunque venga encadenado con otros', () => {
    expect(correr('git status && git push --force origin x').code).toBe(2);
  });
});

/**
 * Los dos falsos positivos que el hook tuvo la primera vez que corrió de verdad: se
 * bloqueó a sí mismo dos veces seguidas, primero al abrir un PR y después al
 * intentar arreglarse.
 *
 * Están acá porque son el modo de falla que mata a un guardarraíl: si estorba el
 * trabajo real, alguien lo desactiva, y entonces deja de proteger de lo que sí
 * importa.
 */
describe('el hook no confunde mención con ejecución', () => {
  it('un comando compuesto donde el --force es de otro programa', () => {
    // El caso exacto: push normal encadenado con `turbo run build --force`. Mirando
    // el string entero hay un "git push" y un "--force", pero no juntos.
    expect(correr('git push -u origin feat/x && npx turbo run build --force').code).toBe(0);
  });

  it('un heredoc que menciona el comando peligroso como texto', () => {
    const conTexto = ['cat <<EOF', 'el PR explica por qué git push --force es peligroso', 'EOF'].join('\n');
    expect(correr(conTexto).code).toBe(0);
  });

  it('un archivo cuyo nombre contiene las palabras', () => {
    expect(correr('cat docs/por-que-no-git-push-force.md').code).toBe(0);
  });
});

describe('el hook deja pasar el trabajo normal', () => {
  it.each([
    'git push -u origin feat/track-liviano',
    'git status --short',
    'git branch -d feat/ya-mergeada',
    'git checkout feat/otra-rama',
    'git commit -m "feat: algo"',
    'git clean -n',
    'pnpm --filter @sdlc/server test',
    'npx turbo run typecheck test build --force',
  ])('%s', (comando) => {
    expect(correr(comando).code).toBe(0);
  });

  it('un tool call sin comando no rompe el hook', () => {
    const res = spawnSync(HOOK, { input: '{"tool_name":"Read"}', encoding: 'utf8' });
    expect(res.status).toBe(0);
  });
});
