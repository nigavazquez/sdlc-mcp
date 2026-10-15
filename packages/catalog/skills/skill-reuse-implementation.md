---
id: skill-reuse-implementation
version: 0.1.1
description: "Con architecture_mode reuse o hybrid: extender los componentes que el RFC reusa en vez de duplicarlos, verificando antes que sus contratos sigan vigentes."
---

# Skill: Implementación con reuso de componentes existentes

Aplicable cuando `architecture_mode ∈ {reuse, hybrid}`. Tu trabajo es extender lo existente, no reemplazarlo.

Antes de escribir código:

1. **Mapeá lo referenciado** — abrí cada componente listado en `### Existing components reused` del RFC. Leé su API pública, sus tests, su última versión.
2. **Identificá los integration points** — confirmá que los contratos descritos en el RFC siguen vigentes en el código actual. Si cambiaron, paralizá y avisá al Tech Lead.
3. **Decidí por reuso, no por duplicación** — si encontrás una utility ya escrita que cubre un 80% de lo que necesitás, extendela en su package. No copies código a tu módulo.

Durante la implementación:

- Respetá los contratos públicos del componente reusado. Si necesitás cambiar la firma, eso requiere un sub-RFC o coordinación con el owner del componente.
- Si te tienta hacer un fork interno ("copio el módulo y lo modifico solo para este caso"), justificá el motivo en la descripción del PR y abrí un follow-up para consolidar.
- Tests: agregá los tuyos pero **no rompas los del componente reusado**. Si los rompiste, el cambio en el componente es responsabilidad tuya.

Antes de abrir el PR:

- Confirmá que ningún integration point quedó indocumentado (todos están en el RFC o en código autodescriptivo).
- Si introdujiste un wrapper alrededor del componente, justificá en el PR por qué no llamás directo.
