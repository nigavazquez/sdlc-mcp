import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { TenantCtx } from '@sdlc/adapters-contracts';
import type { FlowStore } from '../../state/index.js';
import { resolveFlowForCtx } from './flow-access.js';
import { isNoOpDocStoreAdapter } from '../../adapters/doc-store-provider.js';
import type { DocStoreProvider } from '../../adapters/doc-store-provider.js';

export const VerifyArtifactInput = z.object({
  flow_id: z.string().min(1),
  kind: z.enum(['prd', 'rfc', 'adr', 'change_note']),
});
export type VerifyArtifactInput = z.infer<typeof VerifyArtifactInput>;

/**
 * Veredictos posibles. `ok:true` sale sólo con `match` y `match_normalized`:
 * la invariante es **ok:true ⟺ el contenido del documento es el que se ancló**.
 *
 * Un mismatch no es "la tool funcionó y encontró algo", es "la tool no pudo
 * confirmar la integridad": devolverlo con `ok:true` y el veredicto escondido en
 * `data` deja que un agente que sólo mira `ok` siga de largo sobre un PRD
 * adulterado. Por eso mismatch / unreachable / not_verifiable salen con
 * `ok:false` y el veredicto igual va en `data` para quien quiera discriminar.
 */
export type VerifyVerdict =
  | 'match'
  | 'match_normalized'
  | 'mismatch'
  | 'unreachable'
  | 'not_verifiable';

/**
 * Normalizaciones que perdonamos al comparar, y por qué exactamente estas tres.
 *
 * Evidencia del camino de publicación (`GoogleDriveDocStoreAdapter.upsertObject`):
 * el `.md` se sube con `media = { mimeType: 'text/markdown', body: input.markdown }`
 * y sin `targetMimeType`, así que Drive **no convierte nada** —guarda esos bytes tal
 * cual— y `fetch()` los baja con `alt:'media'`. O sea: el round-trip por el `.md` es
 * byte a byte exacto mientras nadie toque el archivo. No hace falta normalizar nada
 * para evitar falsos positivos del sistema como está construido.
 *
 * Entonces normalizamos sólo el ruido que introduce un **editor**, no el doc store:
 * alguien abre el `.md` y lo vuelve a guardar desde Windows (CRLF), un editor le
 * mete un BOM, o le agrega/saca el salto de línea final. Los tres reescriben bytes
 * sin cambiar una sola palabra de lo que el documento dice.
 *
 * Lo que **no** normalizamos, a propósito: espacios interiores, espacios al final de
 * cada línea, normalización Unicode (NFC/NFD) y mayúsculas. Todo eso puede cambiar lo
 * que el documento dice o cómo se renderiza, y perdonarlo vacía de sentido al hash.
 */
export type Normalizacion = 'bom' | 'crlf' | 'trailing_newline';

interface Candidato {
  texto: string;
  aplicadas: Normalizacion[];
}

/**
 * Por qué candidatos y no una función de normalización.
 *
 * La normalización canónica sólo sirve si se aplica a **los dos lados**, y del lado
 * del ancla no tenemos el texto: tenemos su sha256 y nada más. Si normalizáramos
 * únicamente lo que bajamos del doc store, un ancla calculada sobre un markdown que
 * terminaba en "\n" nunca podría coincidir con la versión recortada, y el caso más
 * común (documento intacto, guardado de nuevo en CRLF) seguiría dando mismatch.
 *
 * Entonces reconstruimos hacia atrás: generamos el conjunto **acotado y explícito**
 * de textos que podrían haber producido el ancla si el único cambio fue ruido de
 * editor, y preguntamos si alguno hashea igual. Son a lo sumo 12 variantes (BOM sí/no
 * × CRLF sí/no × final tal cual / sin saltos / con exactamente uno), todas derivadas
 * de los bytes que realmente bajamos. No es un hash más laxo: es la misma igualdad
 * exacta, evaluada contra una lista corta de reescrituras que no cambian el contenido.
 */
function candidatosNormalizados(texto: string): Candidato[] {
  let nivel: Candidato[] = [{ texto, aplicadas: [] }];

  // 1) BOM UTF-8 al inicio.
  nivel = nivel.flatMap((c) =>
    c.texto.charCodeAt(0) === 0xfeff
      ? [c, { texto: c.texto.slice(1), aplicadas: [...c.aplicadas, 'bom' as const] }]
      : [c],
  );

  // 2) CRLF y CR sueltos → LF.
  nivel = nivel.flatMap((c) =>
    /\r/.test(c.texto)
      ? [c, { texto: c.texto.replace(/\r\n?/g, '\n'), aplicadas: [...c.aplicadas, 'crlf' as const] }]
      : [c],
  );

  // 3) Salto de línea final: sin ninguno, o con exactamente uno. Sólo al final del
  //    archivo; el interior queda intacto.
  nivel = nivel.flatMap((c) => {
    const pelado = c.texto.replace(/[\r\n]+$/, '');
    const aplicadas = [...c.aplicadas, 'trailing_newline' as const];
    return [c, { texto: pelado, aplicadas }, { texto: `${pelado}\n`, aplicadas }];
  });

  // Deduplicamos por texto quedándonos con la derivación más barata, y sacamos el
  // candidato de cero normalizaciones: ese ya se comparó estricto antes de llamar acá.
  const porTexto = new Map<string, Candidato>();
  for (const c of nivel) {
    const previo = porTexto.get(c.texto);
    if (!previo || c.aplicadas.length < previo.aplicadas.length) porTexto.set(c.texto, c);
  }
  return [...porTexto.values()]
    .filter((c) => c.aplicadas.length > 0)
    .sort((a, b) => a.aplicadas.length - b.aplicadas.length);
}

function sha256de(texto: string): string {
  return createHash('sha256').update(texto, 'utf8').digest('hex');
}

export function makeVerifyArtifactTool(store: FlowStore, docStoreProvider: DocStoreProvider) {
  return {
    name: 'verify_artifact',
    description:
      'Verifies that the PRD, RFC or change note stored in the doc store still matches the sha256 recorded at submit time. ' +
      'Fetches the published .md from the configured doc store, recomputes the hash over the fetched bytes and ' +
      'compares it against flow.prd_ref.sha256 / flow.rfc_ref.sha256 / flow.change_note_ref.sha256. Read-only: it never writes to the flow. ' +
      'Returns ok:true only when the content is accounted for (byte-identical, or identical after forgiving ' +
      'BOM / CRLF / trailing-newline rewrites, which is reported explicitly). A hash mismatch, an unfetchable ' +
      'document or a reference that cannot be verified all return ok:false with the verdict in data.verdict. ' +
      'kind="adr" is rejected: submit_adr never persists a sha256, so there is no anchor to compare against.',
    inputSchema: VerifyArtifactInput,
    handler: async (input: VerifyArtifactInput, ctx: TenantCtx) => {
      const resolved = await resolveFlowForCtx(store, ctx, input.flow_id);
      if (!resolved.ok) return { ok: false, error: resolved.error };
      const flow = resolved.flow;

      // El ADR no tiene ancla. `submit_adr` guarda url/external_id/gdoc_id en
      // `adr_refs` y nunca un sha256, así que no hay contra qué comparar: podríamos
      // bajar el documento pero no afirmar nada sobre él. Decirlo es mejor que
      // devolver un OK que no significa nada.
      if (input.kind === 'adr') {
        return {
          ok: false,
          error:
            'Los ADR no se pueden verificar: submit_adr publica el documento pero no persiste un sha256 en ' +
            'adr_refs, así que no hay hash de referencia contra el cual comparar los bytes traídos. ' +
            'Verificá el PRD o el RFC con verify_artifact({kind:"prd"}) o verify_artifact({kind:"rfc"}), ' +
            'y para ver qué ADR tiene el flow usá get_flow_state.',
          data: { verdict: 'not_verifiable' as VerifyVerdict, kind: input.kind },
        };
      }

      // Los tres artefactos que sí tienen ancla. La nota de cambio se verifica igual
      // que los otros dos: `submit_change_note` persiste su sha256.
      const REFS = {
        prd: { ref: flow.prd_ref, tool: 'submit_prd', nombre: 'PRD' },
        rfc: { ref: flow.rfc_ref, tool: 'submit_rfc', nombre: 'RFC' },
        change_note: {
          ref: flow.change_note_ref,
          tool: 'submit_change_note',
          nombre: 'nota de cambio',
        },
      } as const;
      const { ref, tool: submitTool, nombre } = REFS[input.kind];

      if (!ref) {
        return {
          ok: false,
          error:
            `El flow "${flow.flow_id}" no tiene ${input.kind}_ref: nunca se envió un ${nombre} ` +
            `para este flow, así que no hay nada que verificar. Enviá el documento con ${submitTool} y ` +
            'después volvé a llamar verify_artifact.',
          data: { verdict: 'not_verifiable' as VerifyVerdict, kind: input.kind },
        };
      }

      if (!ref.sha256) {
        return {
          ok: false,
          error:
            `El ${input.kind}_ref del flow "${flow.flow_id}" no tiene sha256 guardado, así que no hay ancla de ` +
            `integridad contra la cual comparar. Reenviá el documento con ${submitTool} para que se recalcule y ` +
            'se persista el hash, y después volvé a llamar verify_artifact.',
          data: { verdict: 'not_verifiable' as VerifyVerdict, kind: input.kind, ref },
        };
      }

      // `external_id` es el id del archivo `.md` en Drive (ver el comentario de
      // `DocRef.id`): es lo único que `DocStoreAdapter.fetch` sabe resolver.
      //
      // `repo_path` NO sirve para localizar el documento: es un string que el
      // agente inventó en submit_*, nadie lo resuelve contra un filesystem ni
      // contra un repo, y el doc store no lo usa para nada. Lo devolvemos en
      // `data` como dato informativo, nunca como algo que hayamos verificado.
      if (!ref.external_id) {
        // Caso "sólo Doc nativo": aunque tuviéramos el gdoc_id, un Google Doc no se
        // baja con `alt:'media'` (Drive rechaza el download de archivos sin contenido
        // binario) y exportarlo re-serializa el documento, así que el hash no podría
        // coincidir nunca. Un OK ahí sería mentira y un mismatch también.
        const soloGdoc = Boolean(ref.gdoc_id);
        return {
          ok: false,
          error: soloGdoc
            ? `El ${input.kind}_ref sólo tiene gdoc_id (el Google Doc nativo) y no external_id (el .md fiel). ` +
              'Un Doc nativo no se puede verificar: no se baja tal cual, se exporta re-serializado, así que su ' +
              `hash nunca va a coincidir con el del markdown original. Reenviá el documento con ${submitTool} ` +
              'para que se vuelva a publicar el .md y quede el external_id, y después llamá verify_artifact.'
            : `El ${input.kind}_ref del flow "${flow.flow_id}" no tiene external_id, así que el documento nunca ` +
              'llegó a publicarse en el doc store (o se publicó contra el adapter no-op) y no hay nada que ' +
              `traer para comparar. Configurá doc_store (google-drive) en tenant_integrations para el proyecto ` +
              `"${flow.project}", reenviá el documento con ${submitTool} y después llamá verify_artifact.`,
          data: {
            verdict: 'not_verifiable' as VerifyVerdict,
            kind: input.kind,
            expected_sha256: ref.sha256,
            repo_path: ref.repo_path ?? null,
          },
        };
      }

      // Guardas antes de cualquier I/O: resolver el adapter y descartar el no-op.
      let ds: Awaited<ReturnType<typeof docStoreProvider.resolve>>;
      try {
        ds = await docStoreProvider.resolve(ctx, flow);
      } catch (err) {
        return {
          ok: false,
          error:
            `No se pudo resolver el doc_store del proyecto "${flow.project}": ${(err as Error).message}. ` +
            'Revisá la config de doc_store en tenant_integrations (kind y secret_ref) desde el panel admin ' +
            '(Integraciones) y volvé a llamar verify_artifact.',
          data: { verdict: 'unreachable' as VerifyVerdict, kind: input.kind },
        };
      }

      // Rechazamos el no-op por el mismo motivo que submit_adr: no trae nada real.
      // Acá es peor todavía —`NoOpDocStoreAdapter.fetch` devuelve markdown vacío,
      // así que "verificar" contra él produciría un mismatch fabricado contra el
      // hash del string vacío, o, si algún día devolviera otra cosa, un OK que no
      // significa nada. Se detecta por el discriminante `is_noop` y no con
      // `instanceof`: ver el comentario de `isNoOpDocStoreAdapter`, `instanceof`
      // falla abierto.
      if (isNoOpDocStoreAdapter(ds)) {
        return {
          ok: false,
          error:
            `No hay doc_store configurado para el proyecto "${flow.project}": el adapter no-op no trae ningún ` +
            'documento, así que verificar contra él devolvería un veredicto inventado. Configurá doc_store ' +
            `(google-drive) en tenant_integrations para ese proyecto, reenviá el documento con ${submitTool} ` +
            'para que se publique de verdad y después volvé a llamar verify_artifact.',
          data: { verdict: 'not_verifiable' as VerifyVerdict, kind: input.kind },
        };
      }

      let traido: { markdown: string; version: string };
      try {
        traido = await ds.fetch(ref.external_id, ctx);
      } catch (err) {
        return {
          ok: false,
          error:
            `No se pudo traer el ${nombre} del doc_store (external_id "${ref.external_id}"): ` +
            `${(err as Error).message}. El documento puede haber sido borrado, movido fuera del shared drive o ` +
            'la service account puede haber perdido el permiso. Revisá el archivo en Drive ' +
            `(${ref.url ?? 'sin url guardada'}); si ya no existe, reenvialo con ${submitTool} para republicarlo.`,
          data: {
            verdict: 'unreachable' as VerifyVerdict,
            kind: input.kind,
            external_id: ref.external_id,
            expected_sha256: ref.sha256,
          },
        };
      }

      // `GoogleDriveDocStoreAdapter.fetch` hace `res.data as unknown as string` sin
      // chequear: si gaxios decidió parsear el body (por ejemplo porque el archivo
      // parece JSON) lo que vuelve es un objeto, y hashearlo daría un hash de algo
      // que no es el documento. Preferimos decir que no se puede verificar antes que
      // comparar contra una serialización accidental.
      if (typeof traido?.markdown !== 'string') {
        return {
          ok: false,
          error:
            `El doc_store devolvió el ${nombre} en un formato que no es texto ` +
            `(${typeof traido?.markdown}), así que no se puede recomputar el sha256 sobre los bytes originales. ` +
            `Revisá el archivo en Drive (external_id "${ref.external_id}") y reenvialo con ${submitTool} si ` +
            'quedó guardado con un mime raro; después volvé a llamar verify_artifact.',
          data: {
            verdict: 'not_verifiable' as VerifyVerdict,
            kind: input.kind,
            external_id: ref.external_id,
            expected_sha256: ref.sha256,
          },
        };
      }

      const actual_sha256 = sha256de(traido.markdown);
      const base = {
        kind: input.kind,
        external_id: ref.external_id,
        version: traido.version,
        expected_sha256: ref.sha256,
        actual_sha256,
        // Informativo, NO verificado: nadie resuelve este path contra nada.
        repo_path: ref.repo_path ?? null,
        url: ref.url ?? null,
      };

      if (actual_sha256 === ref.sha256) {
        return {
          ok: true,
          data: {
            ...base,
            verdict: 'match' as VerifyVerdict,
            strict: true,
            normalizations_applied: [] as Normalizacion[],
          },
          next_actions: ['get_flow_state'],
        };
      }

      // Segundo intento, sólo sobre el ruido de editor documentado arriba: ¿alguna
      // reescritura que no cambia el contenido produce exactamente el ancla?
      for (const candidato of candidatosNormalizados(traido.markdown)) {
        if (sha256de(candidato.texto) !== ref.sha256) continue;
        return {
          ok: true,
          data: {
            ...base,
            verdict: 'match_normalized' as VerifyVerdict,
            // `strict:false` es la parte importante: el documento dice lo mismo, pero
            // los bytes NO son los que se anclaron. Va explícito para que quien lea
            // el resultado sepa que el OK viene con una salvedad y cuál.
            strict: false,
            normalizations_applied: candidato.aplicadas,
          },
          next_actions: ['get_flow_state'],
        };
      }

      return {
        ok: false,
        error:
          `El ${nombre} publicado no coincide con el sha256 registrado al enviarlo: ` +
          `esperado ${ref.sha256}, obtenido ${actual_sha256}. El documento se editó después de ${submitTool} ` +
          '(o se publicó otro cuerpo encima). Abrí el documento ' +
          `(${ref.url ?? `external_id "${ref.external_id}"`}), y si el contenido actual es el correcto ` +
          `reenvialo con ${submitTool} para reanclar el hash; si no, revertí la edición en Drive y volvé a ` +
          'llamar verify_artifact.',
        data: {
          ...base,
          verdict: 'mismatch' as VerifyVerdict,
          strict: false,
          normalizations_applied: [] as Normalizacion[],
        },
        next_actions: [submitTool, 'verify_artifact'],
      };
    },
  };
}
