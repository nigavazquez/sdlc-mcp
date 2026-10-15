---
id: skill-prd-template
version: 0.1.1
description: Reglas de redacción y estructura para un PRD producible y validable.
---

# Skill: Redacción de PRD

Reglas no negociables al redactar un PRD:

- **Una página de cabecera**: título, autor, fecha, estado (`draft` | `in_review` | `approved`).
- **Problema en una frase**: si no podés expresar el problema en una oración, no lo entendés todavía. No empieces con "queremos…", empezá con "los usuarios X no pueden Y porque Z".
- **Usuarios concretos**: rol + contexto + dolor actual. No "los clientes": "el cajero del local físico que…".
- **Métricas SMART**: cada métrica con baseline actual, target y plazo. Ejemplo: `time-to-first-checkout: baseline 3.2 min → target ≤2.0 min en 60 días post-launch`.
- **Scope = lista de capacidades**: bullets, no narrativa. Cada bullet debe ser independientemente verificable.
- **Out-of-scope = lista explícita**: ítems que algún stakeholder podría asumir incluidos. Ser específico evita scope creep en RFC.
- **Riesgos = tabla**: riesgo | probabilidad (L/M/H) | impacto (L/M/H) | mitigación. Mínimo 3 filas.
- **Open questions = lista**: lo que NO sabés todavía. Cada item con dueño y fecha objetivo de respuesta.

Anti-patrones a evitar:
- Mencionar tecnología (DB, framework, lenguaje). Eso es del RFC.
- Métricas "directionales" tipo "mejor UX". Si no es medible, no es métrica.
- "MVP" sin definir explícitamente qué queda fuera.
