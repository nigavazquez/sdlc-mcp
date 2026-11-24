import { findAnnotationMarker, type Annotation } from '@sdlc/adapters-contracts';

/** Lo anotado sobre un item: etiquetas sin repetir y comentarios en orden. */
export interface RecordedAnnotations {
  labels: string[];
  comments: string[];
}

/**
 * Registro en memoria de anotaciones, con la misma semántica que GitHub: las
 * etiquetas se suman sin repetirse y un comentario con el mismo marcador
 * reemplaza al anterior en vez de duplicarse. Lo usan los adapters in-memory
 * para que los tests de las tools puedan leer qué quedó anotado.
 */
export class InMemoryAnnotationLog {
  private readonly byKey = new Map<string, RecordedAnnotations>();

  record(key: string, annotation: Annotation): void {
    const entry = this.byKey.get(key) ?? { labels: [], comments: [] };
    for (const label of annotation.labels) {
      if (!entry.labels.includes(label)) entry.labels.push(label);
    }
    if (annotation.body) {
      const marker = findAnnotationMarker(annotation.body);
      const idx = marker ? entry.comments.findIndex((c) => c.includes(marker)) : -1;
      if (idx >= 0) entry.comments[idx] = annotation.body;
      else entry.comments.push(annotation.body);
    }
    this.byKey.set(key, entry);
  }

  get(key: string): RecordedAnnotations {
    const entry = this.byKey.get(key);
    return { labels: [...(entry?.labels ?? [])], comments: [...(entry?.comments ?? [])] };
  }
}
