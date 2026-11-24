/**
 * Seam bajo test: `renderSelfSignoffComment` y `selfSignoffAnnotation`, funciones
 * puras. Se observa el markdown que sale (lo que ve la persona en GitHub) y el
 * marcador que usa el adapter para no duplicar el comentario.
 */
import { describe, expect, it } from 'vitest';
import { findAnnotationMarker } from '@sdlc/adapters-contracts';
import {
  renderSelfSignoffComment,
  selfSignoffAnnotation,
  SELF_SIGNOFF_LABELS,
  type SelfSignoffCommentInput,
} from '../src/signoff/self-signoff-comment.js';

const INPUT: SelfSignoffCommentInput = {
  kind: 'qa',
  signer: 'vazquez.n.g@gmail.com',
  story: {
    story_id: 'default:sdlc-mcp:self-qa-single-member::24',
    external_id: '24',
    title: 'Anotación en GitHub',
    acceptance_criteria: ['La etiqueta queda puesta', 'El comentario no se duplica'],
  },
  flow_id: 'default:sdlc-mcp:self-qa-single-member',
  signed_at: '2026-11-24T15:00:00Z',
  envelope: {
    test_command: 'pnpm --filter @sdlc/server test',
    test_exit_code: 0,
    test_output_hash: `sha256:${'a'.repeat(64)}`,
  },
  results: [
    {
      case_id: 'AC-1',
      criterion: 'La etiqueta queda puesta',
      status: 'passed',
      evidence_url: 'https://github.com/nigavazquez/sdlc-mcp/actions/runs/1',
      screenshots: ['https://user-images.githubusercontent.com/1/etiqueta.png'],
    },
    {
      case_id: 'AC-2',
      criterion: 'El comentario | no se duplica',
      status: 'failed',
      evidence_url: 'https://github.com/nigavazquez/sdlc-mcp/actions/runs/2',
      notes: 'quedaron\ndos comentarios',
    },
  ],
};

describe('renderSelfSignoffComment', () => {
  it('titula según el tipo de firma y nombra al firmante', () => {
    expect(renderSelfSignoffComment(INPUT)).toContain(
      '### QA propio — firmado por vazquez.n.g@gmail.com',
    );
    expect(renderSelfSignoffComment({ ...INPUT, kind: 'review' })).toContain(
      '### Review propio — firmado por vazquez.n.g@gmail.com',
    );
  });

  it('incluye story, flow, fecha y el envelope de la corrida', () => {
    const md = renderSelfSignoffComment(INPUT);
    expect(md).toContain('Story #24');
    expect(md).toContain('Anotación en GitHub');
    expect(md).toContain('default:sdlc-mcp:self-qa-single-member');
    expect(md).toContain('2026-11-24T15:00:00Z');
    expect(md).toContain('`pnpm --filter @sdlc/server test`');
    expect(md).toContain('exit 0');
    expect(md).toContain(`sha256:${'a'.repeat(64)}`);
  });

  it('arma una fila por criterio con resultado y link de evidencia', () => {
    const md = renderSelfSignoffComment(INPUT);
    expect(md).toContain('| Criterio | Resultado | Evidencia |');
    expect(md).toContain(
      '| AC-1 — La etiqueta queda puesta | passed | [evidencia](https://github.com/nigavazquez/sdlc-mcp/actions/runs/1) |',
    );
  });

  it('escapa los pipes y saltos de línea que romperían la tabla', () => {
    const md = renderSelfSignoffComment(INPUT);
    const row = md.split('\n').find((l) => l.startsWith('| AC-2'));
    expect(row).toContain('El comentario \\| no se duplica');
    expect(row).toContain('quedaron dos comentarios');
  });

  it('muestra los screenshots como imágenes', () => {
    const md = renderSelfSignoffComment(INPUT);
    expect(md).toContain('![AC-1](https://user-images.githubusercontent.com/1/etiqueta.png)');
  });

  it('un caso sin evidencia lo dice en vez de dejar la celda vacía', () => {
    const md = renderSelfSignoffComment({
      ...INPUT,
      results: [{ case_id: 'AC-1', status: 'passed' }],
    });
    expect(md).toContain('| AC-1 | passed | sin evidencia |');
  });

  it('sin envelope (review) no inventa la línea del comando', () => {
    const md = renderSelfSignoffComment({ ...INPUT, kind: 'review', envelope: undefined });
    expect(md).not.toContain('Comando:');
  });

  it('lleva un marcador oculto con el story_id y el tipo de firma', () => {
    const qa = findAnnotationMarker(renderSelfSignoffComment(INPUT));
    const review = findAnnotationMarker(renderSelfSignoffComment({ ...INPUT, kind: 'review' }));
    expect(qa).toBeDefined();
    expect(qa).toContain(encodeURIComponent(INPUT.story.story_id));
    // QA y review del mismo story son comentarios distintos: no se pisan.
    expect(review).toBeDefined();
    expect(review).not.toBe(qa);
    // Reintentos de la misma firma comparten el marcador aunque cambie el detalle.
    const again = findAnnotationMarker(
      renderSelfSignoffComment({ ...INPUT, signed_at: '2026-11-25T10:00:00Z' }),
    );
    expect(again).toBe(qa);
  });

  it('falla si no hay resultados: un comentario sin criterios no prueba nada', () => {
    expect(() => renderSelfSignoffComment({ ...INPUT, results: [] })).toThrow(/resultados/);
  });
});

describe('selfSignoffAnnotation', () => {
  it('usa la etiqueta del tipo de firma y el comentario renderizado', () => {
    expect(selfSignoffAnnotation(INPUT)).toEqual({
      labels: ['sdlc:qa-propio'],
      body: renderSelfSignoffComment(INPUT),
    });
    expect(selfSignoffAnnotation({ ...INPUT, kind: 'review' }).labels).toEqual([
      'sdlc:review-propio',
    ]);
    expect(SELF_SIGNOFF_LABELS).toEqual({ qa: 'sdlc:qa-propio', review: 'sdlc:review-propio' });
  });
});
