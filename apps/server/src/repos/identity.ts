import type { PullRequestRef } from '@sdlc/adapters-contracts';

// ---------------------------------------------------------------------------
// Identidad canónica de un repo, por proveedor.
//
// Vive acá y no junto al gate porque tiene tres consumidores en capas distintas:
// el gate de code review (`submit_review_outcome`, `request_code_review`), que
// compara el repo declarado contra el del PR; `create_stories`, que exige que la
// story nazca con repo; y la validación del frontmatter del RFC
// (`validation/rfc-frontmatter.ts`), que **avisa** por un repo no interpretable
// mientras el autor todavía tiene el documento abierto, en vez de dejar que el
// fail-closed aparezca semanas después en el review.
//
// El contrato de todas: `null` significa "no puedo comparar". Los dos primeros
// consumidores fallan cerrado con eso; el tercero es un documento y sólo emite
// un warning — ver `isComparableRepo`.
// ---------------------------------------------------------------------------

/** Decodifica %XX sin tirar: `parsePrUrl` de GitHub URL-encodea owner/repo. */
export function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Recorta barras finales y el sufijo `.git` de un repo URL. */
function trimRepoUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, '').replace(/\.git$/i, '');
}

/** Host de GitHub, con esquema y credencial opcionales, seguido de la barra. */
const GITHUB_HOST = /^(?:https?:\/\/)?(?:[^@/\s]+@)?(?:www\.)?github\.com\//i;
/** Cualquier `esquema://` — si no es el host de GitHub, no es comparable. */
const ANY_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;
/** Primer segmento con punto = es un host (`evil.com/acme/checkout`), no un owner. */
const LOOKS_LIKE_HOST = /^[^/]*\.[^/]*\//;

/**
 * Identidad canónica de un repo de GitHub: `owner/repo` en minúsculas.
 *
 * Acepta las formas en las que la gente escribe un repo de verdad, incluida la
 * que sale de copiar la barra del navegador estando parado en el repo:
 *
 *   https://github.com/acme/checkout            → acme/checkout
 *   https://github.com/acme/checkout.git/       → acme/checkout
 *   git@github.com:acme/checkout.git            → acme/checkout
 *   acme/checkout · github.com/acme/checkout    → acme/checkout
 *   https://github.com/acme/checkout/tree/main  → acme/checkout
 *   https://github.com/acme/checkout/blob/main/README.md → acme/checkout
 *   https://github.com/acme/checkout?tab=readme → acme/checkout
 *   https://github.com/acme/checkout#readme     → acme/checkout
 *
 * El sufijo de path, la query y el fragment no son parte de la identidad del
 * repo: descartarlos es lo que evita que una URL perfectamente normal frene el
 * review. Lo que **no** se afloja es el host: `https://github.com.evil.io/acme/checkout`
 * y `https://evil.com/acme/checkout` siguen dando `null`, porque ahí sí la
 * diferencia es un repo distinto. Por eso un esquema que no sea el de GitHub, o
 * un primer segmento que parezca un host, se rechazan explícitamente en vez de
 * terminar interpretados como owner/repo.
 *
 * La forma corta `owner/repo` —sin host— tiene que traer **exactamente** dos
 * segmentos. Con el host explícito el resto del path es ruido conocido (`/tree/main`,
 * `/blob/...`), pero sin host no hay nada que distinga "ruido" de "el usuario está
 * describiendo otra cosa", y aceptar los dos primeros segmentos truncaba en
 * silencio: `monorepo/services/checkout` quedaba en `monorepo/services` e
 * `internal-git/acme/checkout` en `internal-git/acme`. Los dos pasaban la
 * validación del RFC y frenaban semanas después en el review con un MISMATCH
 * contra una identidad que nadie escribió, que es justo lo que esa validación
 * venía a evitar. Fail-closed: si no sabemos leerlo, `null`.
 */
export function githubRepoIdentity(raw: string): string | null {
  let s = trimRepoUrl(raw);
  if (!s || /\s/.test(s)) return null;
  // Un path absoluto (`/srv/repos/checkout`) no es un repo de GitHub: sin esto
  // se interpretaría como el owner "srv" y el repo "repos". Los relativos
  // (`./x`, `../x`) los ataja LOOKS_LIKE_HOST más abajo.
  if (s.startsWith('/')) return null;
  let hostExplicito = false;
  const scp = s.replace(/^[A-Za-z0-9._-]+@github\.com:/i, ''); // scp-like
  if (scp !== s) {
    s = scp;
    hostExplicito = true;
  }
  if (GITHUB_HOST.test(s)) {
    s = s.replace(GITHUB_HOST, '');
    hostExplicito = true;
  } else if (ANY_SCHEME.test(s) || LOOKS_LIKE_HOST.test(s)) {
    return null; // traía un host, y no es github.com
  }
  s = s.split(/[?#]/, 1)[0] ?? ''; // query y fragment fuera
  const segments = s.split('/').filter((p) => p.length > 0);
  if (segments.length < 2) return null;
  // Sin host explícito no hay sufijo de path que descartar: o es `owner/repo`, o
  // no sabemos qué es.
  if (!hostExplicito && segments.length > 2) return null;
  const owner = segments[0]!;
  // `.git` puede quedar pegado al segmento del repo cuando hay path después
  // (`.../checkout.git/tree/main`), donde `trimRepoUrl` no llega.
  const repo = segments[1]!.replace(/\.git$/i, '');
  if (!owner || !repo) return null;
  return `${safeDecode(owner)}/${safeDecode(repo)}`.toLowerCase();
}

/**
 * Identidad canónica de un repo de Azure DevOps: `org/project/repo`.
 *
 * Cubre `dev.azure.com/<org>/<project>/_git/<repo>` y el host legacy
 * `<org>.visualstudio.com/<project>/_git/<repo>`, con o sin credencial en la
 * URL, y tolera el sufijo de path / query / fragment por el mismo motivo que
 * GitHub: es lo que sale de copiar la URL del navegador.
 */
export function adoRepoIdentity(raw: string): string | null {
  const s = trimRepoUrl(raw);
  if (!s || /\s/.test(s)) return null;
  const dev = /^(?:https?:\/\/)?(?:[^@/\s]+@)?dev\.azure\.com\/([^/\s]+)\/([^/\s]+)\/_git\/([^/\s?#]+)/i.exec(s);
  if (dev) return [dev[1]!, dev[2]!, dev[3]!].map((p) => safeDecode(p).toLowerCase()).join('/');
  const legacy = /^(?:https?:\/\/)?(?:[^@/\s]+@)?([^./\s]+)\.visualstudio\.com\/([^/\s]+)\/_git\/([^/\s?#]+)/i.exec(s);
  if (legacy) return [legacy[1]!, legacy[2]!, legacy[3]!].map((p) => safeDecode(p).toLowerCase()).join('/');
  return null;
}

/** Identidad del repo declarado en la story/componente, según el proveedor. */
export function declaredRepoIdentity(kind: string, declared: string): string | null {
  if (kind === 'github') return githubRepoIdentity(declared);
  if (kind === 'azure-devops-repos') return adoRepoIdentity(declared);
  return null;
}

/**
 * ¿Este repo declarado es interpretable por *algún* proveedor conocido?
 *
 * Lo usa la validación del frontmatter del RFC, que corre sin saber todavía qué
 * `pr_provider` va a estar configurado para el proyecto. Alcanza con que una de
 * las dos identidades resuelva.
 *
 * Un `false` acá es una **señal temprana**, no un veredicto: el frontmatter lo
 * reporta como warning. Los únicos proveedores que el gate de review sabe
 * verificar son GitHub y Azure DevOps, pero eso es un requisito *del gate*, y
 * meterlo como error del validador de documentos le impedía escribir un RFC a
 * cualquier equipo en GitLab o Bitbucket, incluso a uno que sólo usa la mitad
 * PRD/RFC/shaping y nunca configura un `pr_provider`. El fail-closed sigue donde
 * importa —`request_code_review` y `submit_review_outcome`, que son las que
 * firman— y no un par de fases antes.
 */
export function isComparableRepo(declared: string): boolean {
  return githubRepoIdentity(declared) !== null || adoRepoIdentity(declared) !== null;
}

/**
 * Identidad del repo al que apunta el PR, leída del `_parsed` del adapter.
 *
 * Cada adapter ya descompuso la URL: GitHub deja `owner`/`repo` (URL-encodeados)
 * y ADO deja `org`/`project`/`repo`. Reusamos eso en vez de re-parsear la URL
 * cruda, así lo que comparamos es literalmente lo que el adapter va a usar para
 * armar el request del APPROVE.
 */
export function prRepoIdentity(kind: string, ref: PullRequestRef): string | null {
  const p = ref._parsed ?? {};
  if (kind === 'github') {
    const owner = p['owner'];
    const repo = p['repo'];
    if (!owner || !repo) return null;
    return `${safeDecode(owner)}/${safeDecode(repo)}`.toLowerCase();
  }
  if (kind === 'azure-devops-repos') {
    const org = p['org'];
    const project = p['project'];
    const repo = p['repo'];
    if (!org || !project || !repo) return null;
    return [org, project, repo].map((s) => safeDecode(s).toLowerCase()).join('/');
  }
  return null;
}

/**
 * Texto único para "declará el repo en el RFC". Lo comparten el gate del review,
 * `create_stories` y la validación del frontmatter, para que el equipo lea
 * siempre la misma salida ejecutable.
 */
export const DECLARA_EL_REPO =
  'Declaralo en el frontmatter del RFC —components: [{name, kind, repo}], o existing_repo para un ' +
  'flow de un solo repo— y reenvialo con submit_rfc.';
