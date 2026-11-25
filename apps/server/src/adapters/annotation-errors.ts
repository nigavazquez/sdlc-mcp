/**
 * El provider todavía no sabe anotar (etiqueta + comentario). Se tira en vez de
 * no hacer nada: una anotación que "pasa" sin dejar marca haría creer que la
 * firma quedó visible afuera cuando no.
 *
 * GitHub, Azure DevOps y Linear ya anotan; queda para el próximo provider que se sume.
 */
export class AnnotationNotSupportedError extends Error {
  constructor(public readonly provider: string) {
    super(
      `anotación no soportada por ${provider} todavía. ` +
        'Usá un provider con soporte (github, azure-devops, linear) o esperá a que se implemente.',
    );
    this.name = 'AnnotationNotSupportedError';
  }
}
