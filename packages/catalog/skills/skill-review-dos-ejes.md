---
id: skill-review-dos-ejes
version: 0.1.1
description: "En todo review: cómo medir estándares y spec por separado, qué veredicto lleva cada eje y cómo armar el envelope sdlc.review/v1 que submit_review_outcome verifica."
---

# Skill: Review en dos ejes

Un review responde dos preguntas distintas, y mezclarlas hace que una tape a la otra:

- **Estándares** — ¿está escrito como el repo escribe? Convenciones documentadas, más el
  piso de smells de abajo.
- **Spec** — ¿hace lo que el RFC o la nota de cambio dijeron que iba a hacer?

Un diff impecable puede implementar otra cosa. Uno que hace exactamente lo pedido puede
estar escrito contra todas las convenciones. Con un veredicto único hay que elegir cuál de
los dos problemas contar, y el que se cuenta es siempre el más fácil de ver.

## Cómo se corre

Los dos ejes van **en paralelo y con contextos separados**: un sub-agente por eje, cada uno
con el diff y sólo su material —las convenciones del repo para uno, el RFC o la nota de
cambio y los criterios de aceptación para el otro—. Separados porque un mismo contexto los
contamina: el que acaba de leer el spec encuentra problemas de estilo con el spec en la
cabeza, y viceversa.

Cada sub-agente devuelve como máximo unas 400 palabras. Los resultados **no se mezclan ni
se rerankean**: van los dos, uno al lado del otro. La separación es el punto.

Antes de abrir los sub-agentes, dos chequeos baratos que evitan gastarlos al pedo: que el
ref del diff resuelva y que el diff no esté vacío.

## Qué veredicto lleva cada eje

- `ok` — sin hallazgos.
- `advisory` — hay hallazgos y ninguno bloquea el merge. Es el caso normal de los smells:
  son juicios, y quien escribió el código puede tener razones.
- `blocking` — hay al menos uno que se arregla antes de mergear.

`submit_review_outcome` exige coherencia: un `blocking` sin hallazgos no dice qué arreglar,
un `ok` con hallazgos se contradice solo, y un `approved` sobre un eje que bloquea se
rechaza. Cada hallazgo lleva `file`, `why` y —cuando aplica— `line`: un hallazgo que no se
puede ubicar manda a releer el diff entero.

## El piso de smells

Además de lo que el repo documente, estas doce heurísticas de *Refactoring* son el piso del
eje de estándares:

Nombre misterioso · Código duplicado · Envidia de atributos · Grupos de datos ·
Obsesión por primitivos · Switches repetidos · Cirugía con escopeta · Cambio divergente ·
Generalidad especulativa · Cadenas de mensajes · Intermediario · Legado rechazado.

**El repo manda.** Cuando una convención documentada del repo avala algo que el piso
marcaría, gana el repo: la convención se discutió y el piso es genérico. Y todo lo del
piso es `advisory`, nunca `blocking` — son juicios sobre diseño, no defectos.

## Qué no reportar

- Lo que ya enforcea el tooling: formato, lint, `lint:boundaries`, tipos. Si el CI lo caza,
  el review que lo repite sólo agrega ruido.
- Lo que las convenciones documentadas del repo permiten explícitamente.
- Reescrituras de la convención de la casa. Si el estilo del repo tiene un problema real,
  va como issue o RFC aparte — el PR que estás revisando no es el lugar para cambiarlo.
