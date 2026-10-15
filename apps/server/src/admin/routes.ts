import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { RoleId } from '@sdlc/core';
import type { FlowStore } from '../state/index.js';
import type { AdminStore } from './store.js';
import type { IntegrationConfigAdmin, IntegrationConfigStore, IntegrationRef } from '../integrations/types.js';
import { IntegrationRefSchema } from '../integrations/seed.js';
import type { DirectoryStore } from '../oauth/directory-store.js';
import { SESSION_COOKIE, clearSessionCookie, parseCookies, readSession } from './auth.js';
import type { Labels } from '../config/labels.js';

export interface AdminRoutesDeps {
  adminStore: AdminStore;
  flowStore: FlowStore;
  integrations: IntegrationConfigStore & IntegrationConfigAdmin;
  directory: DirectoryStore;
  /** Tenant fijo del deploy; las integraciones/flows de un workspace viven en (tenantId, workspace_id). */
  tenantId: string;
  sessionSecret: string;
  labels: Labels;
}

const CreateWorkspaceBody = z.object({
  workspace_id: z.string().min(1).regex(/^[a-z0-9_-]+$/),
  name: z.string().min(1),
  group_id: z.string().min(1).optional(),
});
const MemberBody = z.object({ roles: z.array(RoleId).min(1) });
const IntegrationBody = z
  .object({
    task_system: IntegrationRefSchema.optional(),
    doc_store: IntegrationRefSchema.optional(),
    pr_provider: IntegrationRefSchema.optional(),
  })
  .refine((c) => c.task_system ?? c.doc_store ?? c.pr_provider, {
    message: 'at least one of task_system, doc_store, pr_provider is required',
  });

/**
 * API del panel admin. El login vive en el Authorization Server
 * (/oauth/authorize?mode=admin → cookie de sesión); acá solo se verifica la sesión.
 *
 * Modelo: workspaces de primera clase sobre un tenant fijo. Un workspace tiene miembros (N:M),
 * una config de integración (fila (tenantId, workspace_id)) y sus flows (project = workspace_id).
 */
export function registerAdminRoutes(app: FastifyInstance, deps: AdminRoutesDeps): void {
  const { tenantId } = deps;

  const session = (req: FastifyRequest): Record<string, unknown> | null => {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    return token ? readSession(deps.sessionSecret, token) : null;
  };

  const guard = (req: FastifyRequest, reply: FastifyReply): boolean => {
    if (!session(req)) {
      void reply.code(401).send({ error: 'not authenticated' });
      return false;
    }
    return true;
  };

  // Public metadata endpoint — no session guard needed (used by SPA before login).
  app.get('/admin/api/meta', async () => ({ labels: deps.labels }));

  app.get('/admin/api/me', async (req, reply) => {
    const s = session(req);
    if (!s) return reply.code(401).send({ error: 'not authenticated' });
    return { email: s.email ?? null };
  });

  app.post('/admin/api/logout', async (_req, reply) =>
    reply.header('set-cookie', clearSessionCookie()).send({ ok: true }),
  );

  app.get('/admin/api/groups', async (req, reply) => {
    if (!guard(req, reply)) return;
    const groupList = await deps.adminStore.listGroups();
    return { groups: groupList };
  });

  app.get('/admin/api/workspaces', async (req, reply) => {
    if (!guard(req, reply)) return;
    const wsList = await deps.adminStore.listWorkspaces();
    const rows = await deps.integrations.listIntegrations(tenantId);
    const withIntegration = new Set(rows.map((r) => r.project));
    const enriched = await Promise.all(
      wsList.map(async (ws) => ({
        workspace_id: ws.workspace_id,
        name: ws.name,
        created_at: ws.created_at,
        members: (await deps.directory.listMembers(ws.workspace_id)).length,
        integrations: withIntegration.has(ws.workspace_id) ? 1 : 0,
      })),
    );
    return { workspaces: enriched };
  });

  app.post('/admin/api/workspaces', async (req, reply) => {
    if (!guard(req, reply)) return;
    const parsed = CreateWorkspaceBody.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid body', issues: parsed.error.issues });
    if (await deps.adminStore.getWorkspace(parsed.data.workspace_id)) {
      return reply.code(409).send({ error: `workspace "${parsed.data.workspace_id}" already exists` });
    }
    const workspace = await deps.adminStore.createWorkspace({
      workspace_id: parsed.data.workspace_id,
      name: parsed.data.name,
      ...(parsed.data.group_id ? { group_id: parsed.data.group_id } : {}),
    });
    return reply.code(201).send({ workspace });
  });

  app.get('/admin/api/workspaces/:id/members', async (req, reply) => {
    if (!guard(req, reply)) return;
    const { id } = req.params as { id: string };
    return { members: await deps.directory.listMembers(id) };
  });

  // PUT agrega/actualiza la membresía puntual (workspace, email); no "muda" a la persona.
  app.put('/admin/api/workspaces/:id/members/:email', async (req, reply) => {
    if (!guard(req, reply)) return;
    const { id, email } = req.params as { id: string; email: string };
    if (!(await deps.adminStore.getWorkspace(id))) {
      return reply.code(404).send({ error: `unknown workspace: ${id}` });
    }
    const parsed = MemberBody.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid body', issues: parsed.error.issues });
    const member = await deps.directory.upsertMember({
      email: decodeURIComponent(email),
      workspace_id: id,
      roles: parsed.data.roles,
    });
    return { member };
  });

  app.delete('/admin/api/workspaces/:id/members/:email', async (req, reply) => {
    if (!guard(req, reply)) return;
    const { id, email } = req.params as { id: string; email: string };
    const removed = await deps.directory.removeMember(decodeURIComponent(email), id);
    if (!removed) {
      return reply.code(404).send({ error: 'member not found in this workspace' });
    }
    return { ok: true };
  });

  // Una config de integración por workspace: la fila (tenantId, workspace_id).
  app.get('/admin/api/workspaces/:id/integration', async (req, reply) => {
    if (!guard(req, reply)) return;
    const { id } = req.params as { id: string };
    const rows = await deps.integrations.listIntegrations(tenantId);
    const row = rows.find((r) => r.project === id);
    return { integration: row ?? null };
  });

  app.put('/admin/api/workspaces/:id/integration', async (req, reply) => {
    if (!guard(req, reply)) return;
    const { id } = req.params as { id: string };
    const parsed = IntegrationBody.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid body', issues: parsed.error.issues });
    // Mismo cast que seedIntegrations: el schema zod valida la forma exacta de IntegrationRef.
    const config = {
      ...(parsed.data.task_system ? { task_system: parsed.data.task_system as IntegrationRef } : {}),
      ...(parsed.data.doc_store ? { doc_store: parsed.data.doc_store as IntegrationRef } : {}),
      ...(parsed.data.pr_provider ? { pr_provider: parsed.data.pr_provider as IntegrationRef } : {}),
    };
    await deps.integrations.upsertIntegration({ tenant_id: tenantId, project: id, config });
    return { ok: true };
  });

  app.delete('/admin/api/workspaces/:id/integration', async (req, reply) => {
    if (!guard(req, reply)) return;
    const { id } = req.params as { id: string };
    const deleted = await deps.integrations.deleteIntegration(tenantId, id);
    if (!deleted) return reply.code(404).send({ error: 'integration not found' });
    return { ok: true };
  });

  app.get('/admin/api/workspaces/:id/flows', async (req, reply) => {
    if (!guard(req, reply)) return;
    const { id } = req.params as { id: string };
    const flows = await deps.flowStore.listFlows(tenantId, id);
    return {
      flows: flows.map((f) => ({
        flow_id: f.flow_id,
        project: f.project,
        title: f.title,
        initiative_type: f.initiative_type ?? null,
        status: f.status,
        current_phase: f.current_phase,
        updated_at: f.updated_at,
      })),
    };
  });

  app.get('/admin/api/flows/:flowId', async (req, reply) => {
    if (!guard(req, reply)) return;
    const { flowId } = req.params as { flowId: string };
    const flow = await deps.flowStore.getFlow(flowId);
    if (!flow) return reply.code(404).send({ error: `unknown flow: ${flowId}` });
    const [stories, events] = await Promise.all([
      deps.flowStore.listStoriesByFlow(flowId),
      deps.flowStore.listEvents(flowId),
    ]);
    return { flow, stories, events };
  });
}
