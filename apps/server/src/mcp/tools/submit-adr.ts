import { z } from 'zod';
import type { TenantCtx } from '@sdlc/adapters-contracts';
import type { FlowStore } from '../../state/index.js';
import { resolveFlowForCtx } from './flow-access.js';
import { assertRole } from './role-guard.js';
import { assertFlowNotAborted } from './abort-flow.js';
import { isNoOpDocStoreAdapter } from '../../adapters/doc-store-provider.js';
import type { DocStoreProvider } from '../../adapters/doc-store-provider.js';
import type { AdminStore } from '../../admin/store.js';
import { resolveDocFolderPath } from '../../docs/folder-path.js';

export const SubmitAdrInput = z.object({
  flow_id:      z.string().min(1),
  title:        z.string().min(3),
  adr_markdown: z.string().min(50),
});
export type SubmitAdrInput = z.infer<typeof SubmitAdrInput>;

export function makeSubmitAdrTool(
  store: FlowStore,
  docStoreProvider: DocStoreProvider,
  adminStore?: AdminStore,
) {
  return {
    name: 'submit_adr',
    description:
      'Publishes an Architecture Decision Record (ADR) markdown for a flow to the configured doc store. ' +
      'ADRs are stored under the flow\'s adr/ subfolder with an incrementing filename (e.g. 0001-title.md). ' +
      'Can be called at any phase once the flow exists.',
    inputSchema: SubmitAdrInput,
    handler: async (input: SubmitAdrInput, ctx: TenantCtx) => {
      const resolved = await resolveFlowForCtx(store, ctx, input.flow_id);
      if (!resolved.ok) return { ok: false, error: resolved.error };
      const flow = resolved.flow;

      // Guarda de rol antes de cualquier side-effect: el ADR se publica en el doc
      // store, que es una escritura externa e irreversible desde acá.
      //
      // `tech-lead` solo. El ADR es la decisión de arquitectura, y es además la
      // salida que `submit_rfc` nombra cuando el RFC ya no se puede reescribir
      // porque el backlog se derivó ("Registrá el cambio de arquitectura con
      // submit_adr"). Si el ADR lo pudiera firmar alguien más que el rol que firma
      // el RFC, esa salida sería un desvío alrededor de la guarda de `submit_rfc`.
      const roleDenied = assertRole(ctx, ['tech-lead'], 'submit_adr', flow.project);
      if (roleDenied) {
        return {
          ok: false,
          error:
            `${roleDenied} Verificá tus roles con whoami y pedile a alguien con rol tech-lead en ese ` +
            'workspace que ejecute submit_adr.',
        };
      }

      // Un flow abandonado no acumula decisiones de arquitectura nuevas.
      const abortedDenied = assertFlowNotAborted(flow, 'submit_adr');
      if (abortedDenied) return { ok: false, error: abortedDenied };

      const adrIndex = (flow.adr_count ?? 0) + 1;
      const adr_filename = `${String(adrIndex).padStart(4, '0')}-${slugify(input.title)}.md`;

      // Resolve doc store and publish FIRST — failure is FATAL for ADR.
      // Unlike PRD/RFC, ADR has no sha256 fallback; the Drive copy IS the artifact.
      let ds: Awaited<ReturnType<typeof docStoreProvider.resolve>>;
      try {
        ds = await docStoreProvider.resolve(ctx, flow);
      } catch (err) {
        return { ok: false, error: `ADR publish failed: ${(err as Error).message}` };
      }

      // Rechazamos el no-op: el ADR no tiene fallback de sha256, así que el
      // no-op dejaría un registro fantasma (un adr_ref sin documento detrás).
      // Se detecta por el discriminante `is_noop` y no con `instanceof`: ver el
      // comentario de `isNoOpDocStoreAdapter` — `instanceof` falla abierto.
      if (isNoOpDocStoreAdapter(ds)) {
        return {
          ok: false,
          error:
            `No hay doc_store configurado para el proyecto "${flow.project}": el adapter no-op no publica ` +
            'nada y dejaría un ADR fantasma (una referencia sin documento detrás). Configurá doc_store ' +
            '(google-drive o github-repo) en tenant_integrations para ese proyecto y volvé a llamar submit_adr.',
        };
      }

      // La ruta histórica manda: si el flow ya publicó, sus documentos viven ahí.
      // Recién si no la tiene se deriva del modelo (group + workspace del flow).
      const folderPath =
        flow.doc_folder_path ??
        (adminStore
          ? await resolveDocFolderPath({ adminStore, workspaceId: flow.project })
          : [flow.project]);

      let publishResult: { id?: string; url?: string; gdoc_id?: string };
      try {
        publishResult = await ds.publish({
          title: input.title,
          markdown: input.adr_markdown,
          doc_kind: 'adr',
          flow_folder: flow.slug,
          folder_path: folderPath,
          adr_filename,
        }, ctx);
      } catch (err) {
        return { ok: false, error: `ADR publish failed: ${(err as Error).message}` };
      }

      // Build ref only from a successful, real publish
      const newRef: Record<string, string> = {};
      if (publishResult.url) newRef.url = publishResult.url;
      if (publishResult.id && publishResult.id !== 'noop') newRef.external_id = publishResult.id;
      if (publishResult.gdoc_id) newRef.gdoc_id = publishResult.gdoc_id;

      const existingRefs = flow.adr_refs ?? [];
      const updated = await store.updateFlow(flow.flow_id, {
        adr_refs: [...existingRefs, newRef],
        adr_count: adrIndex,
        // Acá el publish ya fue exitoso: submit_adr es fatal si falla (corta arriba con
        // ok:false) y rechaza el no-op antes de publicar. Fija la ruta si no la había.
        ...(flow.doc_folder_path === undefined ? { doc_folder_path: folderPath } : {}),
      });

      await store.appendEvent({
        flow_id: flow.flow_id,
        type: 'adr.submitted',
        actor: ctx.userId,
        payload: {
          adr_index: adrIndex,
          adr_filename,
          drive_url: publishResult.url ?? null,
          drive_id: (publishResult.id && publishResult.id !== 'noop') ? publishResult.id : null,
          gdoc_id: publishResult.gdoc_id ?? null,
        },
      });

      return {
        ok: true,
        data: { flow: updated, adr_filename, adr_index: adrIndex, drive_url: publishResult.url ?? null },
        next_actions: ['get_flow_state'],
      };
    },
  };
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'adr';
}
