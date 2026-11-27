import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { TenantCtx } from '@sdlc/adapters-contracts';
import type { FlowStore } from '../../state/index.js';
import { resolveFlowForCtx } from './flow-access.js';
import { assertRole } from './role-guard.js';
import { validateRfc } from '../../validation/rfc.js';
import { parseRfcFrontmatter } from '../../validation/rfc-frontmatter.js';
import type { FlowStatusTransition } from '../../state/store.js';
import type { DocStoreProvider } from '../../adapters/doc-store-provider.js';
import { updateFlowUnlessAborted } from './abort-flow.js';
import type { AdminStore } from '../../admin/store.js';
import { resolveDocFolderPath } from '../../docs/folder-path.js';
import {
  APPROVALS_OFF,
  hasCurrentApproval,
  invalidateApprovalsWithEvents,
  missingApproval,
  type ApprovalPolicy,
} from '../../approvals/policy.js';
import { issueApprovalLink } from '../../approvals/links.js';

export const SubmitRfcInput = z.object({
  flow_id: z.string().min(1),
  rfc_markdown: z.string().min(50),
  repo_path: z.string().min(1),
});
export type SubmitRfcInput = z.infer<typeof SubmitRfcInput>;

export function makeSubmitRfcTool(
  store: FlowStore,
  docStoreProvider: DocStoreProvider,
  adminStore?: AdminStore,
  approvals: ApprovalPolicy = APPROVALS_OFF,
) {
  return {
    name: 'submit_rfc',
    description:
      'Submits the RFC markdown for a flow. Requires the PRD to be approved: flow status must be prd_ready (or rfc_ready, for a revision of the RFC before the backlog is derived). Runs structural validation FIRST: an RFC that fails validation is rejected without any side effect — nothing is published, no rfc_ref/architecture_mode/codebase_status/existing_repo/components are stored and a previously accepted RFC is left untouched. On success parses the YAML frontmatter, persists architecture_mode/codebase_status/existing_repo/components, stores a reference (repo_path + sha256) — not the body — and advances to status=rfc_ready and current_phase=shaping. If the workspace requires phase approval (APPROVALS_REQUIRED), it also requires a current approval of the PRD, rejects once the epic exists, and leaves the RFC as a Draft with status=rfc_in_review until a tech-lead approves it; different content invalidates the RFC and acceptance-criteria approvals.',
    inputSchema: SubmitRfcInput,
    handler: async (input: SubmitRfcInput, ctx: TenantCtx) => {
      const resolved = await resolveFlowForCtx(store, ctx, input.flow_id);
      if (!resolved.ok) return { ok: false, error: resolved.error };
      const flow = resolved.flow;

      // Guarda de rol antes de cualquier side-effect, y la que convierte el gate de
      // repo en una atadura real en vez de una verificación de coherencia.
      //
      // `submit_review_outcome` exige que el PR pertenezca al repo declarado de la
      // story, y ese repo sale del frontmatter del RFC (`components` /
      // `existing_repo`). Sin guarda de rol acá, el repo declarado seguía siendo
      // atacante-controlado: quien pudiera escribir el RFC declaraba
      // `mallory/scratch` como repo del componente, abría el PR ahí y el gate pasaba
      // —porque era consistente consigo mismo—. Lo único que verificaba era que el
      // atacante no se contradijera.
      //
      // Con esto el repo lo declara un `tech-lead` y el gate pasa a comparar el PR
      // contra algo que otra persona escribió. `tech-lead` solo, sin break-glass: el
      // catálogo le asigna `rfc-draft` y `rfc-validate` y no hay ningún otro rol con
      // fases `rfc-*`. Agregar un segundo rol acá reabriría exactamente el agujero,
      // porque alcanzaría con tener ese otro rol para volver a elegir el repo.
      const roleDenied = assertRole(ctx, ['tech-lead'], 'submit_rfc', flow.project);
      if (roleDenied) {
        return {
          ok: false,
          error:
            `${roleDenied} El RFC declara el repo de cada componente y ese repo es contra lo que después ` +
            'se verifica el PR en el code review, así que lo firma el tech-lead. Verificá tus roles con ' +
            'whoami y pedile a alguien con rol tech-lead en ese workspace que ejecute submit_rfc.',
        };
      }

      // Guarda de estado (mismo patrón que create_epic / propose_breakdown):
      // se aplica antes de cualquier side-effect.
      //
      // Antes acá sólo se miraba `!flow.prd_ref`, es decir que el PRD
      // *existiera*. Con eso, un PRD que no validaba igual habilitaba el RFC y
      // la cadena entera arrancaba sin que nadie hubiera aprobado el documento
      // de origen. Lo que exigimos ahora es que el PRD esté **aprobado**: el
      // flow tiene que haber llegado a `prd_ready`.
      //
      // Estados admitidos y por qué:
      //  - `prd_ready`: el caso normal, el PRD validó y el flow espera el RFC.
      //  - `rfc_ready`: re-submit de una revisión del RFC durante shaping. Lo
      //    permitimos a propósito — corregir o pivotear el RFC antes de derivar
      //    el backlog es parte del flujo, y submit_rfc ya protege el registro de
      //    componentes de una resubmisión inválida.
      // Todo el resto se rechaza:
      //  - `draft`: no hay PRD aprobado (es el agujero que cerramos).
      //  - `backlog_ready` en adelante: el epic y las stories ya se derivaron de
      //    este RFC; reescribirlo por atrás los dejaría desincronizados sin que
      //    nadie se entere. El cambio de arquitectura se registra con submit_adr.
      //  - `aborted`: el flow terminó.
      //  - `rfc_in_review`: re-submit de un RFC que todavía espera aprobación.
      if (flow.status !== 'prd_ready' && flow.status !== 'rfc_ready' && flow.status !== 'rfc_in_review') {
        if (flow.status === 'prd_in_review') {
          return {
            ok: false,
            error:
              'No se puede enviar el RFC: el PRD está en revisión (status "prd_in_review") y todavía no lo aprobó ' +
              `una persona con rol product-manager en el workspace "${flow.project}". El RFC se envía después de esa aprobación.`,
            next_actions: ['get_flow_state'],
          };
        }
        if (flow.status === 'draft') {
          return {
            ok: false,
            error:
              `No se puede enviar el RFC: el flow está en status "${flow.status}", se esperaba "prd_ready". ` +
              'El PRD todavía no fue aprobado (o no pasó la validación estructural). ' +
              'Enviá un PRD que valide con submit_prd — podés chequearlo antes con validate_prd — y recién ahí reenviá el RFC con submit_rfc.',
          };
        }
        if (flow.status === 'aborted') {
          return {
            ok: false,
            error:
              'No se puede enviar el RFC: el flow está en status "aborted". ' +
              'Arrancá un flow nuevo con start_flow y enviá su PRD con submit_prd.',
          };
        }
        return {
          ok: false,
          error:
            `No se puede enviar el RFC: el flow está en status "${flow.status}", se esperaba "prd_ready" o "rfc_ready". ` +
            'El backlog ya se derivó de este RFC, así que reescribirlo dejaría el epic y las stories desincronizados. ' +
            'Registrá el cambio de arquitectura con submit_adr, o arrancá un flow nuevo con start_flow.',
        };
      }

      // Con aprobación exigida, el RFC se escribe sobre un PRD aprobado: no alcanza
      // con que el flow esté en `prd_ready` (los flows de antes de la exigencia
      // llegaron ahí sin aprobación), tiene que haber una aprobación vigente del PRD
      // actual. Y un RFC nuevo con el backlog ya creado dejaría la épica colgada de
      // algo que nadie aprobó.
      const approvalRequired = approvals.required(flow.project);
      if (approvalRequired) {
        const sinPrd = await missingApproval(store, flow, 'prd');
        if (sinPrd) {
          return { ok: false, error: `No se puede enviar el RFC. ${sinPrd}`, next_actions: ['get_flow_state'] };
        }
        if (flow.epic_external_id) {
          return {
            ok: false,
            error:
              `No se puede reenviar el RFC: el flow ya tiene épica (${flow.epic_external_id}), creada desde el RFC aprobado. ` +
              'Registrá el cambio de arquitectura con submit_adr o arrancá un flow nuevo con start_flow.',
          };
        }
      }

      // Gate de admisión: validamos ANTES de escribir nada.
      //
      // Es el mismo gate que submit_prd, por el mismo motivo: un agente que no
      // puede producir un documento válido tampoco debería poder borrar el que
      // ya estaba. Acá el arreglo estaba a medias — sólo `components` y la
      // transición de status miraban `validation.ok`, así que un RFC inválido
      // igual pisaba `rfc_ref`, `architecture_mode`, `codebase_status` y
      // `existing_repo`, publicaba el documento en el doc store y emitía
      // `rfc.submitted`. La tool devolvía `ok:false` con todo ya escrito.
      //
      // `existing_repo` es el caso más caro: alimenta el contexto de
      // implementación río abajo (get_implementation_context), así que
      // sobrescribirlo desde un RFC que no valida redirige el trabajo posterior
      // a un repo que nadie aprobó.
      //
      // Si la admisión falla: cero escrituras. No se publica en el doc store
      // (la publicación vive más abajo, así que alcanza con cortar acá), no se
      // toca el flow y no se emite ningún evento. El RFC anterior queda intacto.
      const validation = validateRfc(input.rfc_markdown);
      if (!validation.ok) {
        const errores = validation.issues.filter((i) => i.severity === 'error');
        const detalle = errores.map((i) => i.message).join('; ');
        return {
          ok: false,
          error:
            `El RFC no pasó la validación estructural (${errores.length} error(es)): ${detalle}. ` +
            'No se guardó ninguna referencia: el flow quedó como estaba. ' +
            'Corregí el markdown y reenvialo con submit_rfc (podés chequearlo antes con validate_rfc pasando rfc_markdown para un dry-run).',
          // Devolvemos el detalle además del mensaje para que el agente no
          // tenga que parsear el string para saber qué secciones arreglar.
          data: { flow, validation, published: false },
          next_actions: ['validate_rfc', 'submit_rfc'],
        };
      }

      const { frontmatter } = parseRfcFrontmatter(input.rfc_markdown);
      const sha256 = createHash('sha256').update(input.rfc_markdown).digest('hex');

      // Llegar hasta acá implica validation.ok === true (la guarda de arriba
      // corta el camino inválido), así que el patch se escribe entero: el
      // registro de componentes y el avance de estado son incondicionales.
      // Un RFC válido sin components (ni existing_repo para sintetizar uno)
      // limpia a propósito el registro stale de una revisión anterior.
      const patch: FlowStatusTransition = {
        rfc_ref: { repo_path: input.repo_path, sha256 },
        ...(frontmatter.architecture_mode ? { architecture_mode: frontmatter.architecture_mode } : {}),
        ...(frontmatter.codebase_status ? { codebase_status: frontmatter.codebase_status } : {}),
        ...(frontmatter.existing_repo ? { existing_repo: frontmatter.existing_repo } : {}),
        components: frontmatter.components ?? [],
        status: 'rfc_ready' as const,
        current_phase: 'shaping' as const,
      };
      // Con aprobación exigida el RFC queda en revisión hasta que lo apruebe el
      // tech-lead, salvo que se reenvíe el mismo contenido ya aprobado.
      const contenidoCambio = flow.rfc_ref?.sha256 !== undefined && flow.rfc_ref.sha256 !== sha256;
      if (
        approvalRequired &&
        (contenidoCambio || !(await hasCurrentApproval(store, { ...flow, rfc_ref: { sha256 } }, 'rfc')))
      ) {
        patch.status = 'rfc_in_review';
        patch.current_phase = 'rfc';
      }

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
          title: `RFC: ${flow.title}`,
          markdown: input.rfc_markdown,
          doc_kind: 'rfc',
          flow_folder: flow.slug,
          folder_path: folderPath,
        }, ctx);
        // Only persist Drive-derived fields when publish returned a real DocRef.
        if (docRef.id && docRef.id !== 'noop') {
          // Successful real publish — capture all Drive fields
          if (docRef.url) patch.rfc_ref = { ...patch.rfc_ref, url: docRef.url };
          if (docRef.id) patch.rfc_ref = { ...patch.rfc_ref, external_id: docRef.id };
          if (docRef.gdoc_id) patch.rfc_ref = { ...patch.rfc_ref, gdoc_id: docRef.gdoc_id };
          published = true;
        }
        // NoOp returns id='noop' — leave rfc_ref sha256-only and published=false
      } catch (err) {
        publish_error = (err as Error).message;
        console.warn('[submit_rfc] doc store publish failed:', publish_error);
      }

      // El gate de status de arriba ya rechazó el flow `aborted`; el chokepoint es
      // el backstop, porque entre ese gate y esta línea se publicó el documento en
      // el doc store y el flow pudo haberse abortado en esa ventana.
      // Sólo un publish exitoso fija la ruta (ver el comentario en submit-prd.ts).
      if (published && flow.doc_folder_path === undefined) {
        patch.doc_folder_path = folderPath;
      }

      const written = await updateFlowUnlessAborted(store, flow, patch, 'submit_rfc');
      if (!written.ok) return { ok: false, error: written.error };
      const updated = written.flow;
      await store.appendEvent({
        flow_id: flow.flow_id,
        type: 'rfc.submitted',
        actor: ctx.userId,
        payload: {
          sha256,
          repo_path: input.repo_path,
          validation_ok: true,
          architecture_mode: frontmatter.architecture_mode ?? null,
          codebase_status: frontmatter.codebase_status ?? null,
        },
      });

      // Otro contenido: la aprobación del RFC anterior y la de los criterios
      // derivados de él dejan de valer (ver el mismo paso en submit-prd.ts).
      if (contenidoCambio) {
        await invalidateApprovalsWithEvents(store, flow.flow_id, ctx.userId, [
          { artifacts: ['rfc'], reason: 'content_changed' },
          { artifacts: ['acceptance_criteria'], reason: 'upstream_resubmitted' },
        ]);
      }

      if (published && patch.rfc_ref?.url) {
        await store.appendEvent({
          flow_id: flow.flow_id,
          type: 'rfc.published',
          actor: ctx.userId,
          payload: {
            drive_url: patch.rfc_ref.url,
            drive_id: patch.rfc_ref.external_id ?? null,
            gdoc_id: patch.rfc_ref.gdoc_id ?? null,
          },
        });
      }

      // En revisión: el link para que la persona con el rol dueño apruebe esta versión.
      const approval =
        updated.status === 'rfc_in_review'
          ? await issueApprovalLink({
              store,
              flow: updated,
              artifact: 'rfc',
              requestedBy: ctx.userId,
              publicUrl: approvals.publicUrl,
            })
          : undefined;

      return {
        ok: true,
        data: {
          flow: updated,
          validation,
          published,
          ...(publish_error !== undefined ? { publish_error } : {}),
          ...(approval ? { approval } : {}),
        },
        next_actions:
          approval
            ? [
                `Pedile a una persona con rol tech-lead en el workspace que apruebe el RFC en ${approval.url} (vence ${approval.expires_at}). Vos no abras el link: la aprobación es de esa persona.`,
                'get_flow_state',
              ]
            : ['validate_rfc', 'propose_breakdown'],
      };
    },
  };
}
