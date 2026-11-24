import { findAnnotationMarker, type Annotation } from '@sdlc/adapters-contracts';

// ---------------------------------------------------------------------------
// Anotación en GitHub — compartida por issues y PRs
// ---------------------------------------------------------------------------
//
// En GitHub un PR es un issue a efectos de etiquetas y comentarios: los dos usan
// `/repos/{o}/{r}/issues/{n}/labels` y `/issues/{n}/comments`. Por eso el adapter
// de issues y el de PRs comparten esta función y sólo aportan su `request` (cada
// uno con sus propios tipos de error) y el número.
//
// Pasos, pensados para que un reintento después de una falla parcial no duplique:
//
//   1. Crear cada etiqueta en el repo (`POST /labels`). 422 = ya existe, no es error.
//   2. Agregarlas al issue/PR (`POST /issues/{n}/labels`): agregar una que ya tiene
//      no falla ni la repite.
//   3. Si el body tiene marcador, buscar un comentario con ese marcador
//      (paginando) y hacer PATCH; si no hay, POST.

/** El `request` de cada adapter: tira ante un status no-2xx, con `.status` en el error. */
export type GitHubRequest = <T>(
  url: string,
  method: 'GET' | 'POST' | 'PATCH',
  body?: unknown,
) => Promise<T>;

/** Páginas de 100 comentarios. El tope evita un loop sin fin ante una API que no corta. */
const COMMENTS_PER_PAGE = 100;
const MAX_COMMENT_PAGES = 50;

export async function annotateGitHubIssue(
  request: GitHubRequest,
  /** `https://api.github.com/repos/{owner}/{repo}`, con owner/repo ya codificados. */
  repoApiUrl: string,
  issueNumber: number,
  annotation: Annotation,
): Promise<void> {
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
    throw new Error(`annotate: número de issue/PR inválido: ${issueNumber}`);
  }
  const issueUrl = `${repoApiUrl}/issues/${issueNumber}`;

  if (annotation.labels.length > 0) {
    for (const name of annotation.labels) {
      await ensureLabel(request, repoApiUrl, name);
    }
    await request<unknown>(`${issueUrl}/labels`, 'POST', { labels: annotation.labels });
  }

  if (!annotation.body) return;

  const marker = findAnnotationMarker(annotation.body);
  const existing = marker ? await findCommentWithMarker(request, issueUrl, marker) : undefined;
  if (existing !== undefined) {
    await request<unknown>(`${repoApiUrl}/issues/comments/${existing}`, 'PATCH', {
      body: annotation.body,
    });
  } else {
    await request<unknown>(`${issueUrl}/comments`, 'POST', { body: annotation.body });
  }
}

async function ensureLabel(
  request: GitHubRequest,
  repoApiUrl: string,
  name: string,
): Promise<void> {
  try {
    await request<unknown>(`${repoApiUrl}/labels`, 'POST', { name });
  } catch (err) {
    // 422 = "already_exists". Cualquier otra cosa (auth, rate limit) se propaga.
    if ((err as { status?: unknown }).status === 422) return;
    throw err;
  }
}

async function findCommentWithMarker(
  request: GitHubRequest,
  issueUrl: string,
  marker: string,
): Promise<number | undefined> {
  for (let page = 1; page <= MAX_COMMENT_PAGES; page++) {
    const comments = await request<Array<{ id: number; body?: string | null }>>(
      `${issueUrl}/comments?per_page=${COMMENTS_PER_PAGE}&page=${page}`,
      'GET',
    );
    const found = (comments ?? []).find((c) => (c.body ?? '').includes(marker));
    if (found) return found.id;
    if (!comments || comments.length < COMMENTS_PER_PAGE) return undefined;
  }
  return undefined;
}
