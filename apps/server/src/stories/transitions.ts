import type { StoryStatus } from '@sdlc/core';

/**
 * `discarded` es alcanzable desde cualquier estado no terminal y desde ningún
 * lado más: una story ya `merged` no se puede descartar por atrás (el trabajo se
 * mergeó; borrarlo del conteo sería reescribir la historia), y `discarded` no
 * vuelve. La transición la ejecuta sólo `discard_story`, con rol tech-lead.
 */
const TRANSITIONS: Record<StoryStatus, StoryStatus[]> = {
  created: ['claimed', 'discarded'],
  claimed: ['in_progress', 'in_review', 'discarded'],
  in_progress: ['in_review', 'discarded'],
  in_review: ['qa_passed', 'blocked', 'discarded'],
  qa_passed: ['merged', 'in_progress', 'discarded'],
  blocked: ['in_progress', 'in_review', 'discarded'],
  merged: [],
  discarded: [],
};

export function canTransition(from: StoryStatus, to: StoryStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function listAllowedTargets(from: StoryStatus): StoryStatus[] {
  return [...TRANSITIONS[from]];
}
