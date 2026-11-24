/**
 * El provider todavía no sabe anotar (etiqueta + comentario). Se tira en vez de
 * no hacer nada: una anotación que "pasa" sin dejar marca haría creer que la
 * firma quedó visible afuera cuando no.
 */
export class AnnotationNotSupportedError extends Error {
  constructor(public readonly provider: string) {
    super(
      `anotación no soportada por ${provider} todavía (historia #25). ` +
        'Usá un provider con soporte (github) o esperá a que se implemente.',
    );
    this.name = 'AnnotationNotSupportedError';
  }
}
