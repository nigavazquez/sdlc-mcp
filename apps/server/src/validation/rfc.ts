import type { ValidationIssue, ValidationResult } from '@sdlc/core';
import { validateMarkdownSections, type SectionRule } from './markdown-sections.js';
import { parseRfcFrontmatter } from './rfc-frontmatter.js';

export const RFC_RULES: SectionRule[] = [
  { id: 'context', aliases: ['Context', 'Contexto'], minContentLines: 1 },
  { id: 'architecture_context', aliases: ['Architecture context', 'Contexto de arquitectura'], minContentLines: 1 },
  { id: 'goals', aliases: ['Goals', 'Objetivos'], minContentLines: 1 },
  { id: 'non_goals', aliases: ['Non-goals', 'Non Goals', 'No-objetivos'], minContentLines: 1 },
  { id: 'design', aliases: ['Design', 'Diseño', 'Diseno'], minContentLines: 3 },
  { id: 'risks', aliases: ['Risks', 'Riesgos'], minContentLines: 3 },
  { id: 'rollout', aliases: ['Rollout'], minContentLines: 1 },
  { id: 'rollback', aliases: ['Rollback'], minContentLines: 1 },
];

export const ARCH_SUBSECTIONS: SectionRule[] = [
  { id: 'architecture_mode', aliases: ['Architecture mode', 'Modo de arquitectura'], minContentLines: 1 },
  { id: 'existing_components_reused', aliases: ['Existing components reused', 'Componentes reusados'], minContentLines: 1 },
  { id: 'codebase_context', aliases: ['Codebase context', 'Contexto de codebase'], minContentLines: 1 },
  // Integration points is conditionally required — handled after parsing frontmatter.
];

/**
 * Obligatoria cuando `architecture_mode` es reuse/hybrid o el flow declara más de un
 * componente: el contrato entre repos tiene que quedar escrito. Va aparte de
 * `ARCH_SUBSECTIONS` porque el catálogo la declara como condicional.
 */
export const INTEGRATION_RULE: SectionRule = {
  id: 'integration_points',
  aliases: ['Integration points', 'Puntos de integración'],
  minContentLines: 1,
};

export function validateRfc(markdown: string): ValidationResult {
  const issues: ValidationIssue[] = [];

  const parsed = parseRfcFrontmatter(markdown);
  issues.push(...parsed.issues);

  // Validate body sections against the existing markdown-section helper.
  const bodyResult = validateMarkdownSections(parsed.body, RFC_RULES);
  issues.push(...bodyResult.issues);

  // Validate the 3 always-required Architecture context sub-sections.
  const subResult = validateMarkdownSections(parsed.body, ARCH_SUBSECTIONS);
  issues.push(...subResult.issues);

  // Conditionally require Integration points: architecture_mode reuse/hybrid,
  // or a multi-component flow (the cross-repo contract must be written down).
  const requiresIntegration =
    parsed.frontmatter.architecture_mode === 'reuse' ||
    parsed.frontmatter.architecture_mode === 'hybrid' ||
    (parsed.frontmatter.components?.length ?? 0) > 1;
  if (requiresIntegration) {
    const ipResult = validateMarkdownSections(parsed.body, [INTEGRATION_RULE]);
    // architecture_mode ∈ {reuse, hybrid} hace que esta sección sea un requisito
    // duro: una sección vacía es ERROR, no warning. Promovemos la severidad.
    for (const issue of ipResult.issues) {
      if (issue.section === 'integration_points' && issue.severity === 'warning') {
        issues.push({ ...issue, severity: 'error' });
      } else {
        issues.push(issue);
      }
    }
  }

  return { ok: issues.every((i) => i.severity !== 'error'), issues };
}
