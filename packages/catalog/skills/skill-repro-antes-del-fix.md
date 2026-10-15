---
id: skill-repro-antes-del-fix
version: 0.1.1
description: "En un fix o un improvement: construir la señal roja antes de tocar código (el repro que declara la nota, o por qué no se pudo) y diagnosticar desde ahí, con el test de regresión escrito primero."
---

# Skill: El repro antes del fix

Un fix sin una señal roja es una hipótesis que nadie vio fallar. Esta skill cubre los dos
momentos donde eso se decide: cuando escribís la nota de cambio y cuando implementás.

## Al escribir la nota: la señal roja primero

La nota declara en su frontmatter **una** de dos cosas:

- `repro: '<comando>'` — un comando que hoy falla **por este problema**. En un `improvement`,
  el comando que muestra el comportamiento actual: la línea base contra la que se mide la
  mejora.
- `no_repro: <por qué>` — cuando no lo pudiste reproducir. Es una respuesta honesta y válida.

Un buen `repro`:

1. **Falla por este bug, no por uno vecino.** Si el test falla, el mensaje tiene que ser el
   síntoma que reportaron. Un test que falla por un timeout cuando el bug es un dato mal
   calculado reproduce otra cosa.
2. **Es determinista.** Corrido tres veces, falla las tres. Si falla a veces, todavía no es un
   repro: es una pista, y va en `no_repro` con lo que sabés del disparador.
3. **Es lo más acotado posible.** Un test filtrado (`-t "..."`) antes que la suite entera; un
   `curl` a un endpoint antes que "levantar la app y navegar".
4. **Se puede pegar y correr.** Sin tokens, sin ids de clientes, sin rutas de tu máquina. El
   valor queda registrado en el log de eventos del flow.
5. **Va entre comillas simples** si tiene `": "` adentro: si no, rompe el YAML. Si el comando
   tiene una comilla simple adentro, duplicala (`''`) o usá comillas dobles para ese tramo:
   una comilla simple sin duplicar corta el valor en silencio.

Un buen `no_repro` le dice a quien verifique qué mirar: *"reportado por soporte en el ticket
4411; sólo pasa con el catálogo de prod, que no tenemos en staging"*. Dos frases como mucho.
El detalle largo va en la sección "Cómo lo sé".

## Al implementar: el bucle

1. **Minimizá el repro.** Sacale todo lo que no hace falta para que falle. El repro mínimo
   suele señalar la causa por sí solo.
2. **Escribí 3 a 5 hipótesis falsables antes de tocar código.** Cada una dice qué observación
   la descartaría. Si sólo tenés una, todavía no entendiste el problema.
3. **Instrumentá cambiando una variable por vez.** Un log, un breakpoint, un valor fijo. Dos
   cambios a la vez no te dicen cuál de los dos importó.
4. **El arreglo arranca con el test de regresión.** Escribilo en el seam correcto —el borde
   donde el síntoma se observa, no el helper que sospechás— y **miralo fallar** antes de
   arreglar. Si pasa antes del arreglo, no reproduce el bug.
5. **Limpiá la instrumentación.** Los logs y los valores fijos del paso 3 no van en el PR.

Ese test de regresión, o el `repro` de la nota, es el candidato natural para el
`test_command` que QA va a exigir en su envelope: es el comando que muestra que lo que antes
fallaba ahora pasa.
