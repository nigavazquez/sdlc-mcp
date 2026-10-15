import { validateMarkdownSections, type SectionRule } from './markdown-sections.js';

export const PRD_RULES: SectionRule[] = [
  { id: 'problem', aliases: ['Problem', 'Problema'], minContentLines: 1 },
  { id: 'users', aliases: ['Users', 'Usuarios'], minContentLines: 2 },
  {
    id: 'success_metrics',
    aliases: ['Success Metrics', 'Métricas de éxito', 'Metricas de exito'],
    minContentLines: 3,
  },
  { id: 'scope', aliases: ['Scope', 'Alcance'], minContentLines: 2 },
  { id: 'out_of_scope', aliases: ['Out of Scope', 'Fuera de alcance'], minContentLines: 2 },
  { id: 'risks', aliases: ['Risks', 'Riesgos'], minContentLines: 3 },
];

export function validatePrd(markdown: string) {
  return validateMarkdownSections(markdown, PRD_RULES);
}
