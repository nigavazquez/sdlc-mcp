# Squads como eje del modelo — Design

**Fecha:** 2026-07-15
**Estado:** diseño aprobado

## Contexto y decisiones

La organización habla de **squads**, no de tenants, y **una persona puede aportar a
varios squads**. Se decidió: un solo tenant fijo (`acme`) y los squads como concepto de
primera clase. Los 5 squads reales: `revenue-growth` (Revenue & Growth), `finance-erp`
(Finance & ERP), `planning` (Planning), `operations` (Operations), `platform` (Platform).
Los proyectos son **iniciativas** tipadas: improvement | feature | refactor | fix.

## Modelo

- **Migración 0008:** `squads(squad_id PK, name, created_at)` sembrada con los 5 (ON
  CONFLICT DO NOTHING); `squad_members(email, squad_id, roles jsonb, created_at,
  PK(email, squad_id))`; `flows.initiative_type text`; `oauth_codes.squads jsonb` y
  `oauth_refresh_tokens.squads jsonb`. `tenant_members` queda deprecada (no llegó a prod).
- **`flow.project` = `squad_id`.** Las integraciones siguen resolviéndose por
  `(tenant, project)` sin cambios: el board ADO de cada squad es una fila por squad.
- **Identidad:** el callback de Google exige membresía en ≥1 squad. El JWT lleva
  `squads: Record<squad_id, RoleId[]>` y `roles` = unión (compat). `tenant_id` sale de la
  config (`TENANT_ID`, default `acme`). `TenantCtx` gana `squads?` opcional.
- **Autorización por squad:** helper `assertSquadAccess(ctx, squadId)` — si el ctx trae
  `squads`, exige membresía; sin `squads` (tests/fakes) no bloquea. Se aplica en
  `start_flow`, `create_epic`, `create_stories` y `claim_story`.
- **`start_flow`** pide `initiative_type` (requerido) y lo persiste en el flow.

## Directorio y panel

- `DirectoryStore` reformulado a membresías N:M:
  `listMemberships(email)`, `listMembers(squadId)`, `upsertMember({email, squad_id, roles})`,
  `removeMember(email, squadId)`. Impl in-memory + Postgres (`squad_members`).
- `AdminStore` pasa de tenants a squads (`listSquads/getSquad/createSquad` sobre `squads`).
- API panel: `/admin/api/squads...` reemplaza `/admin/api/tenants...` (misma forma:
  integraciones, miembros, flows por squad). El PUT de miembro ya no "muda" a la persona:
  agrega/actualiza esa membresía puntual.
- SPA: terminología squad en todo; la lista de flows muestra `initiative_type`.
- Los errores del login hablan de squads ("pedí el alta en tu squad").

## Testing

Membresías N:M (misma persona en 2 squads con roles distintos), callback sin membresía →
403, JWT con claim `squads` y roles=unión, `assertSquadAccess` (con y sin claim, squad
ajeno → error), `start_flow` con initiative_type persistido y squad ajeno rechazado,
panel squads/miembros e2e por inject.
