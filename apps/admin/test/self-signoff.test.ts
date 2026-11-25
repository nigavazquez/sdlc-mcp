import { describe, expect, it } from 'vitest';
import { selfSignoffOf, toggleSelfSignoff } from '../src/self-signoff';

// Historia #22 (épica #20). Seam: `toggleSelfSignoff`, lo que hace el panel al cambiar el
// toggle "QA y review propios": mostrar, guardar y, si falla, volver atrás.

describe('toggleSelfSignoff', () => {
  it('guarda el valor nuevo y muestra lo que devolvió el server', async () => {
    const shown: boolean[] = [];
    const sent: boolean[] = [];
    const out = await toggleSelfSignoff(
      true,
      false,
      async (v) => {
        sent.push(v);
        return { self_signoff: v };
      },
      (v) => shown.push(v),
    );

    expect(sent).toEqual([false]);
    expect(out).toEqual({ value: false, error: null });
    expect(shown.at(-1)).toBe(false);
  });

  it('si el server falla, vuelve al valor anterior y devuelve el error', async () => {
    const shown: boolean[] = [];
    const out = await toggleSelfSignoff(
      true,
      false,
      async () => {
        throw new Error('workspace not found');
      },
      (v) => shown.push(v),
    );

    expect(out).toEqual({ value: true, error: 'workspace not found' });
    expect(shown).toEqual([false, true]);
  });

  it('un error sin mensaje igual se informa', async () => {
    const out = await toggleSelfSignoff(
      false,
      true,
      async () => {
        throw new Error('');
      },
      () => {},
    );
    expect(out).toEqual({ value: false, error: 'error' });
  });
});

describe('selfSignoffOf', () => {
  it('sin el campo vale el default (permitido)', () => {
    expect(selfSignoffOf({})).toBe(true);
    expect(selfSignoffOf({ self_signoff: false })).toBe(false);
  });
});
