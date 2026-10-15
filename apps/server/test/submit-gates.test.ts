import { describe, expect, it, vi } from 'vitest';
import type { TenantCtx } from '@sdlc/adapters-contracts';
import { InMemoryFlowStore } from '../src/state/in-memory.js';
import { makeSubmitPrdTool } from '../src/mcp/tools/submit-prd.js';
import { makeSubmitRfcTool } from '../src/mcp/tools/submit-rfc.js';
import { NoOpDocStoreAdapter } from '../src/adapters/doc-store-provider.js';
import type { DocStoreProvider } from '../src/adapters/doc-store-provider.js';
import { testCtx } from './helpers/tenant-ctx.js';
import { seedFlowStatus } from './helpers/flow-status.js';

// Todos los flows de este archivo viven en el workspace "p1" (ver `seedFlow`), así que el
// ctx tiene que declarar esa membresía: `assertFlowAccess` falla cerrado sin el claim.
//
// Los roles son andamiaje, no el objeto de estudio. Este archivo cubre las guardas de
// **status** y de **validación** de submit_prd/submit_rfc, y para llegar a ellas hay que
// pasar primero la guarda de rol que ahora tienen las dos tools: `product-manager` para
// submit_prd, `tech-lead` para submit_rfc. Antes acá decía `roles: []` con la explicación
// de que "ni submit_prd ni submit_rfc piden rol"; eso dejó de ser cierto y con el array
// vacío todos estos tests fallaban en la guarda de rol sin llegar nunca a la de status —o
// sea que habrían pasado a verificar otra cosa—. Un solo ctx con los dos roles los deja
// ejercitando lo que dicen ejercitar; la cobertura de las guardas de rol en sí vive en
// `tools-role-guards.test.ts`.
const ctx: TenantCtx = testCtx({
  tenantId: 't1',
  userId: 'u',
  roles: ['product-manager', 'tech-lead'],
  workspaces: ['p1'],
  resolveSecret: async () => {
    throw new Error('not used');
  },
});

const noopProvider: DocStoreProvider = { resolve: async () => new NoOpDocStoreAdapter() };

// PRD válido: cubre las seis secciones que exige validatePrd.
const VALID_PRD = `# PRD: Pago en cuotas

## Problem
Los compradores premium abandonan el checkout cuando el ticket supera USD 200.

## Users
- Comprador premium recurrente: ticket > 200, abandona en checkout.
- Comprador ocasional: ticket bajo, feedback útil.

## Success Metrics
- Conversion premium: 1.8% → 2.5% en 60 días.
- Ticket promedio: 180 → 250 en 60 días.
- Reclamos por cuotas por debajo del 2% en 90 días.

## Scope
- Cuotas 3, 6 y 12 sin interés.
- Validación de tarjeta antes de cobrar la primera cuota.

## Out of Scope
- Cuotas con interés del banco.
- Refinanciación post-compra.

## Risks
- Fraude con cuotas: mitigado con 3DS obligatorio.
- Backoffice no preparado: mitigado con capacitación previa.
- Performance de pagos: mitigado con circuit breaker.
`;

// Segundo PRD válido, distinto del primero (otro sha256) para distinguir refs.
const OTHER_VALID_PRD = VALID_PRD.replace('Pago en cuotas', 'Pago en cuotas v2');

// PRD inválido: sólo tiene "Problem", faltan las otras cinco secciones.
const INVALID_PRD =
  '# PRD\n\n## Problem\nun prd sin usuarios, sin métricas, sin alcance y sin riesgos declarados\n';

const VALID_RFC = `---
architecture_mode: reuse
codebase_status: existing
existing_repo: https://github.com/acme/checkout
---

# RFC: Test RFC

## Context
ctx

## Architecture context
### Architecture mode
reuse
### Existing components reused
- checkout
### Codebase context
mono
### Integration points
- evento

## Goals
- Pagos en cuotas.

## Non-goals
- nada

## Design
ddd
ddd
ddd

## Risks
| r | t | p | i | m |
| a | b | M | H | x |
| a | b | M | H | x |
| a | b | M | H | x |

## Rollout
- canary

## Rollback
1. flag off
`;

// RFC inválido: dos líneas. No tiene frontmatter ni ninguna de las ocho
// secciones que exige validateRfc. El frontmatter falso de abajo es a propósito:
// si la tool escribiera antes de validar, estos valores pisarían los del RFC
// bueno — `existing_repo` es el más caro, porque alimenta el contexto de
// implementación río abajo.
const INVALID_RFC = `---
architecture_mode: new
existing_repo: https://github.com/mallory/pwned
---

# RFC basura

un rfc de dos líneas que no valida nada
`;

async function seedFlow(store: InMemoryFlowStore, slug: string) {
  return store.createFlow({
    tenant_id: 't1',
    project: 'p1',
    slug,
    title: `Flow ${slug}`,
  });
}

describe('submit_prd — gate de admisión: validar antes de escribir', () => {
  it('un PRD inválido no deja prd_ref, no cambia el status y no emite evento', async () => {
    const store = new InMemoryFlowStore();
    const flow = await seedFlow(store, 'prd-invalido');

    const publish = vi.fn();
    const provider: DocStoreProvider = {
      resolve: vi.fn().mockResolvedValue({ kind: 'google-drive' as const, publish, fetch: vi.fn() }),
    };

    const result = (await makeSubmitPrdTool(store, provider).handler(
      { flow_id: flow.flow_id, prd_markdown: INVALID_PRD },
      ctx,
    )) as { ok: boolean; error?: string };

    expect(result.ok).toBe(false);

    const after = await store.getFlow(flow.flow_id);
    expect(after?.prd_ref).toBeUndefined();
    expect(after?.status).toBe('draft');
    expect(after?.current_phase).toBe('prd');

    const events = await store.listEvents(flow.flow_id);
    expect(events.some((e) => e.type === 'prd.submitted')).toBe(false);
    expect(events.some((e) => e.type === 'prd.published')).toBe(false);

    // Cero side-effects: tampoco se publicó el documento inválido.
    expect(publish).not.toHaveBeenCalled();
  });

  it('un PRD inválido NO pisa la referencia del PRD válido que ya estaba', async () => {
    const store = new InMemoryFlowStore();
    const flow = await seedFlow(store, 'prd-no-pisa');
    const tool = makeSubmitPrdTool(store, noopProvider);

    const first = (await tool.handler(
      { flow_id: flow.flow_id, prd_markdown: VALID_PRD, repo_path: '/docs/prd/bueno.md' },
      ctx,
    )) as { ok: boolean };
    expect(first.ok).toBe(true);

    const good = await store.getFlow(flow.flow_id);
    const goodSha = good?.prd_ref?.sha256;
    expect(goodSha).toBeDefined();
    expect(good?.status).toBe('prd_ready');

    // Resubmisión rota sobre el mismo flow.
    const second = (await tool.handler(
      { flow_id: flow.flow_id, prd_markdown: INVALID_PRD, repo_path: '/docs/prd/roto.md' },
      ctx,
    )) as { ok: boolean };
    expect(second.ok).toBe(false);

    const after = await store.getFlow(flow.flow_id);
    expect(after?.prd_ref?.sha256).toBe(goodSha);
    expect(after?.prd_ref?.repo_path).toBe('/docs/prd/bueno.md');
    expect(after?.status).toBe('prd_ready');
    expect(after?.current_phase).toBe('rfc');

    // Un solo prd.submitted: el rechazado no dejó rastro.
    const events = await store.listEvents(flow.flow_id);
    expect(events.filter((e) => e.type === 'prd.submitted')).toHaveLength(1);
  });

  it('el error nombra la salida ejecutable (submit_prd) y devuelve los issues', async () => {
    const store = new InMemoryFlowStore();
    const flow = await seedFlow(store, 'prd-error-msg');

    const result = (await makeSubmitPrdTool(store, noopProvider).handler(
      { flow_id: flow.flow_id, prd_markdown: INVALID_PRD },
      ctx,
    )) as {
      ok: boolean;
      error?: string;
      data?: { validation: { ok: boolean; issues: { section?: string }[] } };
      next_actions?: string[];
    };

    expect(result.ok).toBe(false);
    expect(result.error).toContain('submit_prd');
    expect(result.error).toContain('validate_prd');
    expect(result.next_actions).toContain('submit_prd');
    // El detalle estructurado viaja igual, para no obligar a parsear el string.
    expect(result.data?.validation.ok).toBe(false);
    expect(result.data?.validation.issues.map((i) => i.section)).toContain('users');
  });

  it('un PRD válido sí reemplaza la referencia anterior', async () => {
    const store = new InMemoryFlowStore();
    const flow = await seedFlow(store, 'prd-reemplaza');
    const tool = makeSubmitPrdTool(store, noopProvider);

    await tool.handler({ flow_id: flow.flow_id, prd_markdown: VALID_PRD }, ctx);
    const firstSha = (await store.getFlow(flow.flow_id))?.prd_ref?.sha256;

    const second = (await tool.handler(
      { flow_id: flow.flow_id, prd_markdown: OTHER_VALID_PRD },
      ctx,
    )) as { ok: boolean };
    expect(second.ok).toBe(true);

    const after = await store.getFlow(flow.flow_id);
    expect(after?.prd_ref?.sha256).not.toBe(firstSha);
    expect(after?.status).toBe('prd_ready');
  });
});

describe('submit_rfc — guarda de status: el PRD tiene que estar aprobado', () => {
  it('rechaza cuando el flow está en draft (nunca hubo PRD)', async () => {
    const store = new InMemoryFlowStore();
    const flow = await seedFlow(store, 'rfc-sin-prd');

    const result = (await makeSubmitRfcTool(store, noopProvider).handler(
      { flow_id: flow.flow_id, rfc_markdown: VALID_RFC, repo_path: '/docs/rfc/x.md' },
      ctx,
    )) as { ok: boolean; error?: string };

    expect(result.ok).toBe(false);
    expect(result.error).toContain('status "draft"');
    expect(result.error).toContain('submit_prd');

    // Guarda antes de todo side-effect: ni rfc_ref ni evento.
    const after = await store.getFlow(flow.flow_id);
    expect(after?.rfc_ref).toBeUndefined();
    expect(await store.listEvents(flow.flow_id)).toHaveLength(0);
  });

  it('rechaza cuando el PRD se envió pero no validó (flow sigue en draft, fase prd)', async () => {
    const store = new InMemoryFlowStore();
    const flow = await seedFlow(store, 'rfc-prd-invalido');

    await makeSubmitPrdTool(store, noopProvider).handler(
      { flow_id: flow.flow_id, prd_markdown: INVALID_PRD },
      ctx,
    );
    const midway = await store.getFlow(flow.flow_id);
    expect(midway?.status).toBe('draft');
    expect(midway?.current_phase).toBe('prd');

    const result = (await makeSubmitRfcTool(store, noopProvider).handler(
      { flow_id: flow.flow_id, rfc_markdown: VALID_RFC, repo_path: '/docs/rfc/x.md' },
      ctx,
    )) as { ok: boolean; error?: string };

    expect(result.ok).toBe(false);
    expect(result.error).toContain('submit_prd');
    expect((await store.getFlow(flow.flow_id))?.rfc_ref).toBeUndefined();
  });

  it('acepta cuando el flow está en prd_ready', async () => {
    const store = new InMemoryFlowStore();
    const flow = await seedFlow(store, 'rfc-prd-ready');

    await makeSubmitPrdTool(store, noopProvider).handler(
      { flow_id: flow.flow_id, prd_markdown: VALID_PRD },
      ctx,
    );
    expect((await store.getFlow(flow.flow_id))?.status).toBe('prd_ready');

    const result = (await makeSubmitRfcTool(store, noopProvider).handler(
      { flow_id: flow.flow_id, rfc_markdown: VALID_RFC, repo_path: '/docs/rfc/ok.md' },
      ctx,
    )) as { ok: boolean };

    expect(result.ok).toBe(true);
    expect((await store.getFlow(flow.flow_id))?.status).toBe('rfc_ready');
  });

  it('acepta un re-submit cuando el flow ya está en rfc_ready (revisión del RFC)', async () => {
    const store = new InMemoryFlowStore();
    const flow = await seedFlow(store, 'rfc-resubmit');

    await makeSubmitPrdTool(store, noopProvider).handler(
      { flow_id: flow.flow_id, prd_markdown: VALID_PRD },
      ctx,
    );
    const rfcTool = makeSubmitRfcTool(store, noopProvider);
    await rfcTool.handler(
      { flow_id: flow.flow_id, rfc_markdown: VALID_RFC, repo_path: '/docs/rfc/v1.md' },
      ctx,
    );
    expect((await store.getFlow(flow.flow_id))?.status).toBe('rfc_ready');

    const revised = VALID_RFC.replace('## Goals\n- Pagos en cuotas.', '## Goals\n- Pagos en cuotas y wallet.');
    const result = (await rfcTool.handler(
      { flow_id: flow.flow_id, rfc_markdown: revised, repo_path: '/docs/rfc/v2.md' },
      ctx,
    )) as { ok: boolean };

    expect(result.ok).toBe(true);
    const after = await store.getFlow(flow.flow_id);
    expect(after?.status).toBe('rfc_ready');
    expect(after?.rfc_ref?.repo_path).toBe('/docs/rfc/v2.md');
  });

  it('rechaza el re-submit una vez que el backlog se derivó del RFC (backlog_ready)', async () => {
    const store = new InMemoryFlowStore();
    const flow = await seedFlow(store, 'rfc-backlog-ready');

    await makeSubmitPrdTool(store, noopProvider).handler(
      { flow_id: flow.flow_id, prd_markdown: VALID_PRD },
      ctx,
    );
    const rfcTool = makeSubmitRfcTool(store, noopProvider);
    await rfcTool.handler(
      { flow_id: flow.flow_id, rfc_markdown: VALID_RFC, repo_path: '/docs/rfc/v1.md' },
      ctx,
    );
    await seedFlowStatus(store, flow.flow_id, { status: 'backlog_ready', current_phase: 'implementation' });

    const result = (await rfcTool.handler(
      { flow_id: flow.flow_id, rfc_markdown: VALID_RFC, repo_path: '/docs/rfc/v3.md' },
      ctx,
    )) as { ok: boolean; error?: string };

    expect(result.ok).toBe(false);
    expect(result.error).toContain('status "backlog_ready"');
    // El error nombra las dos salidas ejecutables posibles.
    expect(result.error).toContain('submit_adr');
    expect(result.error).toContain('start_flow');
    // La referencia buena queda intacta.
    expect((await store.getFlow(flow.flow_id))?.rfc_ref?.repo_path).toBe('/docs/rfc/v1.md');
  });

  it('rechaza cuando el flow está aborted', async () => {
    const store = new InMemoryFlowStore();
    const flow = await seedFlow(store, 'rfc-aborted');
    await seedFlowStatus(store, flow.flow_id, { status: 'aborted' });

    const result = (await makeSubmitRfcTool(store, noopProvider).handler(
      { flow_id: flow.flow_id, rfc_markdown: VALID_RFC, repo_path: '/docs/rfc/x.md' },
      ctx,
    )) as { ok: boolean; error?: string };

    expect(result.ok).toBe(false);
    expect(result.error).toContain('aborted');
    expect(result.error).toContain('start_flow');
  });
});

// Espejo exacto del gate de submit_prd de más arriba: mismo bug, mismo arreglo.
// Acá el arreglo había quedado a medias — sólo `components` y la transición de
// status miraban `validation.ok`, así que un RFC inválido igual pisaba
// `rfc_ref`, `architecture_mode` y `existing_repo`, publicaba en el doc store y
// emitía `rfc.submitted`, todo devolviendo `ok:false`.
describe('submit_rfc — gate de admisión: validar antes de escribir', () => {
  /** Deja el flow en rfc_ready con un RFC bueno y devuelve su estado. */
  async function seedFlowConRfcBueno(store: InMemoryFlowStore, slug: string) {
    const flow = await seedFlow(store, slug);
    await makeSubmitPrdTool(store, noopProvider).handler(
      { flow_id: flow.flow_id, prd_markdown: VALID_PRD },
      ctx,
    );
    const ok = (await makeSubmitRfcTool(store, noopProvider).handler(
      { flow_id: flow.flow_id, rfc_markdown: VALID_RFC, repo_path: '/docs/rfc/bueno.md' },
      ctx,
    )) as { ok: boolean };
    expect(ok.ok).toBe(true);
    return flow;
  }

  it('un RFC inválido NO pisa nada del RFC válido que ya estaba', async () => {
    const store = new InMemoryFlowStore();
    const flow = await seedFlowConRfcBueno(store, 'rfc-no-pisa');

    const bueno = await store.getFlow(flow.flow_id);
    expect(bueno?.status).toBe('rfc_ready');
    expect(bueno?.existing_repo).toBe('https://github.com/acme/checkout');
    expect(bueno?.architecture_mode).toBe('reuse');
    const buenoSha = bueno?.rfc_ref?.sha256;
    expect(buenoSha).toBeDefined();

    // El publish se espía: el RFC inválido no debe llegar al doc store.
    const publish = vi.fn();
    const provider: DocStoreProvider = {
      resolve: vi.fn().mockResolvedValue({ kind: 'google-drive' as const, publish, fetch: vi.fn() }),
    };

    const result = (await makeSubmitRfcTool(store, provider).handler(
      { flow_id: flow.flow_id, rfc_markdown: INVALID_RFC, repo_path: '/docs/rfc/basura.md' },
      ctx,
    )) as { ok: boolean };
    expect(result.ok).toBe(false);

    const after = await store.getFlow(flow.flow_id);
    // Ni la referencia...
    expect(after?.rfc_ref?.sha256).toBe(buenoSha);
    expect(after?.rfc_ref?.repo_path).toBe('/docs/rfc/bueno.md');
    // ...ni el contexto de arquitectura que el frontmatter basura traía.
    expect(after?.existing_repo).toBe('https://github.com/acme/checkout');
    expect(after?.architecture_mode).toBe('reuse');
    expect(after?.codebase_status).toBe('existing');
    // ...ni el status.
    expect(after?.status).toBe('rfc_ready');
    expect(after?.current_phase).toBe('shaping');

    // Cero side-effects externos: no se publicó el documento inválido.
    expect(publish).not.toHaveBeenCalled();

    // Un solo rfc.submitted: el rechazado no dejó rastro.
    const events = await store.listEvents(flow.flow_id);
    expect(events.filter((e) => e.type === 'rfc.submitted')).toHaveLength(1);
  });

  it('un RFC inválido sobre un flow sin RFC previo no deja rfc_ref, status ni evento', async () => {
    const store = new InMemoryFlowStore();
    const flow = await seedFlow(store, 'rfc-invalido-limpio');
    await makeSubmitPrdTool(store, noopProvider).handler(
      { flow_id: flow.flow_id, prd_markdown: VALID_PRD },
      ctx,
    );

    const publish = vi.fn();
    const provider: DocStoreProvider = {
      resolve: vi.fn().mockResolvedValue({ kind: 'google-drive' as const, publish, fetch: vi.fn() }),
    };

    const result = (await makeSubmitRfcTool(store, provider).handler(
      { flow_id: flow.flow_id, rfc_markdown: INVALID_RFC, repo_path: '/docs/rfc/basura.md' },
      ctx,
    )) as { ok: boolean };
    expect(result.ok).toBe(false);

    const after = await store.getFlow(flow.flow_id);
    expect(after?.rfc_ref).toBeUndefined();
    expect(after?.existing_repo).toBeUndefined();
    expect(after?.architecture_mode).toBeUndefined();
    // El flow se queda donde estaba: el PRD aprobado, esperando un RFC que valide.
    expect(after?.status).toBe('prd_ready');
    expect(after?.current_phase).toBe('rfc');

    expect(publish).not.toHaveBeenCalled();
    const events = await store.listEvents(flow.flow_id);
    expect(events.some((e) => e.type === 'rfc.submitted')).toBe(false);
    expect(events.some((e) => e.type === 'rfc.published')).toBe(false);
  });

  it('el error nombra la salida ejecutable (submit_rfc) y devuelve los issues', async () => {
    const store = new InMemoryFlowStore();
    const flow = await seedFlow(store, 'rfc-error-msg');
    await makeSubmitPrdTool(store, noopProvider).handler(
      { flow_id: flow.flow_id, prd_markdown: VALID_PRD },
      ctx,
    );

    const result = (await makeSubmitRfcTool(store, noopProvider).handler(
      { flow_id: flow.flow_id, rfc_markdown: INVALID_RFC, repo_path: '/docs/rfc/basura.md' },
      ctx,
    )) as {
      ok: boolean;
      error?: string;
      data?: { validation: { ok: boolean; issues: { section?: string }[] } };
      next_actions?: string[];
    };

    expect(result.ok).toBe(false);
    expect(result.error).toContain('submit_rfc');
    expect(result.error).toContain('validate_rfc');
    expect(result.next_actions).toContain('submit_rfc');
    // El detalle estructurado viaja igual, para no obligar a parsear el string.
    expect(result.data?.validation.ok).toBe(false);
    expect(result.data?.validation.issues.map((i) => i.section)).toContain('goals');
  });

  it('un RFC válido sí reemplaza la referencia y el contexto anteriores', async () => {
    const store = new InMemoryFlowStore();
    const flow = await seedFlowConRfcBueno(store, 'rfc-reemplaza');
    const firstSha = (await store.getFlow(flow.flow_id))?.rfc_ref?.sha256;

    const otroValido = VALID_RFC.replace(
      'existing_repo: https://github.com/acme/checkout',
      'existing_repo: https://github.com/acme/checkout-v2',
    );
    const result = (await makeSubmitRfcTool(store, noopProvider).handler(
      { flow_id: flow.flow_id, rfc_markdown: otroValido, repo_path: '/docs/rfc/v2.md' },
      ctx,
    )) as { ok: boolean };
    expect(result.ok).toBe(true);

    const after = await store.getFlow(flow.flow_id);
    expect(after?.rfc_ref?.sha256).not.toBe(firstSha);
    expect(after?.rfc_ref?.repo_path).toBe('/docs/rfc/v2.md');
    expect(after?.existing_repo).toBe('https://github.com/acme/checkout-v2');
    expect(after?.status).toBe('rfc_ready');
  });
});

// ---------------------------------------------------------------------------
// El validador de documentos no impone el requisito del gate de review
//
// Exigir un repo "comparable" (GitHub o Azure DevOps) para aceptar el RFC metía
// un requisito del *gate de review* dentro del *validador de documentos*: un
// equipo en GitLab no podía escribir un RFC, aunque usara sólo la mitad
// PRD/RFC/shaping y nunca configurara un pr_provider. Ahora es warning.
// ---------------------------------------------------------------------------

describe('submit_rfc — un repo que el gate no sabe verificar no bloquea el RFC', () => {
  const REPOS: [string, string][] = [
    ['gitlab', 'https://gitlab.com/acme/checkout'],
    ['bitbucket', 'https://bitbucket.org/acme/checkout'],
    ['path absoluto', '/srv/repos/checkout'],
    ['descriptivo', 'el monorepo de checkout'],
    ['tres segmentos', 'monorepo/services/checkout'],
  ];

  it.each(REPOS)('acepta el RFC con un repo %s', async (etiqueta, repo) => {
    const store = new InMemoryFlowStore();
    const flow = await seedFlow(store, `rfc-repo-${etiqueta.replace(/\s+/g, '-')}`);
    await makeSubmitPrdTool(store, noopProvider).handler(
      { flow_id: flow.flow_id, prd_markdown: VALID_PRD },
      ctx,
    );

    const rfc = VALID_RFC.replace('existing_repo: https://github.com/acme/checkout', `existing_repo: ${repo}`);
    const result = (await makeSubmitRfcTool(store, noopProvider).handler(
      { flow_id: flow.flow_id, rfc_markdown: rfc, repo_path: '/docs/rfc/x.md' },
      ctx,
    )) as { ok: boolean; data?: { validation: { ok: boolean; issues: { severity: string; message: string }[] } } };

    expect(result.ok).toBe(true);
    // El RFC se guarda entero, con el repo declarado tal cual.
    const after = await store.getFlow(flow.flow_id);
    expect(after?.status).toBe('rfc_ready');
    expect(after?.existing_repo).toBe(repo);

    // Y la señal temprana sigue estando, como warning.
    const warnings = result.data?.validation.issues.filter((i) => i.severity === 'warning') ?? [];
    expect(warnings.some((i) => i.message.includes('code review gate'))).toBe(true);
    expect(result.data?.validation.issues.filter((i) => i.severity === 'error')).toEqual([]);
  });

  it('el placeholder sin reemplazar sigue rechazando el RFC', async () => {
    const store = new InMemoryFlowStore();
    const flow = await seedFlow(store, 'rfc-repo-placeholder');
    await makeSubmitPrdTool(store, noopProvider).handler(
      { flow_id: flow.flow_id, prd_markdown: VALID_PRD },
      ctx,
    );

    const rfc = VALID_RFC.replace(
      'existing_repo: https://github.com/acme/checkout',
      'existing_repo: <url o path>',
    );
    const result = (await makeSubmitRfcTool(store, noopProvider).handler(
      { flow_id: flow.flow_id, rfc_markdown: rfc, repo_path: '/docs/rfc/x.md' },
      ctx,
    )) as { ok: boolean; error?: string };

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/placeholder/);
    // Y sin el segundo error, el falso.
    expect(result.error).not.toMatch(/is required when codebase_status/);
    expect((await store.getFlow(flow.flow_id))?.rfc_ref).toBeUndefined();
  });
});
