/**
 * Diagramas mermaid como imagen en los documentos publicados (historia #55).
 *
 * El doc store de Drive sube el markdown y deja que Drive lo convierta a Google Doc. Ese
 * import no dibuja mermaid: el bloque queda como código. Pero sí conserva una imagen
 * embebida como data URI (spike del 2026-11-26), así que alcanza con reemplazar cada
 * bloque por su PNG antes de subir la versión Doc. El `.md` sigue llevando el fuente.
 *
 * El render lo hace el servicio de diagramas (`infra/diagrams/server.mjs`, mermaid-cli con
 * Chromium), en su propio contenedor. Sin `DIAGRAMS_URL` no hay renderer y el documento
 * sale como antes.
 */

export interface DiagramRenderer {
  /** Devuelve el PNG del diagrama. Tira si no se puede dibujar. */
  render(source: string): Promise<Buffer>;
}

export interface EmbedResult {
  markdown: string;
  rendered: number;
  /** Diagramas que quedaron como código, numerados desde 1 en orden de aparición. */
  failed: { index: number; error: string }[];
}

/** Un bloque ```mermaid … ``` que ocupa líneas completas. */
const MERMAID_BLOCK = /^```mermaid[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*$/gm;

export async function embedMermaidDiagrams(
  markdown: string,
  renderer: DiagramRenderer,
): Promise<EmbedResult> {
  const blocks = [...markdown.matchAll(MERMAID_BLOCK)];
  if (blocks.length === 0) return { markdown, rendered: 0, failed: [] };

  const failed: EmbedResult['failed'] = [];
  const images: (string | null)[] = [];
  // En serie: cada render levanta un Chromium; en paralelo se come la memoria del contenedor.
  for (const [i, block] of blocks.entries()) {
    try {
      const png = await renderer.render(block[1] ?? '');
      images.push(`![Diagrama ${i + 1}](data:image/png;base64,${png.toString('base64')})`);
    } catch (err) {
      images.push(null);
      failed.push({ index: i + 1, error: (err as Error).message });
    }
  }

  let i = 0;
  const out = markdown.replace(MERMAID_BLOCK, (whole) => images[i++] ?? whole);
  return { markdown: out, rendered: images.filter(Boolean).length, failed };
}

export interface HttpRendererOptions {
  /** Base del servicio de diagramas, p. ej. `http://diagrams:3100`. Default `DIAGRAMS_URL`. */
  url?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * Renderer que le pide el PNG al servicio de diagramas (`infra/diagrams/server.mjs`), o
 * `null` si no hay `DIAGRAMS_URL`. El servicio vive en otro contenedor para que Chromium no
 * engorde la imagen del server.
 */
export function createHttpRenderer(opts: HttpRendererOptions = {}): DiagramRenderer | null {
  const base = (opts.url ?? process.env.DIAGRAMS_URL ?? '').replace(/\/+$/, '');
  if (!base) return null;
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const doFetch = opts.fetchImpl ?? fetch;
  return {
    async render(source) {
      const res = await doFetch(`${base}/render`, {
        method: 'POST',
        headers: { 'content-type': 'text/plain; charset=utf-8' },
        body: source,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        const detail = (await res.text().catch(() => '')).slice(0, 300);
        throw new Error(`servicio de diagramas: ${res.status}${detail ? ` ${detail}` : ''}`);
      }
      const png = Buffer.from(await res.arrayBuffer());
      if (png.subarray(0, 4).toString('hex') !== '89504e47') {
        throw new Error('servicio de diagramas: la respuesta no es un PNG');
      }
      return png;
    },
  };
}

/** Renderer del proceso: el servicio de diagramas si está configurado. */
export function defaultDiagramRenderer(): DiagramRenderer | null {
  return createHttpRenderer();
}
