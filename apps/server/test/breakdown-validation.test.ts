import { describe, expect, it } from 'vitest';
import { validateBreakdown } from '../src/validation/breakdown.js';

const VALID = {
  epic: { title: 'E', description: 'd' },
  stories: [
    { title: 'S1', description: 'd', acceptance_criteria: ['ac1', 'ac2'] },
  ],
};

describe('validateBreakdown', () => {
  it('passes a well-formed breakdown', () => {
    expect(validateBreakdown(VALID).ok).toBe(true);
  });

  it('fails when epic title is empty', () => {
    const r = validateBreakdown({ ...VALID, epic: { title: '', description: 'd' } });
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.section === 'epic')).toBe(true);
  });

  it('fails when there are no stories', () => {
    const r = validateBreakdown({ ...VALID, stories: [] });
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.section === 'stories')).toBe(true);
  });

  it('fails when a story has no acceptance criteria', () => {
    const r = validateBreakdown({
      ...VALID,
      stories: [{ title: 'S', description: 'd', acceptance_criteria: [] }],
    });
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.message.includes('acceptance'))).toBe(true);
  });

  it('warns when a story has more than 5 acceptance criteria', () => {
    const r = validateBreakdown({
      ...VALID,
      stories: [
        { title: 'S', description: 'd', acceptance_criteria: ['1', '2', '3', '4', '5', '6'] },
      ],
    });
    expect(r.ok).toBe(true); // warning, not error
    expect(r.issues.some((i) => i.severity === 'warning')).toBe(true);
  });
});
