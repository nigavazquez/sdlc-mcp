import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  OWNER_ROLE,
  type FlowStatus,
  approvalRefsOf,
  type ApprovalArtifact,
  type ApprovalRequest,
  type Flow,
} from '@sdlc/core';
import type { FlowStore } from '../state/index.js';
import type { DirectoryStore } from '../oauth/directory-store.js';
import type { AdminStore } from '../admin/store.js';
import { workspaceSelfSignoff } from '../admin/self-signoff.js';
import { hashApprovalToken } from './links.js';
import { APPROVAL_TOKEN_RE, approverEmail, csrfOk, csrfToken } from './session.js';
import { advanceFlowIfStatus } from '../mcp/tools/abort-flow.js';

/**
 * Página de aprobación `/approve/{token}` (RFC aprobacion-de-fases, historia A4).
 *
 * Es la **única** puerta por la que entra una aprobación. Ninguna tool MCP aprueba:
 * el agente usa el mismo token OAuth que la persona, así que una tool no puede
 * distinguir a una del otro. Acá hace falta una sesión web OIDC de la persona
 * (cookie `sdlc_approver`), un token CSRF del formulario y tipear el slug del flow.
 *
 * Respuestas: 200 aprobado o formulario; 403 sin el rol dueño (o firma propia no
 * permitida); 409 el documento cambió desde que se emitió el link; 410 link vencido
 * o ya usado; 404 link desconocido.
 */
export interface ApprovalRoutesDeps {
  flowStore: FlowStore;
  directory: DirectoryStore;
  /** Para la firma propia del workspace. Sin esto vale el default (permitida). */
  adminStore?: AdminStore;
  sessionSecret: string;
  now?: () => Date;
}

const NOMBRE: Record<ApprovalArtifact, string> = { prd: 'PRD', rfc: 'RFC', acceptance_criteria: 'criterios de aceptación' };

/** Transición que produce la aprobación de cada artefacto, desde su estado en revisión. */
const AVANCE: Partial<Record<ApprovalArtifact, { from: FlowStatus; to: FlowStatus; phase: Flow['current_phase'] }>> = {
  prd: { from: 'prd_in_review', to: 'prd_ready', phase: 'rfc' },
  rfc: { from: 'rfc_in_review', to: 'rfc_ready', phase: 'shaping' },
};

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function page(title: string, body: string): string {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="robots" content="noindex">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title></head>
<body style="font-family:system-ui,sans-serif;max-width:560px;margin:10vh auto;padding:0 16px;color:#1c2733;line-height:1.5">
<h2>${esc(title)}</h2>${body}</body></html>`;
}

function send(reply: FastifyReply, code: number, title: string, body: string) {
  return reply
    .code(code)
    .header('cache-control', 'no-store')
    .header('referrer-policy', 'no-referrer')
    .header('x-frame-options', 'DENY')
    .type('text/html')
    .send(page(title, body));
}

/** Quién envió la versión actual del artefacto: el actor del último `{artifact}.submitted`. */
async function submitterOf(store: FlowStore, flow: Flow, artifact: ApprovalArtifact): Promise<string | undefined> {
  const type = artifact === 'prd' ? 'prd.submitted' : artifact === 'rfc' ? 'rfc.submitted' : undefined;
  if (!type) return undefined;
  const evs = (await store.listEvents(flow.flow_id)).filter((e) => e.type === type);
  return evs[evs.length - 1]?.actor;
}

interface Checked {
  req: ApprovalRequest;
  flow: Flow;
  email: string;
  roles: string[];
  selfSigned: boolean;
  docUrl: string | undefined;
  tokenHash: string;
}

export function registerApprovalRoutes(app: FastifyInstance, deps: ApprovalRoutesDeps): void {
  const now = deps.now ?? (() => new Date());

  if (!app.hasContentTypeParser('application/x-www-form-urlencoded')) {
    app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => {
      done(null, Object.fromEntries(new URLSearchParams(body as string)));
    });
  }

  /**
   * Las validaciones comunes a GET y POST. Devuelve el contexto si se puede
   * aprobar, o ya respondió (y devuelve null).
   */
  async function check(req: FastifyRequest, reply: FastifyReply, token: string): Promise<Checked | null> {
    if (!APPROVAL_TOKEN_RE.test(token)) {
      send(reply, 404, 'Link desconocido', '<p>Este link de aprobación no existe.</p>');
      return null;
    }
    const tokenHash = hashApprovalToken(token);
    const ar = await deps.flowStore.getApprovalRequest(tokenHash);
    if (!ar) {
      send(reply, 404, 'Link desconocido', '<p>Este link de aprobación no existe.</p>');
      return null;
    }
    if (ar.used_at !== undefined || Date.parse(ar.expires_at) <= now().getTime()) {
      send(
        reply,
        410,
        'Link vencido o ya usado',
        '<p>Este link ya se usó o venció. Pedí uno nuevo (la tool <code>request_approval</code> lo genera).</p>',
      );
      return null;
    }

    const email = approverEmail(deps.sessionSecret, req.headers.cookie);
    if (!email) {
      void reply.redirect(`/oauth/authorize?mode=approve&token=${encodeURIComponent(token)}`);
      return null;
    }

    const flow = await deps.flowStore.getFlow(ar.flow_id);
    if (!flow || flow.tenant_id !== ar.tenant_id || flow.status === 'aborted') {
      send(reply, 410, 'El flow ya no está activo', '<p>El flow de este link no existe o fue abandonado.</p>');
      return null;
    }
    const current = approvalRefsOf(flow)[ar.artifact];
    if (current !== ar.sha256) {
      send(
        reply,
        409,
        'Hay una versión nueva',
        `<p>El ${esc(NOMBRE[ar.artifact])} cambió desde que se emitió este link, así que ya no es lo que se pidió aprobar. Pedí un link nuevo.</p>`,
      );
      return null;
    }

    const memberships = await deps.directory.listMemberships(email);
    const roles = memberships.find((m) => m.workspace_id === flow.project)?.roles ?? [];
    const owner = OWNER_ROLE[ar.artifact];
    if (!roles.includes(owner)) {
      send(
        reply,
        403,
        'Sin permiso para aprobar',
        `<p>${esc(email)} no tiene el rol <b>${esc(owner)}</b> en el workspace <b>${esc(flow.project)}</b>, que es el que aprueba el ${esc(NOMBRE[ar.artifact])}.</p>`,
      );
      return null;
    }

    const submitter = await submitterOf(deps.flowStore, flow, ar.artifact);
    const selfSigned = submitter !== undefined && submitter === email;
    if (selfSigned && !(await workspaceSelfSignoff(deps.adminStore, flow.project))) {
      send(
        reply,
        403,
        'No podés aprobar lo que enviaste',
        `<p>Enviaste este ${esc(NOMBRE[ar.artifact])} y el workspace <b>${esc(flow.project)}</b> no permite la firma propia. Tiene que aprobarlo otra persona con rol ${esc(owner)}.</p>`,
      );
      return null;
    }

    const ref = ar.artifact === 'prd' ? flow.prd_ref : ar.artifact === 'rfc' ? flow.rfc_ref : undefined;
    return { req: ar, flow, email, roles, selfSigned, docUrl: ref?.url, tokenHash };
  }

  app.get('/approve/:token', async (req, reply) => {
    const { token } = req.params as { token: string };
    const c = await check(req, reply, token);
    if (!c) return reply;
    const csrf = csrfToken(deps.sessionSecret, c.tokenHash, c.email);
    const doc = c.docUrl ? `<p><a href="${esc(c.docUrl)}" target="_blank" rel="noopener noreferrer">Abrir el documento</a></p>` : '';
    return send(
      reply,
      200,
      `Aprobar ${NOMBRE[c.req.artifact]}: ${c.flow.title}`,
      `${doc}
<p>Flow <b>${esc(c.flow.slug)}</b> en el workspace <b>${esc(c.flow.project)}</b>.<br>
Versión <code>${esc(c.req.sha256.slice(0, 12))}</code>, pedida por ${esc(c.req.requested_by)}.<br>
Aprobás como <b>${esc(c.email)}</b> (rol ${esc(OWNER_ROLE[c.req.artifact])})${c.selfSigned ? ', con <b>firma propia</b>' : ''}.</p>
<form method="post" action="/approve/${esc(token)}">
<input type="hidden" name="csrf" value="${esc(csrf)}">
<label>Para confirmar, escribí el slug del flow (<code>${esc(c.flow.slug)}</code>):<br>
<input name="slug" autocomplete="off" required style="width:100%;padding:6px;margin:8px 0"></label>
<button type="submit" style="padding:8px 16px">Aprobar</button>
</form>`,
    );
  });

  app.post('/approve/:token', async (req, reply) => {
    const { token } = req.params as { token: string };
    const c = await check(req, reply, token);
    if (!c) return reply;
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (!csrfOk(deps.sessionSecret, c.tokenHash, c.email, body.csrf)) {
      return send(reply, 403, 'Formulario inválido', '<p>El formulario venció o no es de esta página. Volvé a abrir el link.</p>');
    }
    if (typeof body.slug !== 'string' || body.slug.trim() !== c.flow.slug) {
      return send(reply, 400, 'El slug no coincide', `<p>Escribí exactamente <code>${esc(c.flow.slug)}</code> para confirmar.</p>`);
    }

    // Un solo uso, en una escritura condicional: si dos POST llegan juntos, uno solo pasa.
    if (!(await deps.flowStore.consumeApprovalRequest(c.tokenHash, now()))) {
      return send(reply, 410, 'Link vencido o ya usado', '<p>Este link ya se usó o venció.</p>');
    }

    const approval = await deps.flowStore.recordApproval({
      tenant_id: c.flow.tenant_id,
      flow_id: c.flow.flow_id,
      artifact: c.req.artifact,
      sha256: c.req.sha256,
      approved_by: c.email,
      approver_roles: c.roles,
      self_signed: c.selfSigned,
    });
    const userAgent = String(req.headers['user-agent'] ?? '').slice(0, 200);
    await deps.flowStore.appendEvent({
      flow_id: c.flow.flow_id,
      type: 'approval.granted',
      actor: c.email,
      payload: {
        artifact: approval.artifact,
        sha256: approval.sha256,
        approved_by: approval.approved_by,
        self_signed: approval.self_signed,
        user_agent: userAgent,
      },
    });

    // Avanza el flow sólo si sigue en la revisión de este artefacto. La escritura es
    // condicional: si mientras tanto se reenvió el documento o se abortó, no pisa nada.
    const avance = AVANCE[c.req.artifact];
    if (avance) {
      await advanceFlowIfStatus(deps.flowStore, c.flow.flow_id, avance.from, { status: avance.to, current_phase: avance.phase });
    }

    req.log.info(
      {
        evt: 'approval.granted',
        tenant_id: c.flow.tenant_id,
        flow_id: c.flow.flow_id,
        artifact: approval.artifact,
        sha256: approval.sha256,
        approved_by: approval.approved_by,
        self_signed: approval.self_signed,
        user_agent: userAgent,
      },
      'approval granted',
    );

    return send(
      reply,
      200,
      `${NOMBRE[c.req.artifact]} aprobado`,
      `<p>Quedó registrada la aprobación de <b>${esc(c.email)}</b> sobre la versión <code>${esc(c.req.sha256.slice(0, 12))}</code>${approval.self_signed ? ' (firma propia)' : ''}. Ya podés cerrar esta pestaña.</p>`,
    );
  });
}
