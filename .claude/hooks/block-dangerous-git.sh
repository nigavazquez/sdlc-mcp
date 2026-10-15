#!/usr/bin/env bash
# Freno mecánico para las operaciones de git que no tienen vuelta atrás.
#
# Lo que separa esto de una instrucción en CLAUDE.md es que una instrucción se puede
# ignorar y esto no: sale con código 2 y el comando no corre. La lista es corta a
# propósito — cada entrada bloquea algo que destruye trabajo sin dejar rastro, o que
# viola una regla que el repo ya declaró en CONTRIBUTING.md.
#
# Salir 0 deja pasar. Salir 2 bloquea y le devuelve el mensaje al modelo.
set -uo pipefail

entrada=$(cat)
comando=$(printf '%s' "$entrada" | python3 -c 'import json,sys
try:
    print(json.load(sys.stdin).get("tool_input", {}).get("command", ""))
except Exception:
    print("")
' 2>/dev/null)

[ -z "$comando" ] && exit 0

bloquear() {
  echo "BLOQUEADO: $1" >&2
  exit 2
}

# Se evalúa segmento por segmento, y sólo los segmentos que **son** un comando git.
#
# Las dos cosas importan, y las dos las aprendimos la primera vez que este hook corrió
# de verdad: se bloqueó a sí mismo dos veces seguidas.
#
#  1. Mirando el comando entero, `git push -u origin x && turbo run build --force`
#     parece un push forzado: tiene "git push" en un lado y "--force" en el otro.
#  2. Mirando cualquier texto, un heredoc que *menciona* `git push --force` —el
#     mensaje de un PR, este mismo comentario— parece la operación misma.
#
# Por eso el segmento tiene que empezar con `git`: lo que no es una invocación de git
# no se inspecciona. Un guardarraíl con falsos positivos se desactiva en una semana, y
# entonces no protege nada.
separados=$(printf '%s' "$comando" | tr '\n;|&' '\n\n\n\n')

while IFS= read -r segmento; do
  # Espacios normalizados y con bordes, para que `git   push` no se escape por el
  # formato y para que los patrones puedan anclar contra " git ".
  normalizado=" $(printf '%s' "$segmento" | tr -s '[:space:]' ' ' | sed 's/^ *//;s/ *$//') "

  case "$normalizado" in
    " git "*) ;;   # es un comando git: se inspecciona abajo
    *) continue ;; # cualquier otra cosa no se mira
  esac

  # El push se mira aparte y anidado. Con los patrones en una sola línea
  # —`*" push "*" -f "*`— los dos literales se pelean por el mismo espacio: después de
  # consumir " push ", lo que queda es "-f origin x" y ya no tiene el espacio de
  # adelante. Anidado, cada condición mira el segmento entero.
  case "$normalizado" in
    *" push "*)
      case "$normalizado" in
        *"--force"*|*" -f "*|*"--force-with-lease"*)
          bloquear "un push forzado reescribe la historia de la rama remota y puede borrar trabajo de otra persona. Si la rama quedó mal, abrí una rama nueva desde el commit bueno." ;;
        *" origin main "*|*" origin HEAD:main "*|*" origin main:"*)
          bloquear "CONTRIBUTING.md dice: una rama por cambio, nunca directo a main. Abrí una rama y un PR." ;;
      esac
      ;;
  esac

  case "$normalizado" in
    *" reset --hard"*)
      bloquear "reset --hard tira los cambios sin guardarlos en ningún lado. Usá 'git stash' si necesitás limpiar el working tree." ;;
    *" clean -f"*|*" clean -df"*|*" clean -xdf"*|*" clean -fd"*)
      bloquear "clean -f borra archivos sin seguimiento y no hay reflog que los recupere. Revisá con 'git clean -n' y borrá a mano lo que sobre." ;;
    *" branch -D "*)
      bloquear "branch -D borra una rama sin verificar que esté mergeada. Usá 'git branch -d', que se niega si hay commits sin integrar." ;;
    *" checkout . "*|*" restore . "*)
      bloquear "eso descarta todo el working tree de una. Nombrá los archivos que querés revertir." ;;
  esac
done <<EOF
$separados
EOF

exit 0
