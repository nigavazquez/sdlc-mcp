import type { Breakdown, StoryInput } from '@sdlc/core';
import { extractSections } from '../validation/markdown-sections.js';

/**
 * Deterministic, heuristic breakdown suggestion from an RFC body. NOT
 * authoritative — the PMO agent reviews and rewrites it. One story per Goal
 * bullet plus one per H3 sub-section under "Design". Falls back to a single
 * story if neither is present.
 */
export function proposeBreakdown(rfcMarkdown: string, flowTitle: string, rfcRef: string): Breakdown {
  const sections = extractSections(rfcMarkdown);
  const stories: StoryInput[] = [];

  const goals = sections.find((s) => /^goals$/i.test(s.heading.trim()));
  if (goals) {
    for (const line of goals.body.split('\n')) {
      const m = line.match(/^\s*[-*]\s+(.*\S)\s*$/);
      if (m && m[1]) {
        stories.push({
          title: truncate(m[1]),
          description: m[1],
          acceptance_criteria: [],
        });
      }
    }
  }

  const designAreas = ['Data model', 'API / Contracts', 'Security', 'Performance'];
  for (const s of sections) {
    if (designAreas.some((area) => normalize(s.heading) === normalize(area))) {
      stories.push({
        title: `Implementar: ${s.heading.trim()}`,
        description: s.body.trim() || s.heading.trim(),
        acceptance_criteria: [],
      });
    }
  }

  if (stories.length === 0) {
    stories.push({
      title: flowTitle,
      description: `Historia inicial derivada del RFC: ${rfcRef}`,
      acceptance_criteria: [],
    });
  }

  return {
    epic: {
      title: flowTitle,
      description: `Derivado del RFC: ${rfcRef}`,
    },
    stories,
  };
}

function truncate(s: string, max = 80): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}
