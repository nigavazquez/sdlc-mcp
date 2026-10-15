import { describe, expect, it } from 'vitest';
import { proposeBreakdown } from '../src/shaping/propose.js';

const RFC = `
# RFC: Pago en cuotas

## Context
ctx

## Goals
- Pagos en 3/6/12 cuotas.
- Idempotencia end-to-end.

## Design

### Data model
Tabla payments_plans.

### API / Contracts
POST /v1/checkout/plans.
`;

describe('proposeBreakdown', () => {
  it('builds an epic from the flow title and a story per Goal + Design subsection', () => {
    const b = proposeBreakdown(RFC, 'Pago en cuotas', '/docs/rfc/cuotas.md');
    expect(b.epic.title).toBe('Pago en cuotas');
    expect(b.epic.description).toContain('/docs/rfc/cuotas.md');
    // 2 goals + 2 design subsections = 4 stories
    expect(b.stories.length).toBe(4);
    const titles = b.stories.map((s) => s.title);
    expect(titles.some((t) => t.includes('Data model'))).toBe(true);
    expect(titles.some((t) => t.includes('API / Contracts'))).toBe(true);
  });

  it('is deterministic: same input → same output', () => {
    const a = proposeBreakdown(RFC, 'X', 'ref');
    const b = proposeBreakdown(RFC, 'X', 'ref');
    expect(a).toEqual(b);
  });

  it('always produces at least one story even with a minimal RFC', () => {
    const b = proposeBreakdown('# RFC\n\n## Context\nonly context', 'Title', 'ref');
    expect(b.stories.length).toBeGreaterThanOrEqual(1);
  });
});
