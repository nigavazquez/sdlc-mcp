import { describe, expect, it } from 'vitest';
import { canTransition, listAllowedTargets } from '../src/stories/transitions.js';
import type { StoryStatus } from '@sdlc/core';

describe('story FSM', () => {
  it('allows the documented transitions', () => {
    expect(canTransition('created', 'claimed')).toBe(true);
    expect(canTransition('claimed', 'in_progress')).toBe(true);
    expect(canTransition('claimed', 'in_review')).toBe(true);
    expect(canTransition('in_progress', 'in_review')).toBe(true);
    expect(canTransition('in_review', 'qa_passed')).toBe(true);
    expect(canTransition('in_review', 'blocked')).toBe(true);
    expect(canTransition('blocked', 'in_progress')).toBe(true);
    expect(canTransition('blocked', 'in_review')).toBe(true);
  });

  it('rejects invalid transitions', () => {
    expect(canTransition('created', 'in_review')).toBe(false);
    expect(canTransition('created', 'qa_passed')).toBe(false);
    expect(canTransition('qa_passed', 'in_review')).toBe(false);
    expect(canTransition('qa_passed', 'blocked')).toBe(false);
    expect(canTransition('claimed', 'qa_passed')).toBe(false);
    expect(canTransition('in_progress', 'qa_passed')).toBe(false);
    expect(canTransition('blocked', 'qa_passed')).toBe(false);
  });

  it('listAllowedTargets returns the expected set for each state', () => {
    expect(new Set(listAllowedTargets('created'))).toEqual(new Set<StoryStatus>(['claimed', 'discarded']));
    expect(new Set(listAllowedTargets('blocked'))).toEqual(
      new Set<StoryStatus>(['in_progress', 'in_review', 'discarded']),
    );
    expect(new Set(listAllowedTargets('qa_passed'))).toEqual(
      new Set<StoryStatus>(['merged', 'in_progress', 'discarded']),
    );
  });

  // `discarded` es el terminal de descarte que le falta al FSM: sin él, una story
  // creada de más deja el flow sin poder cerrar nunca (el cierre exige que ninguna
  // hermana quede fuera de `merged`, y `blocked` tampoco lo es).
  it('permite descartar desde cualquier estado no terminal', () => {
    for (const from of ['created', 'claimed', 'in_progress', 'in_review', 'qa_passed', 'blocked'] as StoryStatus[]) {
      expect(canTransition(from, 'discarded')).toBe(true);
    }
  });

  it('no se puede descartar lo ya mergeado ni resucitar lo descartado', () => {
    expect(canTransition('merged', 'discarded')).toBe(false);
    expect(listAllowedTargets('discarded')).toEqual([]);
    expect(canTransition('discarded', 'in_progress')).toBe(false);
    expect(canTransition('discarded', 'merged')).toBe(false);
  });

  it('allows qa_passed → merged', () => {
    expect(canTransition('qa_passed', 'merged')).toBe(true);
  });

  it('allows qa_passed → in_progress (review-rework path)', () => {
    expect(canTransition('qa_passed', 'in_progress')).toBe(true);
  });
});
