---
id: skill-qa-plan
version: 0.1.1
description: Reglas para construir un test plan derivado de acceptance criteria.
---

# Skill: QA test plan

Reglas no negociables:

- **Un caso por AC, mínimo.** Si un AC necesita varios casos (edge cases), agregalos numerados (AC1.1, AC1.2…).
- **Boundary cases obligatorios.** Para cada AC con rangos/limites, casos en el límite y fuera del límite.
- **Performance es funcional si el RFC lo fija.** Sin medición → no se firma.
- **Cada caso `failed` exige evidencia reproducible** (screenshot, log, video, request/response).
- **Test plan precede ejecución.** No improvisás clicks.

Formato sugerido por caso:

```
case_id: AC2.1
description: Cuotas en 12 cuando el monto supera USD 500
preconditions: usuario premium con tarjeta Visa local
steps:
  1. Iniciar checkout con ticket 700 USD
  2. Seleccionar 12 cuotas
  3. Confirmar
expected: cronograma muestra 12 cuotas iguales, processor responde 200
status: passed|failed
evidence_url: https://...
```

Anti-patrones:

- "Probar manualmente" sin checklist.
- Casos felices únicamente.
- Marcar `passed` con evidencia ausente.
- Reabrir scope: si encontrás un bug fuera del AC, abrí issue separado.
