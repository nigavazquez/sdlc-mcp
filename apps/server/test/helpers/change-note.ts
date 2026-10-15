/**
 * Una nota de cambio válida, compartida por los tests que necesitan una.
 *
 * Existe para que el próximo campo obligatorio de la nota se agregue en un lugar y no
 * en tres copias: `repro` tocó las tres.
 */
export const NOTA_OK = `---
repo: acme/sdlc-mcp
repro: 'pnpm --filter @sdlc/server test -- -t "refresh sin workspaces"'
---

# Fix: el claim de workspaces no llega en el refresh

## Qué pasa

Al refrescar el token, ctx.workspaces viene vacío y toda tool falla cerrado.

## Cómo lo sé

Repro en staging y el log sdlc-2026-09-01T10:22Z.

## Qué cambio

Propagar el claim en oauth/routes.ts al emitir el access token del refresh.

## Cómo se verifica

Test nuevo en oauth-refresh.test.ts y login manual contra staging.
`;

export const STORY_OK = {
  title: 'Propagar el claim workspaces en el refresh',
  description: 'El access token emitido por el refresh tiene que llevar el mismo claim que el del login.',
  acceptance_criteria: ['El token del refresh trae workspaces', 'Hay test que lo cubre'],
};

/** Reemplaza la declaración de repro del frontmatter de `NOTA_OK` por `lineas` (o la saca). */
export function conRepro(lineas: string): string {
  return NOTA_OK.replace(/^repro:.*\n/m, lineas ? `${lineas}\n` : '');
}
