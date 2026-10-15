---
repo: <owner>/<repo>
# El comando que hoy falla por este problema, entre comillas simples. Si no lo pudiste
# reproducir, reemplazá la línea por: no_repro: <por qué>
# Si el comando tiene una comilla simple adentro, duplicala ('') o usá comillas dobles
# para ese tramo: una comilla simple sin duplicar corta el valor en silencio.
repro: '<comando que falla hoy>'
---

# <Fix|Mejora>: <título en una línea, lo que se ve, no lo que se cambia>

## Qué pasa

Qué se rompe o qué falta, desde afuera: qué hace el sistema hoy y qué debería hacer.
Una o dos frases. Si estás describiendo la causa raíz acá, va en "Qué cambio".

## Cómo lo sé

La evidencia. Un repro paso a paso, el id de un log, un ticket, una captura, el test
que falla. Sin esto la nota es una opinión, y quien revise el PR no tiene contra qué
contrastar.

El comando va además en el frontmatter (`repro`), que es lo que queda registrado; acá va el
detalle que no entra en una línea.

Si no lo podés reproducir, decilo: "reportado por X, no reproducido" es información
honesta y cambia cómo se verifica.

## Qué cambio

Qué vas a tocar y por qué eso arregla lo de arriba. Nombrá archivos o módulos.
Si el cambio tiene una alternativa que descartaste, una línea diciendo cuál y por qué.

Si esta sección empieza a necesitar diagramas o a discutir trade-offs de
arquitectura, el cambio no es chico: cerrá esto y abrí un flow con
`initiative_type: feature` para que pase por RFC.

## Cómo se verifica

Cómo se comprueba que quedó arreglado: el test que agregás, el comando que hay que
correr, el paso manual que alguien más puede repetir. Es lo que después vas a tener
que respaldar con evidencia en `submit_qa_results`, así que escribí algo que otra
persona pueda ejecutar sin preguntarte nada.
