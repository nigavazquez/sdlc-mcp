import { z } from 'zod';
import { createHash } from 'node:crypto';
import { StoryInput, trackForInitiative } from '@sdlc/core';
import type { TenantCtx } from '@sdlc/adapters-contracts';
import type { FlowStore } from '../../state/index.js';
import type { DocStoreProvider } from '../../adapters/doc-store-provider.js';
import type { TaskSystemProvider } from '../../adapters/task-system-provider.js';
import type { AdminStore } from '../../admin/store.js';
import { resolveDocFolderPath } from '../../docs/folder-path.js';
import { validateChangeNote } from '../../validation/change-note.js';
import { resolveFlowForCtx } from './flow-access.js';
import { assertRole } from './role-guard.js';
import { assertFlowNotAborted, updateFlowUnlessAborted } from './abort-flow.js';
import { crearEpic, crearStories } from './backlog-core.js';
import { acceptanceCriteriaSinContenido } from '../../validation/acceptance-criteria.js';

export const SubmitChangeNoteInput = z.object({
  flow_id: z.string().min(1),
  change_note_markdown: z.string().min(50),
  stories: z.array(StoryInput).min(1),
  doc_url: z.string().url().optional(),
  repo_path: z.string().optional(),
});
export type SubmitChangeNoteInput = z.infer<typeof SubmitChangeNoteInput>;

/**
 * La única tool del track liviano.
 *
 * Hace en una llamada lo que en el track completo son seis —`submit_prd`,
 * `submit_rfc`, `propose_breakdown`, `create_epic`, `create_stories`,
 * `sync_backlog`— porque para un fix de una línea esas seis son el problema, no la
 * solución: el validador de PRD pide métricas de éxito con baseline y target que un
 * bug no tiene, y el sistema termina empujando a inventarlas o a saltearse el flow.
 *
 * Lo que **no** hace es tocar la entrega. Después de esta llamada el camino es el
 * mismo de siempre: `claim_story`, `report_progress`, plan de QA, el sobre con
 * `test_exit_code` y cobertura, y un review que no puede firmar quien implementó.
 */
export function makeSubmitChangeNoteTool(
  store: FlowStore,
  taskSystemProvider: TaskSystemProvider,
  docStoreProvider: DocStoreProvider,
  adminStore?: AdminStore,
) {
  return {
    name: 'submit_change_note',
    description:
      'Submits the change note for a lite-track flow (initiative_type fix or improvement) and leaves it ready to implement. ' +
      'Replaces submit_prd + submit_rfc + create_epic + create_stories + sync_backlog in a single call. ' +
      'The note needs four sections (what happens, how you know, what you change, how it is verified) and must declare its repo ' +
      'in the YAML frontmatter ("repo:", or "components:" when the change touches more than one) — without a declared repo the code ' +
      'review gate has nothing to compare the PR against. The frontmatter must also declare exactly one of "repro: \'<command that ' +
      'fails today>\'" or "no_repro: <why it could not be reproduced>" — declaring neither is rejected. Runs structural validation FIRST: a note that fails is rejected without ' +
      'any side effect. On success stores a reference (sha256, not the body), creates the epic and the stories, and advances the flow ' +
      'to status=backlog_ready / current_phase=implementation. Rejected on full-track flows (feature, refactor): those go through submit_prd. ' +
      'The QA and review gates are unchanged.',
    inputSchema: SubmitChangeNoteInput,
    handler: async (input: SubmitChangeNoteInput, ctx: TenantCtx) => {
      const resolved = await resolveFlowForCtx(store, ctx, input.flow_id);
      if (!resolved.ok) return { ok: false, error: resolved.error };
      const flow = resolved.flow;

      // Guarda de rol antes de cualquier side-effect: más abajo se publica en el doc
      // store y se crean epic y stories en el sistema externo, sin rollback.
      //
      // `developer` está en la lista y es el punto del track: quien encuentra el bug
      // tiene que poder describirlo sin ir a buscar un pmo. No afloja la separación
      // de funciones — `assertNotSelfSignoff` sigue impidiendo que quien escribió la
      // nota e implementó firme su propio QA o su propio review.
      const roleDenied = assertRole(
        ctx,
        ['developer', 'tech-lead', 'pmo'],
        'submit_change_note',
        flow.project,
      );
      if (roleDenied) {
        return {
          ok: false,
          error:
            `${roleDenied} Verificá tus roles con whoami y pedile a alguien con rol developer, tech-lead o ` +
            'pmo en ese workspace que ejecute submit_change_note.',
        };
      }

      const abortedDenied = assertFlowNotAborted(flow, 'submit_change_note');
      if (abortedDenied) return { ok: false, error: abortedDenied };

      // El track sale del `initiative_type` y no de un campo aparte, así que no hay
      // forma de declarar una cosa y correr por la otra.
      if (trackForInitiative(flow.initiative_type) !== 'lite') {
        return {
          ok: false,
          error:
            `submit_change_note es del track liviano y este flow es "${flow.initiative_type ?? 'sin initiative_type'}", ` +
            'que va por el completo: PRD → RFC → shaping. Enviá el PRD con submit_prd. ' +
            'Si el cambio es realmente chico, abrí un flow nuevo con start_flow e initiative_type "fix" o "improvement" — ' +
            'una feature no se degrada a nota de cambio.',
        };
      }

      if (flow.status !== 'draft') {
        return {
          ok: false,
          error:
            `No se puede enviar la nota de cambio: el flow está en status "${flow.status}", se esperaba "draft". ` +
            'La nota es lo primero que recibe un flow liviano; después de eso el backlog ya está derivado y ' +
            'reescribirla dejaría las stories desincronizadas. Registrá el cambio de alcance con submit_adr, ' +
            'o arrancá un flow nuevo con start_flow.',
        };
      }

      // Gate de admisión: validamos ANTES de escribir nada. Si falla, no se publica
      // en el doc store, no se crea el epic, no se crean stories y el flow queda
      // exactamente como estaba.
      const validation = validateChangeNote(input.change_note_markdown);
      if (!validation.ok || !validation.components) {
        const errores = validation.issues.filter((i) => i.severity === 'error');
        const detalle = errores.map((i) => i.message).join('; ');
        return {
          ok: false,
          error:
            `La nota de cambio no pasó la validación (${errores.length} error(es)): ${detalle}. ` +
            'No se creó nada: el flow quedó como estaba. Corregí el markdown y reenvialo con submit_change_note.',
          data: { flow, validation, published: false },
          next_actions: ['submit_change_note'],
        };
      }
      const components = validation.components;

      const sha256 = createHash('sha256').update(input.change_note_markdown).digest('hex');
      const change_note_ref: {
        url?: string;
        repo_path?: string;
        sha256: string;
        external_id?: string;
        gdoc_id?: string;
      } = { sha256 };
      if (input.doc_url) change_note_ref.url = input.doc_url;
      if (input.repo_path) change_note_ref.repo_path = input.repo_path;

      // La ruta histórica manda; recién si no la tiene se deriva del modelo.
      const folderPath =
        flow.doc_folder_path ??
        (adminStore
          ? await resolveDocFolderPath({ adminStore, workspaceId: flow.project })
          : [flow.project]);

      // Publish no-fatal, igual que en submit_prd: el sha256 es el ancla durable.
      let published = false;
      let publish_error: string | undefined;
      try {
        const ds = await docStoreProvider.resolve(ctx, flow);
        const docRef = await ds.publish(
          {
            title: `Nota de cambio: ${flow.title}`,
            markdown: input.change_note_markdown,
            doc_kind: 'change-note',
            flow_folder: flow.slug,
            folder_path: folderPath,
          },
          ctx,
        );
        if (docRef.id && docRef.id !== 'noop') {
          if (docRef.url) change_note_ref.url = docRef.url;
          if (docRef.id) change_note_ref.external_id = docRef.id;
          if (docRef.gdoc_id) change_note_ref.gdoc_id = docRef.gdoc_id;
          published = true;
        }
      } catch (err) {
        publish_error = (err as Error).message;
        console.warn('[submit_change_note] doc store publish failed:', publish_error);
      }

      const taskSystem = await taskSystemProvider.resolve(ctx, flow);

      // Idempotencia del epic: si una llamada anterior lo creó y murió antes de
      // avanzar el flow, el reintento lo reusa. Crear un segundo dejaría el backlog
      // externo con dos epics para la misma iniciativa y sin forma de saber cuál vale.
      let epicId = flow.epic_external_id;
      if (!epicId) {
        const { ref } = await crearEpic(
          store,
          taskSystem,
          flow,
          {
            title: flow.title,
            description:
              `Iniciativa ${flow.initiative_type} del track liviano. ` +
              `Nota de cambio: ${change_note_ref.url ?? change_note_ref.sha256}`,
          },
          ctx,
        );
        epicId = ref.external_id;
      }

      for (const story of input.stories) {
        const sinContenido = acceptanceCriteriaSinContenido(story.acceptance_criteria, story.title);
        if (sinContenido) return { ok: false, error: sinContenido };
      }

      const byName = new Map(components.map((c) => [c.name, c]));
      const soleComponent = components.length === 1 ? components[0] : undefined;
      for (const story of input.stories) {
        if (story.component && !byName.has(story.component)) {
          return {
            ok: false,
            error:
              `La story "${story.title}" apunta al componente "${story.component}", que la nota no declara. ` +
              `Declarados: ${components.map((c) => c.name).join(', ')}.`,
          };
        }
        if (!story.component && components.length > 1) {
          return {
            ok: false,
            error:
              `La story "${story.title}" tiene que declarar "component": la nota declara ${components.length} ` +
              `(${components.map((c) => c.name).join(', ')}), y una story es un repo y un PR.`,
          };
        }
      }

      const storyRefs = await crearStories(
        store,
        taskSystem,
        flow,
        epicId,
        input.stories.map((story) => ({
          story,
          component: story.component ? byName.get(story.component) : soleComponent,
        })),
        ctx,
      );

      // El avance pasa por el chokepoint: entre la guarda de arriba y esta línea se
      // publicó el documento y se escribió en el sistema externo, y el flow pudo
      // haberse abortado en esa ventana.
      const written = await updateFlowUnlessAborted(
        store,
        flow,
        {
          change_note_ref,
          components,
          // Un fix es por definición trabajo sobre un codebase que ya existe y que se
          // reusa. Persistirlo no es cosmética: `get_role_prompt` mergea las skills de
          // escenario a partir de estos dos campos, así que sin ellos la fase de
          // implementación entregaría el bundle de greenfield.
          architecture_mode: 'reuse' as const,
          codebase_status: 'existing' as const,
          status: 'backlog_ready' as const,
          current_phase: 'implementation' as const,
          ...(published && flow.doc_folder_path === undefined ? { doc_folder_path: folderPath } : {}),
        },
        'submit_change_note',
      );
      if (!written.ok) return { ok: false, error: written.error };

      await store.appendEvent({
        flow_id: flow.flow_id,
        type: 'change_note.submitted',
        actor: ctx.userId,
        payload: {
          sha256,
          doc_url: change_note_ref.url ?? null,
          published,
          epic_id: epicId,
          story_count: storyRefs.length,
          // Lo único de la nota que se guarda además del sha256: sin esto no hay forma de
          // medir si el campo sirve (ver el spec 2026-09-28-repro-antes-del-fix § "Cómo se
          // sabría si sirvió"). La validación ya garantizó que existe.
          repro: validation.repro ?? null,
        },
      });

      return {
        ok: true,
        data: {
          flow: written.flow,
          validation,
          published,
          epic_id: epicId,
          story_refs: storyRefs,
          ...(publish_error !== undefined ? { publish_error } : {}),
        },
        next_actions: ['claim_story'],
      };
    },
  };
}
