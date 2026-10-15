import { z } from 'zod';
import { StoryInput } from '@sdlc/core';
import type { ExternalRef, TenantCtx } from '@sdlc/adapters-contracts';
import type { TaskSystemProvider } from '../../adapters/task-system-provider.js';
import type { FlowStore } from '../../state/index.js';
import { resolveFlowForCtx } from './flow-access.js';
import { assertRole } from './role-guard.js';
import { assertFlowNotAborted } from './abort-flow.js';
import { crearStories } from './backlog-core.js';
import { acceptanceCriteriaSinContenido } from '../../validation/acceptance-criteria.js';
// El texto de "declará el repo en el RFC" vive junto al gate que lo exige, para
// que las dos mitades del chequeo nombren la misma salida ejecutable.
import { DECLARA_EL_REPO } from './submit-review-outcome.js';

export const CreateStoriesInput = z.object({
  flow_id: z.string().min(1),
  epic_id: z.string().min(1),
  stories: z.array(StoryInput).min(1),
});
export type CreateStoriesInput = z.infer<typeof CreateStoriesInput>;

export function makeCreateStoriesTool(store: FlowStore, taskSystemProvider: TaskSystemProvider) {
  return {
    name: 'create_stories',
    description:
      'Creates user stories under the epic in the external task system and links them to the epic. Requires create_epic to have run (flow.epic_external_id present).',
    inputSchema: CreateStoriesInput,
    handler: async (input: CreateStoriesInput, ctx: TenantCtx) => {
      const resolved = await resolveFlowForCtx(store, ctx, input.flow_id);
      if (!resolved.ok) return { ok: false, error: resolved.error };
      const flow = resolved.flow;

      // Guarda de rol antes de cualquier side-effect, y el orden importa: el loop de
      // abajo llama `createStory` + `linkChildToParent` contra el sistema externo de
      // tareas, una story por vuelta y sin rollback. Un rechazo tardío dejaría un
      // backlog a medio crear.
      //
      // El catálogo le asigna `shaping` a `pmo`; `tech-lead` como break-glass. Es
      // además la mitad temprana del gate de repo: acá se copia el `target_repo` de
      // cada story desde el registro de componentes del RFC, así que el rol que
      // crea stories no debería ser el mismo que después abre el PR.
      const roleDenied = assertRole(ctx, ['pmo', 'tech-lead'], 'create_stories', flow.project);
      if (roleDenied) {
        return {
          ok: false,
          error:
            `${roleDenied} Verificá tus roles con whoami y pedile a alguien con rol pmo o tech-lead en ` +
            'ese workspace que ejecute create_stories. No se creó ninguna story.',
        };
      }

      // Un flow abandonado no acepta backlog nuevo. `create_stories` sólo miraba
      // `epic_external_id`, así que sin esto seguía creando stories sobre un flow
      // abortado.
      const abortedDenied = assertFlowNotAborted(flow, 'create_stories');
      if (abortedDenied) return { ok: false, error: abortedDenied };

      if (!flow.epic_external_id) {
        return { ok: false, error: 'Cannot create stories: no epic exists yet. Call create_epic first.' };
      }
      if (input.epic_id !== flow.epic_external_id) {
        return {
          ok: false,
          error: `epic_id "${input.epic_id}" does not match this flow's epic "${flow.epic_external_id}".`,
        };
      }

      // Resolve each story's target component from the flow's registry.
      // 1 story = 1 repo = 1 PR. When a flow has exactly one component (the
      // common single-repo case, incl. the one synthesized from existing_repo),
      // stories that omit `component` default to it.
      // Piso de los criterios de aceptación, antes de crear nada: un criterio vacío
      // entra igual en el denominador de la cobertura de QA.
      for (const story of input.stories) {
        const sinContenido = acceptanceCriteriaSinContenido(story.acceptance_criteria, story.title);
        if (sinContenido) return { ok: false, error: `${sinContenido} No se creó ninguna story.` };
      }

      const components = flow.components ?? [];
      const byName = new Map(components.map((c) => [c.name, c]));
      const soleComponent = components.length === 1 ? components[0] : undefined;
      for (const story of input.stories) {
        if (story.component && !byName.has(story.component)) {
          return {
            ok: false,
            error: `Story "${story.title}" references unknown component "${story.component}". Declared components: ${
              components.length > 0 ? components.map((c) => c.name).join(', ') : '(none)'
            }.`,
          };
        }
        if (!story.component && components.length > 1) {
          return {
            ok: false,
            error: `Story "${story.title}" must specify "component" — this flow declares ${components.length} components: ${components
              .map((c) => c.name)
              .join(', ')}.`,
          };
        }

        // Toda story tiene que nacer con un repo declarado.
        //
        // Es la mitad temprana del gate de code review: `submit_review_outcome`
        // exige que el PR pertenezca al repo de la story, y sin repo declarado
        // ese chequeo no tiene contra qué comparar. Un RFC con
        // `codebase_status: greenfield` es válido sin `components` ni
        // `existing_repo` —el frontmatter sólo exige repo cuando el codebase es
        // `existing`— así que hasta acá las stories salían sin `target_repo` y el
        // gate quedaba desactivado para el flow entero.
        //
        // Por qué acá y no en `report_progress` cuando se setea el `pr_url`: si
        // el repo lo declarara el mismo developer que declara el PR, el chequeo
        // sería tautológico (declaro mallory/scratch, abro el PR en
        // mallory/scratch, pasa) y el agujero volvería intacto. El repo tiene que
        // venir del RFC, que es el documento que alguien lee. Y `create_stories`
        // es el último momento en que eso es corregible: el flow todavía está en
        // `rfc_ready` (`create_epic` no lo mueve), o sea que `submit_rfc` sigue
        // aceptando una revisión. Un paso más adelante ya no.
        const target = story.component ? byName.get(story.component) : soleComponent;
        const declaredRepo = target?.repo ?? flow.existing_repo;
        if (!declaredRepo) {
          return {
            ok: false,
            error:
              `create_stories: la story "${story.title}" no declara ningún repo y este flow tampoco ` +
              '(sin components ni existing_repo). Sin repo declarado, el code review no tiene contra qué ' +
              'verificar el PR y terminaría firmando sobre cualquier repo. ' +
              `${DECLARA_EL_REPO} El flow está en status "${flow.status}", así que submit_rfc todavía lo acepta. ` +
              'Después volvé a llamar create_stories. No se creó ninguna story.',
          };
        }
      }

      const taskSystem = await taskSystemProvider.resolve(ctx, flow);
      const refs = await crearStories(
        store,
        taskSystem,
        flow,
        input.epic_id,
        input.stories.map((story) => ({
          story,
          component: story.component ? byName.get(story.component) : soleComponent,
        })),
        ctx,
      );

      return {
        ok: true,
        data: { story_refs: refs },
        next_actions: ['link_subtasks', 'sync_backlog'],
      };
    },
  };
}
