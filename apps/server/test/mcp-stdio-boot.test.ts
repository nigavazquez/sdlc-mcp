import { describe, expect, it } from 'vitest';
import { assertStdioBoot, stdioLocalModeNotice, STDIO_DB_OPT_IN } from '../src/mcp-stdio.js';

/**
 * stdio construye el TenantCtx entero desde variables de entorno, sin verificar nada.
 * Contra el store in-memory es aceptable; contra una base compartida es acceso total sin
 * credenciales. La guarda de arranque cierra ese caso.
 */
describe('assertStdioBoot', () => {
  it('sin DATABASE_URL → arranca (store in-memory)', () => {
    expect(assertStdioBoot({})).toBeNull();
    expect(assertStdioBoot({ DATABASE_URL: '' })).toBeNull();
    expect(assertStdioBoot({ DATABASE_URL: '   ' })).toBeNull();
  });

  it('con DATABASE_URL y sin opt-in → rechaza', () => {
    const err = assertStdioBoot({ DATABASE_URL: 'postgres://sdlc:sdlc@shared:5432/sdlc' });
    expect(err).toBeTypeOf('string');
    expect(err).toContain('DATABASE_URL');
  });

  it('el rechazo nombra las tres salidas ejecutables', () => {
    const err = assertStdioBoot({ DATABASE_URL: 'postgres://x' })!;
    // 1. correrlo bien: sin DATABASE_URL, in-memory
    expect(err).toContain('in-memory');
    // 2. base compartida de verdad: HTTP + OAuth, no stdio
    expect(err).toMatch(/HTTP.*OAuth/s);
    // 3. si de verdad querés apuntar a una base: qué setear
    expect(err).toContain(`${STDIO_DB_OPT_IN}=true`);
  });

  it('el rechazo no filtra la connection string', () => {
    const err = assertStdioBoot({ DATABASE_URL: 'postgres://user:s3cr3t@host:5432/db' })!;
    expect(err).not.toContain('s3cr3t');
  });

  it('con opt-in explícito ("true"/"1") → arranca', () => {
    expect(assertStdioBoot({ DATABASE_URL: 'postgres://x', [STDIO_DB_OPT_IN]: 'true' })).toBeNull();
    expect(assertStdioBoot({ DATABASE_URL: 'postgres://x', [STDIO_DB_OPT_IN]: 'TRUE' })).toBeNull();
    expect(assertStdioBoot({ DATABASE_URL: 'postgres://x', [STDIO_DB_OPT_IN]: '1' })).toBeNull();
  });

  it('un opt-in que no es true/1 no alcanza', () => {
    for (const raw of ['false', '0', 'yes', 'sí', '']) {
      expect(
        assertStdioBoot({ DATABASE_URL: 'postgres://x', [STDIO_DB_OPT_IN]: raw }),
        `valor "${raw}"`,
      ).toBeTypeOf('string');
    }
  });

  it('el rechazo no vende el modo local como camino completo', () => {
    const err = assertStdioBoot({ DATABASE_URL: 'postgres://x' })!;
    // La salida 1 lleva su propia advertencia: sin base no hay integraciones.
    expect(err).toMatch(/no llega al final del ciclo/i);
    expect(err).toContain('request_code_review');
    expect(err).toContain('submit_review_outcome');
  });
});

/**
 * La tanda dejó dos cosas que se contradecían: `assertStdioBoot` empuja al modo
 * local, pero las tools de review rechazan el adapter no-op y en modo local no
 * hay forma de configurar uno (el config store in-memory arranca vacío y el seed
 * sólo escribe en Postgres). El rechazo del no-op es correcto; lo que faltaba era
 * decirlo en el arranque.
 */
describe('stdioLocalModeNotice', () => {
  it('sin DATABASE_URL → avisa que el ciclo no llega al final', () => {
    const notice = stdioLocalModeNotice({})!;
    expect(notice).toBeTypeOf('string');
    expect(notice).toMatch(/no llega hasta el final/i);
  });

  it('nombra las tres tools que van a fallar siempre en modo local', () => {
    const notice = stdioLocalModeNotice({})!;
    for (const tool of ['request_code_review', 'submit_review_outcome', 'submit_adr']) {
      expect(notice, `tool ${tool}`).toContain(tool);
    }
  });

  it('nombra la salida ejecutable: qué configurar y dónde', () => {
    const notice = stdioLocalModeNotice({})!;
    expect(notice).toContain('pr_provider');
    expect(notice).toContain('doc_store');
    expect(notice).toContain('tenant_integrations');
    // Y por dónde cargarlo, que es lo que desbloquea de verdad.
    expect(notice).toMatch(/admin|seed:integrations/);
  });

  it('con DATABASE_URL → no avisa (hay dónde configurar integraciones)', () => {
    expect(stdioLocalModeNotice({ DATABASE_URL: 'postgres://x' })).toBeNull();
  });

  it('un DATABASE_URL en blanco sigue siendo modo local', () => {
    expect(stdioLocalModeNotice({ DATABASE_URL: '   ' })).toBeTypeOf('string');
  });
});
