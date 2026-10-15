import type { StoryQaCase, StoryQaPlan } from '@sdlc/core';

export function generateQaPlan(acceptanceCriteria: string[]): StoryQaPlan {
  const cases: StoryQaCase[] = [];
  acceptanceCriteria.forEach((text, i) => {
    const ref = `AC-${i + 1}`;
    cases.push({ case_id: ref, description: text, ac_ref: ref, type: 'ac' });
  });
  cases.push({
    case_id: 'EDGE-1',
    description: 'Boundary / empty / max input value',
    type: 'edge',
  });
  cases.push({
    case_id: 'EDGE-2',
    description: 'Concurrent or duplicate request handling',
    type: 'edge',
  });
  return { cases, generated_at: new Date().toISOString() };
}
