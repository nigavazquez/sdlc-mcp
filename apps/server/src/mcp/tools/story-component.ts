import type { ComponentKind, Flow, FlowComponent, Story } from '@sdlc/core';
import type { ScenarioContext } from '@sdlc/catalog';

/**
 * Resolves the story's target component from the flow's registry.
 * A story without a component resolves to `undefined` (legacy / single-repo);
 * a story whose component is no longer declared in the RFC is an error —
 * callers must not fall back silently to the flow defaults.
 */
export function resolveStoryComponent(
  flow: Flow,
  story: Story,
): { ok: true; component: FlowComponent | undefined } | { ok: false; error: string } {
  if (!story.component) return { ok: true, component: undefined };
  const component = (flow.components ?? []).find((c) => c.name === story.component);
  if (!component) {
    return {
      ok: false,
      error: `Story targets component "${story.component}" which is no longer declared in the flow's RFC. Re-align the story or the RFC components first.`,
    };
  }
  return { ok: true, component };
}

/** Scenario used to resolve role skills for a story (arch mode + codebase + component kind). */
export function scenarioForStory(flow: Flow, story: Story): ScenarioContext {
  const scenario: ScenarioContext = {};
  if (flow.architecture_mode) scenario.architecture_mode = flow.architecture_mode;
  if (flow.codebase_status) scenario.codebase_status = flow.codebase_status;
  if (story.component_kind) scenario.component_kind = story.component_kind;
  if (flow.initiative_type) scenario.initiative_type = flow.initiative_type;
  return scenario;
}

/**
 * The story's component fields as exposed to implementers/QA. Falls back to
 * flow.existing_repo for legacy stories created before the component registry.
 */
export function storyTargetFields(flow: Flow, story: Story): {
  target_repo: string | null;
  component: string | null;
  component_kind: ComponentKind | null;
} {
  return {
    target_repo: story.target_repo ?? flow.existing_repo ?? null,
    component: story.component ?? null,
    component_kind: story.component_kind ?? null,
  };
}
