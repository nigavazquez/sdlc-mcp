import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractGateLease } from '../src/gate/claim-response.js';

// Evento real capturado con Claude Code 2.1.308 (spike de la historia #6): para una
// tool MCP, `tool_response` es el array de bloques `content` del resultado, con la
// respuesta de sdlc-mcp serializada en un bloque `text`. No es un objeto.
const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/post-tool-use-claim-story.json', import.meta.url), 'utf8'),
) as { tool_response: unknown };

const textBlock = (body: unknown) => [{ type: 'text', text: JSON.stringify(body) }];

describe('extractGateLease', () => {
  it('saca el lease del tool_response real de un claim_story ok', () => {
    expect(extractGateLease(fixture.tool_response)).toEqual({
      lease_id: 'gl_spike',
      expires_at: '2026-12-01T00:00:00.000Z',
    });
  });

  it('devuelve null si claim_story respondió ok:false', () => {
    // Claude Code no dispara PostToolUse cuando el server marca isError, pero el gate
    // no se apoya en eso: un rechazo nunca abre el gate.
    expect(extractGateLease(textBlock({ ok: false, error: 'Unknown story: x' }))).toBeNull();
  });

  it('devuelve null si la respuesta ok no trae gate_lease', () => {
    expect(extractGateLease(textBlock({ ok: true, data: { story: {} } }))).toBeNull();
  });

  it('devuelve null con un gate_lease incompleto', () => {
    expect(
      extractGateLease(textBlock({ ok: true, data: { gate_lease: { lease_id: 'gl_x' } } })),
    ).toBeNull();
  });

  it('devuelve null si tool_response no tiene la forma de content blocks', () => {
    expect(
      extractGateLease({ ok: true, data: { gate_lease: { lease_id: 'a', expires_at: 'b' } } }),
    ).toBeNull();
    expect(extractGateLease([{ type: 'text', text: 'no es json' }])).toBeNull();
    expect(extractGateLease(undefined)).toBeNull();
  });
});
