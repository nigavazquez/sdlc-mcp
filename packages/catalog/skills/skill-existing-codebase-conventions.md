---
id: skill-existing-codebase-conventions
version: 0.1.1
description: "Con codebase_status=existing: qué inspeccionar antes del primer commit para escribir como escribe el repo (docs, tooling, layout, tests)."
---

# Skill: Respetar convenciones del codebase existente

Aplicable cuando `codebase_status=existing`. Antes de tu primer commit, descubrí "el estilo de la casa" y respetalo.

Inspección obligatoria antes de codear:

1. **Docs de contribución** — `CONTRIBUTING.md`, `docs/architecture.md`, `README.md`. Buscá reglas explícitas sobre branches, commits, PR templates.
2. **Tooling** — `.editorconfig`, `.prettierrc`, `.eslintrc`, `pyproject.toml`, `go.mod`. Conformá tu setup local antes de tocar nada.
3. **Estructura de directorios** — abrí 2 features comparables y leé cómo están organizadas. Imitá el layout (archivos por feature vs. por capa, ubicación de tests, naming).
4. **Tests** — leé 1-2 tests existentes del módulo que vas a tocar. Imitá el patrón (test framework, helpers, fixtures, mocking).
5. **Imports** — el orden y formato de imports. Si hay un patrón consistente (stdlib → 3rd party → local), respetalo.

Reglas:

- **No introduzcas libs nuevas** sin justificarlas. Si una utility similar ya está en `package.json` / `go.mod` / `pyproject.toml`, usá esa.
- **Naming** — si el repo usa `camelCase`, no metas `snake_case`. Si usa `kebab-case` en archivos, no metas `camelCase.ts`.
- **Logging y errores** — usá el wrapper que el resto del repo usa (`pino`, `zap`, `slog`, lo que sea). No metas `console.log` ni un logger paralelo.
- **Feature flags / config** — si hay un sistema, usalo. No leas `process.env` directo si todos los demás usan un módulo central.

Si encontrás algo del estilo de la casa que claramente está mal, abrí un issue separado. **No lo arregles en este PR**: scope creep.
