# Squads Model Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Squads de primera clase sobre un tenant fijo: membresía N:M con roles por squad, claims `squads` en el JWT, autorización por squad en las tools, `initiative_type` en flows, y panel/SPA hablando de squads.

**Architecture:** Migración 0008 + reshape de `DirectoryStore` (membresías) y `AdminStore` (squads), claims nuevos en el AS y el bearer, helper `assertSquadAccess` en las tools de escritura, rutas `/admin/api/squads` y SPA renombrada.

**Tech Stack:** el existente (Fastify, Drizzle, zod, vitest, React/Vite). Sin deps nuevas.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-15-squads-model-design.md`.
- Tests corren sin DB ni Google (in-memory + fake). Los tests de tools existentes pasan
  ctx sin `squads` → `assertSquadAccess` no bloquea en ese caso.
- Squads seed: revenue-growth, finance-erp, planning, operations, platform.
- Commits frecuentes con el trailer del repo.

### Task 1: Migración 0008 + schema + tipos core
`0008_squads.sql` (squads + seed, squad_members, flows.initiative_type, squads jsonb en oauth_codes/oauth_refresh_tokens), `schema.ts`, `packages/core/src/flow.ts` (`InitiativeType = z.enum([...])`, campo opcional en Flow y CreateFlowInput/UpdateFlowInput del server), `TenantCtx.squads?: Record<string, RoleId[]>` en adapters-contracts.

### Task 2: DirectoryStore → membresías N:M (TDD)
Reescribir `oauth/directory-store.ts` + in-memory + postgres: `Membership {email, squad_id, roles, created_at}`, métodos del spec. Tests: multi-squad, upsert por (email, squad), remove puntual.

### Task 3: AdminStore → squads
`admin/store.ts` + impls: `listSquads/getSquad/createSquad` sobre tabla `squads` (in-memory sembrado vacío; postgres lee el seed). Test tenants→squads renombrado.

### Task 4: Claims squads en AS + bearer (TDD)
`GrantClaims` gana `squads`; stores oauth persisten/devuelven el mapa; callback exige ≥1 membresía y arma `roles`=unión; JWT incluye `squads`; `oauth-bearer` arma `ctx.squads` + `roles`. Config `TENANT_ID` (default acme). Actualizar oauth-flow/oauth-bearer tests.

### Task 5: assertSquadAccess + initiative_type en tools (TDD)
`mcp/tools/squad-access.ts`: `assertSquadAccess(ctx, squadId): string | null` (mensaje de error o null). Aplicar en start_flow (más `initiative_type` requerido en input, persistido), create_epic, create_stories, claim_story. Tests: squad ajeno → error con ctx.squads; sin ctx.squads pasa; initiative_type persistido.

### Task 6: Panel API `/admin/api/squads` + SPA
Rutas renombradas (squads, members N:M — DELETE por (squad,email), PUT no muda), counts por squad; SPA: Squads en lista/detalle, columna iniciativa en Flows, textos. Tests admin-routes actualizados. Errores del callback OAuth mencionan squads.

### Task 7: Docs + verificación + PR
ARCHITECTURE (modelo squads), runbook-google-sso (alta por squad), README. `turbo build typecheck test --force` verde. PR.

## Self-Review
Cobertura completa del spec; tipos consistentes (Membership/GrantClaims/ctx.squads); sin placeholders — el detalle fino vive en los archivos existentes que cada task modifica.
