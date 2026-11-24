import { annotationMarker, type Annotation } from '@sdlc/adapters-contracts';

// ---------------------------------------------------------------------------
// Comentario de detalle de una firma propia (QA o review)
// ---------------------------------------------------------------------------
//
// Cuando quien firma QA o review es el mismo assignee de la historia, la firma
// deja una marca visible en el issue y en el PR: una etiqueta y este comentario.
// El texto es el mismo en los dos lugares y lo arma esta función pura; las tools
// sólo le pasan los datos ya validados y llaman a `annotate` del adapter.
//
// El marcador oculto depende sólo de story_id y tipo de firma, así un reintento
// de la misma firma (otra fecha, otra corrida) actualiza el comentario en vez de
// sumar otro, y QA y review del mismo story no se pisan entre sí.

export type SelfSignoffKind = 'qa' | 'review';

export const SELF_SIGNOFF_LABELS: Record<SelfSignoffKind, string> = {
  qa: 'sdlc:qa-propio',
  review: 'sdlc:review-propio',
};

const TITLES: Record<SelfSignoffKind, string> = {
  qa: 'QA propio',
  review: 'Review propio',
};

export interface SelfSignoffCaseResult {
  /** Id del caso del plan de QA (p.ej. `AC-1`). */
  case_id: string;
  /** Texto del criterio o del caso. Si falta, la fila muestra sólo el `case_id`. */
  criterion?: string;
  status: string;
  evidence_url?: string;
  /** URLs https ya validadas por quien llama. Se muestran como imágenes. */
  screenshots?: string[];
  notes?: string;
}

export interface SelfSignoffCommentInput {
  kind: SelfSignoffKind;
  /** Identidad de quien firma (`ctx.userId`). */
  signer: string;
  story: {
    story_id: string;
    external_id: string;
    title: string;
    acceptance_criteria: string[];
  };
  flow_id: string;
  /** ISO-8601. */
  signed_at: string;
  /** La corrida que respalda la firma. Opcional: el review no tiene comando. */
  envelope?: {
    test_command: string;
    test_exit_code: number;
    test_output_hash: string;
  };
  results: SelfSignoffCaseResult[];
}

/** Clave del marcador oculto: estable entre reintentos de la misma firma. */
function markerKey(input: SelfSignoffCommentInput): string {
  return `self-signoff:${input.kind}:${input.story.story_id}`;
}

export function renderSelfSignoffComment(input: SelfSignoffCommentInput): string {
  if (input.results.length === 0) {
    throw new Error(
      'renderSelfSignoffComment: hacen falta resultados por criterio; un comentario sin criterios no respalda la firma',
    );
  }

  const lines: string[] = [
    annotationMarker(markerKey(input)),
    `### ${TITLES[input.kind]} — firmado por ${inline(input.signer)}`,
    '',
    `Story #${inline(input.story.external_id)} · ${inline(input.story.title)} · ` +
      `flow ${inline(input.flow_id)} · ${inline(input.signed_at)}`,
  ];

  if (input.envelope) {
    const e = input.envelope;
    lines.push(
      `Comando: ${code(e.test_command)} · exit ${e.test_exit_code} · ${inline(e.test_output_hash)}`,
    );
  }

  lines.push('', '| Criterio | Resultado | Evidencia |', '|---|---|---|');
  for (const r of input.results) {
    const label = r.criterion ? `${r.case_id} — ${r.criterion}` : r.case_id;
    const status = r.notes ? `${r.status} — ${r.notes}` : r.status;
    const evidence = r.evidence_url ? `[evidencia](${safeUrl(r.evidence_url)})` : 'sin evidencia';
    lines.push(`| ${cell(label)} | ${cell(status)} | ${evidence} |`);
  }

  const shots = input.results.flatMap((r) =>
    (r.screenshots ?? []).map((url, i, all) => {
      const alt = all.length > 1 ? `${r.case_id} (${i + 1})` : r.case_id;
      return `![${altText(alt)}](${safeUrl(url)})`;
    }),
  );
  if (shots.length > 0) lines.push('', ...shots);

  if (input.story.acceptance_criteria.length > 0) {
    lines.push(
      '',
      '<details><summary>Criterios de la historia</summary>',
      '',
      ...input.story.acceptance_criteria.map((ac, i) => `${i + 1}. ${inline(ac)}`),
      '',
      '</details>',
    );
  }

  return lines.join('\n') + '\n';
}

/** La anotación completa: etiqueta del tipo de firma + comentario de detalle. */
export function selfSignoffAnnotation(input: SelfSignoffCommentInput): Annotation {
  return { labels: [SELF_SIGNOFF_LABELS[input.kind]], body: renderSelfSignoffComment(input) };
}

// ---------------------------------------------------------------------------
// Escapes: el texto viene del agente y no debe romper el markdown
// ---------------------------------------------------------------------------

/** Una línea: los saltos de línea pasan a espacios. */
function inline(s: string): string {
  return s.replace(/\s*[\r\n]+\s*/g, ' ').trim();
}

/** Celda de tabla: una línea y sin pipes que la partan. */
function cell(s: string): string {
  return inline(s).replace(/\|/g, '\\|');
}

/** Código inline que sobrevive a backticks en el comando. */
function code(s: string): string {
  const text = inline(s);
  return text.includes('`') ? `\`\` ${text} \`\`` : `\`${text}\``;
}

function altText(s: string): string {
  return inline(s).replace(/[[\]]/g, '');
}

/** Codifica los caracteres que cerrarían el link o la imagen antes de tiempo. */
function safeUrl(url: string): string {
  return url.trim().replace(/[\s()<>]/g, (c) => encodeURIComponent(c));
}
