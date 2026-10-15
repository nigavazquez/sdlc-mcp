---
id: skill-story-shaping
version: 0.2.1
description: Reglas de descomposición de un RFC en épica + historias + sub-tareas.
---

# Skill: Shaping de historias

Reglas no negociables:

- **Una épica = un RFC.** No mezclar features no relacionados.
- **Una historia = un repo/componente.** Si el flow declaró `components`, cada historia lleva el `component` correspondiente y nunca cruza repos. Una unidad de trabajo que toca app + infra (Terraform) son dos historias. La infra que otras historias consumen va primero.
- **Una historia = 1-3 días de un dev senior.** Si más → partir. Si menos → unir o no crear story.
- **AC por historia: 2-5.** Verificables en demo de 5 minutos. Si más → la historia es demasiado grande.
- **Cada historia tiene una "Definition of Done" implícita en sus AC.** Si los AC no incluyen tests/docs/observabilidad cuando son necesarios, agregalos.
- **Dependencias explícitas** con sintaxis del task system (`PAY-123 blocks PAY-124`).
- **Subtasks solo para historias > 1 día.** Y solo si aportan claridad técnica.

Anti-patrones:

- "Implementar X" como una historia gigante.
- AC tipo "que funcione" o "tener tests".
- Subtasks que solo entiende el autor.
- Historias sin owner asignado al crearlas (asignación puede ser later, pero "Unassigned" indefinido es deuda).
- Estimar en horas. Usá story points o t-shirt sizes.

## Cómo se escribe un AC que sirve

Tres reglas, y ninguna la puede verificar el server: son juicio, y por eso están acá.

**Verificable, no aspiracional.** El test es si alguien más puede decidir si se cumple sin
preguntarte: "corriendo `pnpm sync` la cola queda con 0 mensajes pendientes" se puede
chequear; "la sincronización anda bien" no. Si al leer el criterio no sabés qué mirarías,
todavía no es un criterio.

**Conductual, no procedimental.** Describe qué hace el sistema, no cómo lo implementás.
"El usuario ve un resumen de los issues que necesitan atención" en vez de "agregar un
switch en el handler". El cómo es del RFC y del PR; si el AC lo fija, el criterio falla
cuando alguien implementa lo mismo de otra manera.

**Durable sobre preciso.** Referí tipos, interfaces y comandos, no paths ni números de
línea. Un AC que dice `src/checkout/pay.ts:42` queda mal en el próximo refactor aunque el
comportamiento siga intacto — y entonces la cobertura de QA mide contra algo que ya no
existe.

El server sólo rechaza el caso mecánico: un criterio vacío o en `TBD`. Eso es porque un
criterio que no dice nada entra igual en el denominador de la cobertura que
`submit_qa_results` verifica, y la cuenta da "3/3" sobre algo que nadie puede mirar.
Separar "funciona bien" de un criterio legítimo es juicio tuyo.

Formato sugerido para AC:

```
- GIVEN <contexto> WHEN <acción> THEN <resultado verificable>
- O en estilo lista checklist si el equipo lo prefiere
```
