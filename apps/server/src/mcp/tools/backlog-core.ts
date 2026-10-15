import type { EpicInput, Flow, FlowComponent, StoryInput } from '@sdlc/core';
import type { ExternalRef, TaskSystemAdapter, TenantCtx } from '@sdlc/adapters-contracts';
import type { FlowStore } from '../../state/index.js';

/**
 * El núcleo de shaping: crear el epic y crear las stories contra el sistema externo,
 * persistirlos y dejar el evento.
 *
 * Vive acá y no dentro de las tools porque **tres** caminos lo necesitan: los dos del
 * track completo (`create_epic`, `create_stories`) y el del liviano
 * (`submit_change_note`, que hace en una llamada lo que allá son seis).
 *
 * Lo que este módulo **no** hace es autorizar: las guardas de rol, de status y de
 * flow abortado se quedan en cada tool, porque no son las mismas. Acá se crea; quién
 * puede crear lo decide quien llama.
 */

/** Una story ya resuelta contra el registro de componentes del flow. */
export interface StoryConComponente {
  story: StoryInput;
  /** El componente destino, si el flow declara alguno. Define el `target_repo`. */
  component?: FlowComponent | undefined;
}

/**
 * Crea el epic en el sistema externo, lo persiste en el flow y deja el evento.
 *
 * Devuelve el flow actualizado: quien llama lo necesita para seguir escribiendo sobre
 * la versión que ya tiene `epic_external_id`.
 */
export async function crearEpic(
  store: FlowStore,
  taskSystem: TaskSystemAdapter,
  flow: Flow,
  epic: EpicInput,
  ctx: TenantCtx,
): Promise<{ ref: ExternalRef; flow: Flow }> {
  const ref = await taskSystem.createEpic(
    {
      project_key: flow.project,
      title: epic.title,
      description: epic.description,
      ...(epic.labels ? { labels: epic.labels } : {}),
    },
    ctx,
  );

  const updated = await store.updateFlow(flow.flow_id, { epic_external_id: ref.external_id });
  await store.appendEvent({
    flow_id: flow.flow_id,
    type: 'epic.created',
    actor: ctx.userId,
    payload: { external_id: ref.external_id, url: ref.url },
  });

  return { ref, flow: updated };
}

/**
 * Crea las stories bajo el epic, las cuelga de él y las persiste con su repo destino.
 *
 * El `target_repo` sale del componente y no de quien abre el PR: si lo declarara el
 * mismo developer que después declara el `pr_url`, el gate de code review sería
 * tautológico.
 */
export async function crearStories(
  store: FlowStore,
  taskSystem: TaskSystemAdapter,
  flow: Flow,
  epicId: string,
  stories: StoryConComponente[],
  ctx: TenantCtx,
): Promise<ExternalRef[]> {
  const refs: ExternalRef[] = [];

  for (const { story, component } of stories) {
    const ref = await taskSystem.createStory(
      {
        project_key: flow.project,
        epic_id: epicId,
        title: story.title,
        description: story.description,
        acceptance_criteria: story.acceptance_criteria,
        ...(story.labels ? { labels: story.labels } : {}),
        ...(story.estimate !== undefined ? { estimate: story.estimate } : {}),
      },
      ctx,
    );
    await taskSystem.linkChildToParent(epicId, ref.external_id, ctx);
    await store.createStory({
      flow_id: flow.flow_id,
      external_id: ref.external_id,
      external_url: ref.url,
      title: story.title,
      acceptance_criteria: story.acceptance_criteria,
      ...(component
        ? { target_repo: component.repo, component: component.name, component_kind: component.kind }
        : {}),
    });
    refs.push(ref);
  }

  await store.appendEvent({
    flow_id: flow.flow_id,
    type: 'stories.created',
    actor: ctx.userId,
    payload: { epic_id: epicId, refs },
  });

  return refs;
}
