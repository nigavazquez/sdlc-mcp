---
id: skill-grilling
version: 0.1.1
description: "Cuando hay que sacarle decisiones a una persona (discovery, diseño de RFC, alcance de una nota): preguntar la frontera entera de una vez, con una respuesta recomendada por pregunta, y averiguar antes de preguntar."
---

# Skill: Interrogar por frontera

Técnica para llegar a entendimiento compartido rápido, sin dejar supuestos silenciosos.
Sirve en cualquier fase donde haya que sacarle decisiones a una persona: discovery de un
PRD, diseño de un RFC, alcance de una nota de cambio.

## La idea

Las decisiones de una iniciativa forman un árbol: unas dependen de otras. La **frontera**
son las decisiones cuyos prerrequisitos ya están resueltos, o sea las que se pueden
preguntar **ahora**.

Se trabaja en rondas. En cada ronda:

1. Calculá la frontera.
2. Preguntá **toda la frontera de una sola vez**, numerada.
3. Con cada respuesta, la frontera se mueve: lo que se resolvió habilita lo que dependía
   de eso.

La sesión termina cuando la frontera queda vacía: cada rama del árbol visitada, nada
supuesto en silencio.

## Las tres reglas

**Preguntá la frontera entera, no de a una.** Una pregunta por mensaje convierte una
conversación de tres rondas en veinte idas y vueltas. Si hay cinco decisiones desbloqueadas,
van las cinco en el mismo mensaje.

**Cada pregunta lleva una respuesta recomendada.** Marcala con ➡️ y justificala en una
línea. Así la persona puede contestar "1, 3 y 4 dale; en 2 prefiero lo otro" en vez de
redactar cinco párrafos. Una recomendación también hace visible tu criterio, que es lo que
la otra persona necesita corregir cuando estás yendo para el lado equivocado.

**Averiguá antes de preguntar.** Todo lo que puedas resolver leyendo —el estado del flow,
el repo, un PRD anterior, la documentación de una API— resolvelo vos. Preguntarle a alguien
un dato que estaba a un `get_flow_state` de distancia gasta el recurso más caro de la
sesión, que es su atención.

Si un dato necesita investigación externa que tarda, seguí con el resto de la frontera y
volvé después: una investigación pendiente no bloquea las decisiones que no dependen de
ella.

## Formato de una ronda

```
Ronda 2 — alcance y métricas (el problema y los usuarios ya están cerrados)

1. **¿El MVP incluye el flujo de devoluciones?**
   Con devoluciones son ~3 semanas más y toca el sistema de pagos.
   ➡️ Recomiendo dejarlo afuera de v1: el 80% del dolor que describiste está en el alta.

2. **¿La North Star es tiempo hasta el primer cobro, o tasa de conversión del alta?**
   ...
   ➡️ Recomiendo tiempo hasta el primer cobro: es lo que nombraste primero y se mide hoy.
```

## Cuándo parar

Cuando la frontera queda vacía. Antes de eso, dos señales de que estás preguntando de más:

- La pregunta la podés contestar vos leyendo algo. Leelo.
- La respuesta no cambia nada de lo que se va a escribir después. Sacala.

Y una señal de que estás preguntando de menos: si al redactar el documento tenés que
elegir algo que nadie decidió, esa decisión era una pregunta de la frontera y se te pasó.
Volvé a preguntar en vez de decidir por tu cuenta.
