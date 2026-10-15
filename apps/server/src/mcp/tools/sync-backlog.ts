import { z } from 'zod';
import type { ExternalRef, TenantCtx } from '@sdlc/adapters-contracts';
import type { FlowStore } from '../../state/index.js';
import { resolveFlowForCtx } from './flow-access.js';
import { assertRole } from './role-guard.js';
import { assertFlowNotAborted, updateFlowUnlessAborted } from './abort-flow.js';

export const SyncBacklogInput = z.object({
  flow_id: z.string().min(1),
});
export type SyncBacklogInput = z.infer<typeof SyncBacklogInput>;

interface RefsPayload {
  refs?: ExternalRef[];
  external_id?: string;
  url?: string;
}

export function makeSyncBacklogTool(store: FlowStore) {
  return {
    name: 'sync_backlog',
    description:
      'Aggregates the epic/stories/subtasks created during shaping (from the flow event log), requires at least one story, and advances the flow to status=backlog_ready / current_phase=implementation.',
    inputSchema: SyncBacklogInput,
    handler: async (input: SyncBacklogInput, ctx: TenantCtx) => {
      const resolved = await resolveFlowForCtx(store, ctx, input.flow_id);
      if (!resolved.ok) return { ok: false, error: resolved.error };
      const flow = resolved.flow;

      // Guarda de rol antes de cualquier side-effect: `sync_backlog` es el paso que
      // cierra el shaping y habilita la implementación (`backlog_ready` /
      // `implementation`). Fase `shaping` → `pmo`, con `tech-lead` como break-glass.
      const roleDenied = assertRole(ctx, ['pmo', 'tech-lead'], 'sync_backlog', flow.project);
      if (roleDenied) {
        return {
          ok: false,
          error:
            `${roleDenied} Verificá tus roles con whoami y pedile a alguien con rol pmo o tech-lead en ` +
            'ese workspace que ejecute sync_backlog.',
        };
      }

      // Éste era el vector de resurrección más directo: `sync_backlog` sólo rechazaba
      // el flow ya sincronizado, así que sobre un flow `aborted` lo movía a
      // `backlog_ready` / `implementation` y lo devolvía a la vida en una llamada.
      const abortedDenied = assertFlowNotAborted(flow, 'sync_backlog');
      if (abortedDenied) return { ok: false, error: abortedDenied };

      if (flow.status === 'backlog_ready') {
        return { ok: false, error: 'Backlog already synced for this flow.' };
      }

      const events = await store.listEvents(flow.flow_id);

      let epic: ExternalRef | undefined;
      const stories: ExternalRef[] = [];
      const subtasks: ExternalRef[] = [];
      for (const e of events) {
        const p = e.payload as RefsPayload;
        if (e.type === 'epic.created' && p.external_id && p.url) {
          epic = { external_id: p.external_id, url: p.url };
        }
        if (e.type === 'stories.created' && Array.isArray(p.refs)) {
          stories.push(...p.refs);
        }
        if (e.type === 'subtasks.linked' && Array.isArray(p.refs)) {
          subtasks.push(...p.refs);
        }
      }

      if (stories.length === 0) {
        return {
          ok: false,
          error: 'Cannot sync backlog: no stories have been created yet. Call create_stories first.',
        };
      }

      const written = await updateFlowUnlessAborted(
        store,
        flow,
        { status: 'backlog_ready', current_phase: 'implementation' },
        'sync_backlog',
      );
      if (!written.ok) return { ok: false, error: written.error };
      const updated = written.flow;
      await store.appendEvent({
        flow_id: flow.flow_id,
        type: 'backlog.synced',
        actor: ctx.userId,
        payload: {
          synced: true,
          epic_external_id: epic?.external_id ?? null,
          story_count: stories.length,
          subtask_count: subtasks.length,
        },
      });

      return {
        ok: true,
        data: { flow: updated, backlog: { epic, stories, subtasks } },
        next_actions: ['get_role_prompt({role:"developer", phase:"implement", flow_id})', 'claim_story'],
      };
    },
  };
}
