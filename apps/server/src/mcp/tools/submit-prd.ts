import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { TenantCtx } from '@sdlc/adapters-contracts';
import type { FlowStore } from '../../state/index.js';
import { resolveFlowForCtx } from './flow-access.js';
import { assertRole } from './role-guard.js';
import { assertFlowNotAborted, updateFlowUnlessAborted } from './abort-flow.js';
import { validatePrd } from '../../validation/prd.js';
import type { DocStoreProvider } from '../../adapters/doc-store-provider.js';
import type { AdminStore } from '../../admin/store.js';
import { resolveDocFolderPath } from '../../docs/folder-path.js';
import {
  APPROVALS_OFF,
  hasCurrentApproval,
  invalidateApprovalsWithEvents,
  type ApprovalPolicy,
} from '../../approvals/policy.js';

/**
 * Status del flow después de un submit_prd con aprobación exigida.
 *
 * El caso normal es `prd_in_review`: el PRD queda publicado como Draft hasta que
 * lo apruebe el product-manager. La excepción es reenviar **el mismo** contenido
 * ya aprobado (por ejemplo, para republicarlo): la aprobación sigue valiendo y el
 * flow no retrocede.
 */
const STATUS_DESPUES_DE_PRD_APROBADO = new Set(['prd_ready', 'rfc_in_review', 'rfc_ready']);

export const SubmitPrdInput = z.object({
  flow_id: z.string().min(1),
  prd_markdown: z.string().min(50),
  doc_url: z.string().url().optional(),
  repo_path: z.string().optional(),
});
export type SubmitPrdInput = z.infer<typeof SubmitPrdInput>;

export function makeSubmitPrdTool(
  store: FlowStore,
  docStoreProvider: DocStoreProvider,
  adminStore?: AdminStore,
  approvals: ApprovalPolicy = APPROVALS_OFF,
) {
  return {
    name: 'submit_prd',
    description:
      'Submits the PRD markdown for a flow. Runs structural validation FIRST: a PRD that fails validation is rejected without any side effect — nothing is published, no prd_ref is stored and a previously accepted PRD is left untouched. On success stores a reference (URL/path/sha256) — not the full body — and advances the flow to status=prd_ready. If the workspace requires phase approval (APPROVALS_REQUIRED), the PRD stays as a Draft and the flow goes to status=prd_in_review until a product-manager approves it; resubmitting different content invalidates the PRD and RFC approvals, and is rejected once the epic exists.',
    inputSchema: SubmitPrdInput,
    handler: async (input: SubmitPrdInput, ctx: TenantCtx) => {
      const resolved = await resolveFlowForCtx(store, ctx, input.flow_id);
      if (!resolved.ok) return { ok: false, error: resolved.error };
      const flow = resolved.flow;

      // Guarda de rol antes de cualquier side-effect (la publicación en el doc
      // store y el avance a `prd_ready` viven más abajo). El catálogo le asigna las
      // tres fases `prd-*` a `product-manager`; `tech-lead` va como el break-glass
      // que ya usan submit_qa_results, request_code_review y submit_review_outcome.
      const roleDenied = assertRole(ctx, ['product-manager', 'tech-lead'], 'submit_prd', flow.project);
      if (roleDenied) {
        return {
          ok: false,
          error:
            `${roleDenied} Verificá tus roles con whoami y pedile a alguien con rol product-manager o ` +
            'tech-lead en ese workspace que ejecute submit_prd.',
        };
      }

      // El flow abortado es terminal: sin esto, `submit_prd` lo pisaba con
      // `prd_ready` y lo resucitaba en una sola llamada.
      const abortedDenied = assertFlowNotAborted(flow, 'submit_prd');
      if (abortedDenied) return { ok: false, error: abortedDenied };

      // Con aprobación exigida, un PRD nuevo invalida el RFC aprobado sobre el
      // anterior. Si el backlog ya se creó desde ese RFC, reescribir el PRD por atrás
      // dejaría épica e historias colgadas de algo que nadie aprobó.
      const approvalRequired = approvals.required(flow.project);
      if (approvalRequired && flow.epic_external_id) {
        return {
          ok: false,
          error:
            `No se puede reenviar el PRD: el flow ya tiene épica (${flow.epic_external_id}), creada desde el RFC aprobado. ` +
            'Un PRD nuevo invalidaría esa aprobación. Registrá el cambio con submit_adr o arrancá un flow nuevo con start_flow.',
        };
      }

      // Gate de admisión: validamos ANTES de escribir nada.
      //
      // Antes se calculaba el sha256, se publicaba en el doc store, se guardaba
      // `prd_ref` en el flow y recién después se reportaba que la validación
      // había fallado. Eso dejaba una referencia a un documento que nadie
      // aprobó y, peor, un PRD inválido pisaba la referencia del PRD válido que
      // ya estaba en el flow. Un agente que no puede producir un documento
      // válido tampoco debería poder borrar el que ya estaba.
      //
      // Si la admisión falla: cero escrituras. No se publica en el doc store
      // (la publicación vive más abajo, así que alcanza con cortar acá — no hay
      // que romper el contrato del adapter para lograrlo), no se toca el flow y
      // no se emite ningún evento. El PRD anterior queda intacto.
      const validation = validatePrd(input.prd_markdown);
      if (!validation.ok) {
        const errores = validation.issues.filter((i) => i.severity === 'error');
        const detalle = errores.map((i) => i.message).join('; ');
        return {
          ok: false,
          error:
            `El PRD no pasó la validación estructural (${errores.length} error(es)): ${detalle}. ` +
            'No se guardó ninguna referencia: el flow quedó como estaba. ' +
            'Corregí el markdown y reenvialo con submit_prd (podés chequearlo antes con validate_prd pasando prd_markdown para un dry-run).',
          // Devolvemos el detalle además del mensaje para que el agente no
          // tenga que parsear el string para saber qué secciones arreglar.
          data: { flow, validation, published: false },
          next_actions: ['validate_prd', 'submit_prd'],
        };
      }

      const sha256 = createHash('sha256').update(input.prd_markdown).digest('hex');
      const prd_ref: {
        url?: string;
        repo_path?: string;
        sha256: string;
        external_id?: string;
        gdoc_id?: string;
      } = { sha256 };
      if (input.doc_url) prd_ref.url = input.doc_url;
      if (input.repo_path) prd_ref.repo_path = input.repo_path;

      // La ruta histórica manda: si el flow ya publicó, sus documentos viven ahí.
      // Recién si no la tiene se deriva del modelo (group + workspace del flow).
      const folderPath =
        flow.doc_folder_path ??
        (adminStore
          ? await resolveDocFolderPath({ adminStore, workspaceId: flow.project })
          : [flow.project]);

      // Publish to doc store (non-fatal: sha256 is the durable anchor).
      // Track whether the publish actually succeeded so the caller knows.
      let published = false;
      let publish_error: string | undefined;
      try {
        const ds = await docStoreProvider.resolve(ctx, flow);
        const docRef = await ds.publish({
          title: `PRD: ${flow.title}`,
          markdown: input.prd_markdown,
          doc_kind: 'prd',
          flow_folder: flow.slug,
          folder_path: folderPath,
        }, ctx);
        // Only persist Drive-derived fields when publish returned a real DocRef.
        if (docRef.id && docRef.id !== 'noop') {
          // Successful real publish — capture all Drive fields
          if (docRef.url) prd_ref.url = docRef.url;
          if (docRef.id) prd_ref.external_id = docRef.id;
          if (docRef.gdoc_id) prd_ref.gdoc_id = docRef.gdoc_id;
          published = true;
        }
        // NoOp returns id='noop' — leave prd_ref sha256-only and published=false
      } catch (err) {
        // Non-fatal: log and continue. The sha256 is always stored.
        publish_error = (err as Error).message;
        console.warn('[submit_prd] doc store publish failed:', publish_error);
      }

      // Llegar hasta acá implica validation.ok === true (la guarda de arriba
      // corta el camino inválido). El avance de estado pasa por el chokepoint:
      // entre la guarda de arriba y esta línea se publicó el documento, y el flow
      // pudo haberse abortado en esa ventana.
      // Con aprobación exigida el PRD queda en revisión, salvo que sea el mismo
      // contenido ya aprobado (ver STATUS_DESPUES_DE_PRD_APROBADO).
      const contenidoCambio = flow.prd_ref?.sha256 !== undefined && flow.prd_ref.sha256 !== sha256;
      const mismoYAprobado =
        approvalRequired &&
        !contenidoCambio &&
        STATUS_DESPUES_DE_PRD_APROBADO.has(flow.status) &&
        (await hasCurrentApproval(store, { ...flow, prd_ref }, 'prd'));
      const transition = !approvalRequired
        ? { status: 'prd_ready' as const, current_phase: 'rfc' as const }
        : mismoYAprobado
          ? { status: flow.status, current_phase: flow.current_phase }
          : { status: 'prd_in_review' as const, current_phase: 'prd' as const };

      const written = await updateFlowUnlessAborted(
        store,
        flow,
        {
          prd_ref,
          ...transition,
          // Sólo un publish exitoso fija la ruta: atarla sin documento detrás dejaría
          // el flow apuntando a una carpeta vacía y sin volver a derivar nunca.
          ...(published && flow.doc_folder_path === undefined
            ? { doc_folder_path: folderPath }
            : {}),
        },
        'submit_prd',
      );
      if (!written.ok) return { ok: false, error: written.error };
      const updated = written.flow;
      await store.appendEvent({
        flow_id: flow.flow_id,
        type: 'prd.submitted',
        actor: ctx.userId,
        payload: { sha256, doc_url: input.doc_url ?? null, validation_ok: true },
      });

      // Otro contenido: la aprobación del PRD anterior y la del RFC escrito sobre él
      // dejan de valer. Se hace siempre (también con la exigencia apagada) para que
      // prender la exigencia después no reviva una aprobación de un texto viejo.
      if (contenidoCambio) {
        await invalidateApprovalsWithEvents(store, flow.flow_id, ctx.userId, [
          { artifacts: ['prd'], reason: 'content_changed' },
          { artifacts: ['rfc', 'acceptance_criteria'], reason: 'upstream_resubmitted' },
        ]);
      }

      if (published && prd_ref.url) {
        await store.appendEvent({
          flow_id: flow.flow_id,
          type: 'prd.published',
          actor: ctx.userId,
          payload: {
            drive_url: prd_ref.url,
            drive_id: prd_ref.external_id ?? null,
            gdoc_id: prd_ref.gdoc_id ?? null,
          },
        });
      }

      return {
        ok: true,
        data: {
          flow: updated,
          validation,
          published,
          ...(publish_error !== undefined ? { publish_error } : {}),
        },
        next_actions:
          updated.status === 'prd_in_review'
            ? [
                'Pedile a una persona con rol product-manager en el workspace que apruebe el PRD (sigue en Draft hasta entonces)',
                'get_flow_state',
              ]
            : ['validate_prd', 'get_role_prompt({role:"tech-lead", phase:"rfc-draft"})'],
      };
    },
  };
}
