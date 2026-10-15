import type { ValidationIssue, ValidationResult } from '@sdlc/core';

/**
 * Heuristic structural validator for the PRD/RFC markdown produced by an agent.
 * It looks for required headings (case-insensitive, accent-insensitive) and basic
 * content density. Not a full parser — but cheap, deterministic, and good enough
 * to gate handoffs between phases.
 */
export interface SectionRule {
  /** Logical id (matches `required_sections` in catalog frontmatter). */
  id: string;
  /** Possible heading aliases. We match if any of these is found. */
  aliases: string[];
  /** Minimum number of non-blank content lines under the heading. Default 1. */
  minContentLines?: number;
  /** Severity if the section is missing. Default 'error'. */
  severityIfMissing?: ValidationIssue['severity'];
}

const HEADING_RE = /^#{1,6}\s+(.+?)\s*$/;

export function validateMarkdownSections(markdown: string, rules: SectionRule[]): ValidationResult {
  const issues: ValidationIssue[] = [];
  const sections = extractSections(markdown);

  for (const rule of rules) {
    const found = sections.find((s) =>
      rule.aliases.some((alias) => normalize(s.heading) === normalize(alias)),
    );
    if (!found) {
      issues.push({
        severity: rule.severityIfMissing ?? 'error',
        section: rule.id,
        message: `Missing required section "${rule.id}" (looked for headings: ${rule.aliases.join(', ')}).`,
      });
      continue;
    }
    const minLines = rule.minContentLines ?? 1;
    const nonBlank = found.body.split('\n').filter((l) => l.trim().length > 0).length;
    if (nonBlank < minLines) {
      issues.push({
        severity: 'warning',
        section: rule.id,
        message: `Section "${rule.id}" exists but has fewer than ${minLines} content line(s).`,
      });
    }
    if (hasAngleBracketPlaceholder(found.body)) {
      issues.push({
        severity: 'error',
        section: rule.id,
        message: `Section "${rule.id}" still contains unfilled template placeholders ("<...>").`,
      });
    }
    if (hasTbdMarker(found.body)) {
      issues.push({
        severity: 'warning',
        section: rule.id,
        message: `Section "${rule.id}" contains [TBD] markers — resolve before approval.`,
      });
    }
  }

  return {
    ok: issues.every((i) => i.severity !== 'error'),
    issues,
  };
}

export interface ExtractedSection {
  heading: string;
  body: string;
}

export function extractSections(markdown: string): ExtractedSection[] {
  const lines = markdown.split('\n');
  const sections: ExtractedSection[] = [];
  let current: ExtractedSection | undefined;

  for (const line of lines) {
    const m = line.match(HEADING_RE);
    if (m) {
      if (current) sections.push(current);
      current = { heading: m[1] ?? '', body: '' };
    } else if (current) {
      current.body += line + '\n';
    }
  }
  if (current) sections.push(current);
  return sections;
}

function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function hasTbdMarker(body: string): boolean {
  return /\bTBD\b/i.test(body);
}

function hasAngleBracketPlaceholder(body: string): boolean {
  // Angle-bracket placeholder like "<algo>" but excluding genuine HTML/markdown autolinks.
  // Matches "<word>" tokens that don't look like URLs or closing tags.
  const placeholderRe = /<[^<>\n]{1,80}>/g;
  for (const match of body.matchAll(placeholderRe)) {
    const inner = match[0].slice(1, -1).trim();
    if (!inner) continue;
    if (/^https?:\/\//i.test(inner)) continue;
    if (/^\//.test(inner)) continue; // closing tag
    return true;
  }
  return false;
}
