---
id: skill-greenfield-implementation
version: 0.1.1
description: "Con architecture_mode=new o codebase_status=greenfield: lo que el repo necesita (estructura, CI, ADR-0001) antes del primer commit de feature."
---

# Skill: Bootstrap de implementación greenfield

Aplicable cuando `architecture_mode=new` o `codebase_status=greenfield`. Tu primera commit no es feature code: es un proyecto que arranca y otros pueden entender.

Checklist obligatorio antes del primer feature commit:

1. **Estructura base** — README.md con propósito + quickstart + license. `.editorconfig` y formateador del lenguaje (prettier, gofmt, ruff, etc.).
2. **CI mínimo** — workflow que corre lint + test + build en cada PR. Sin esto el repo no es revisable.
3. **ADR-0001** — `docs/adr/0001-stack-inicial.md` con: lenguaje + runtime + framework + storage + decisión clave única. Una frase por elección, con razón.
4. **Tests harness** — al menos un test trivial que corra en CI. Sin harness, los tests llegan tarde.
5. **Dependency hygiene** — lockfile commiteado. Versiones pinneadas o con tilde explícito.

Reglas:

- Antes de elegir lib o framework, busca si el equipo ya usa algo equivalente en otros repos. Si lo hay, justificá por qué desviás.
- No abras el primer PR sin pasar CI en local.
- Si introducís un patrón nuevo (DI, routing, ORM), documentalo en un ADR breve antes de adoptarlo en código.
