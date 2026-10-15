import { describe, expect, it } from 'vitest';
import { generateQaPlan } from '../src/stories/qa-plan.js';

describe('generateQaPlan', () => {
  it('produces one AC case per criterion plus 2 edge cases', () => {
    const plan = generateQaPlan(['User can log in', 'Failed login shows error', 'p99 < 500ms']);
    expect(plan.cases).toHaveLength(5);
    expect(plan.cases.slice(0, 3).map((c) => c.case_id)).toEqual(['AC-1', 'AC-2', 'AC-3']);
    expect(plan.cases.slice(0, 3).every((c) => c.type === 'ac')).toBe(true);
    expect(plan.cases[0]?.description).toBe('User can log in');
    expect(plan.cases[0]?.ac_ref).toBe('AC-1');
    expect(plan.cases[3]?.case_id).toBe('EDGE-1');
    expect(plan.cases[4]?.case_id).toBe('EDGE-2');
    expect(plan.cases[3]?.type).toBe('edge');
  });

  it('still emits the 2 edge cases when there are no ACs', () => {
    const plan = generateQaPlan([]);
    expect(plan.cases.map((c) => c.case_id)).toEqual(['EDGE-1', 'EDGE-2']);
  });

  it('sets generated_at to an ISO string', () => {
    const plan = generateQaPlan(['x']);
    expect(() => new Date(plan.generated_at).toISOString()).not.toThrow();
    expect(plan.generated_at).toBe(new Date(plan.generated_at).toISOString());
  });

  it('is deterministic for the same input (modulo timestamp)', () => {
    const a = generateQaPlan(['a', 'b']);
    const b = generateQaPlan(['a', 'b']);
    expect(a.cases).toEqual(b.cases);
  });
});
