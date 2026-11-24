// ---------------------------------------------------------------------------
// Anotación: etiqueta + comentario sobre un work item o un PR
// ---------------------------------------------------------------------------

/**
 * Lo que un adapter deja visible afuera (issue, work item, PR) cuando el server
 * necesita que una decisión quede a la vista de quien mira el tracker, p.ej. una
 * firma propia de QA o de review.
 *
 * - `labels`: se agregan sin sacar las que ya tiene el item. Si no existen en el
 *   provider, el adapter las crea.
 * - `body`: markdown del comentario. Si lleva un marcador de anotación (ver
 *   `annotationMarker`), el adapter es idempotente por ese marcador: reanotar con
 *   el mismo marcador **actualiza** el comentario existente en vez de duplicarlo.
 *   Sin marcador, cada llamada agrega un comentario nuevo.
 *
 * Un adapter que todavía no sabe anotar tira un error explícito: anotar en
 * silencio "nada" haría creer que la marca quedó puesta.
 */
export interface Annotation {
  labels: string[];
  body: string;
}

const MARKER_PREFIX = 'sdlc-annotation:';
const MARKER_RE = /<!-- sdlc-annotation:([^\s]+) -->/;

/**
 * Marcador oculto (comentario HTML, no se ve en el markdown renderizado) que
 * identifica una anotación para poder actualizarla en un reintento.
 *
 * La clave se codifica con `encodeURIComponent` para que nada en ella (p.ej. un
 * `-->` dentro de un story_id) cierre el comentario HTML antes de tiempo.
 */
export function annotationMarker(key: string): string {
  if (!key) throw new Error('annotationMarker: la clave no puede ser vacía');
  return `<!-- ${MARKER_PREFIX}${encodeURIComponent(key)} -->`;
}

/** Devuelve el primer marcador de anotación que aparece en `body`, tal cual está escrito. */
export function findAnnotationMarker(body: string): string | undefined {
  return MARKER_RE.exec(body)?.[0];
}
