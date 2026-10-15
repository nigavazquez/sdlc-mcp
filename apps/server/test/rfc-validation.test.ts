import { describe, expect, it } from 'vitest';
import { validateRfc } from '../src/validation/rfc.js';

const RFC_BODY = `
# RFC: Demo

## Context
Context paragraph.

## Architecture context

### Architecture mode
Reusamos la arquitectura existente del servicio checkout.

### Existing components reused
- packages/checkout/service
- packages/payments/api

### Codebase context
Monorepo TypeScript pnpm + turbo. Convenciones de naming kebab.

### Integration points
- Eventos checkout.order.created
- API REST /payments/installments

## Goals
- Cuotas 3/6/12 con p99 < 800ms.

## Non-goals
- Refinanciación.

## Design
Use processor X with idempotent webhook.
Add table payments_plans.
Add frontend selector.

## Risks
| r | t | p | i | m |
| webhook drop | integ | M | H | retry |
| migration | data | L | H | online |
| cost | perf | M | M | cap |

## Rollout
- Canary 5%.

## Rollback
1. Off feature flag.
2. Drain queue.
3. Revert migration.
`;

const VALID_FRONTMATTER = `---
architecture_mode: reuse
codebase_status: existing
existing_repo: https://github.com/acme/checkout
---
`;

describe('validateRfc — extended with architecture context', () => {
  it('passes when frontmatter + Architecture context are present and complete', () => {
    const md = VALID_FRONTMATTER + RFC_BODY;
    const result = validateRfc(md);
    expect(result.ok).toBe(true);
  });

  it('fails when frontmatter is missing', () => {
    const result = validateRfc(RFC_BODY);
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.message.includes('frontmatter'))).toBe(true);
  });

  it('fails when "## Architecture context" section is missing', () => {
    const md =
      VALID_FRONTMATTER +
      `
# RFC

## Context
ctx

## Goals
- g

## Non-goals
- n

## Design
d
d
d

## Risks
| r | t | p | i | m |
| a | b | M | H | x |
| a | b | M | H | x |
| a | b | M | H | x |

## Rollout
- a

## Rollback
1. a
`;
    const result = validateRfc(md);
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.section === 'architecture_context')).toBe(true);
  });

  it('requires Integration points when architecture_mode=reuse', () => {
    const md =
      VALID_FRONTMATTER +
      RFC_BODY.replace(
        /### Integration points\n[\s\S]*?(?=##\s)/,
        '### Integration points\n\n',
      );
    const result = validateRfc(md);
    expect(result.ok).toBe(false);
    expect(
      result.issues.some(
        (i) => i.section === 'integration_points' && i.severity === 'error',
      ),
    ).toBe(true);
  });

  it('requires Integration points when the RFC declares more than one component, even with architecture_mode=new', () => {
    const md =
      `---
architecture_mode: new
codebase_status: existing
components:
  - name: checkout-api
    kind: app
    repo: https://github.com/acme/checkout
  - name: checkout-infra
    kind: infra
    repo: https://github.com/acme/platform-infra
---
` +
      RFC_BODY.replace(
        /### Integration points\n[\s\S]*?(?=##\s)/,
        '### Integration points\n\n',
      );
    const result = validateRfc(md);
    expect(result.ok).toBe(false);
    expect(
      result.issues.some(
        (i) => i.section === 'integration_points' && i.severity === 'error',
      ),
    ).toBe(true);
  });

  it('allows empty Integration points when architecture_mode=new', () => {
    const md =
      `---
architecture_mode: new
codebase_status: greenfield
---
` +
      RFC_BODY
        .replace(/### Existing components reused\n[\s\S]*?(?=###\s)/, '### Existing components reused\nNinguno — arquitectura nueva.\n\n')
        .replace(/### Integration points\n[\s\S]*?(?=##\s)/, '### Integration points\n\nN/A — arquitectura nueva.\n\n');
    const result = validateRfc(md);
    expect(result.ok).toBe(true);
  });
});
