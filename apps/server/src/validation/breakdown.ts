import type { Breakdown, ValidationIssue, ValidationResult } from '@sdlc/core';

export function validateBreakdown(b: Breakdown): ValidationResult {
  const issues: ValidationIssue[] = [];

  if (!b.epic || !b.epic.title.trim()) {
    issues.push({ severity: 'error', section: 'epic', message: 'Epic title must not be empty.' });
  }

  if (!b.stories || b.stories.length < 1) {
    issues.push({ severity: 'error', section: 'stories', message: 'Breakdown must have at least one story.' });
  }

  (b.stories ?? []).forEach((s, idx) => {
    const where = `stories[${idx}]`;
    if (!s.title.trim()) {
      issues.push({ severity: 'error', section: where, message: `Story ${idx} title must not be empty.` });
    }
    if (!s.acceptance_criteria || s.acceptance_criteria.length < 1) {
      issues.push({
        severity: 'error',
        section: where,
        message: `Story ${idx} ("${s.title}") must have at least one acceptance criterion.`,
      });
    } else if (s.acceptance_criteria.length > 5) {
      issues.push({
        severity: 'warning',
        section: where,
        message: `Story ${idx} ("${s.title}") has more than 5 acceptance criteria — consider splitting it.`,
      });
    }
  });

  return { ok: issues.every((i) => i.severity !== 'error'), issues };
}
