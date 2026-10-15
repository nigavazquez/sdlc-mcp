import type {
  QaRunEnvelopeInput,
  QaVerdict,
  StoryQaEnvelope,
  ValidationIssue,
} from '@sdlc/core';
import { QA_ENVELOPE_SCHEMA } from '@sdlc/core';

/**
 * Validador del envelope de resultado de QA (`sdlc.qa-result/v1`).
 *
 * El principio, prestado de un contrato que lo tiene bien resuelto: **el ruteo
 * parsea sólo el envelope; la prosa humana nunca controla readiness**. Es decir:
 * `verdict`, `notes` y `block_reason` son para las personas; lo que decide si
 * `submit_qa_results` avanza el flow son los campos estructurados de acá.
 *
 * El validador junta **todos** los problemas y los devuelve juntos. Vive fuera
 * del schema zod de la tool a propósito: `inputSchema.parse()` corre en el borde
 * MCP y **tira**, así que un envelope inválido devolvería un error de zod que no
 * puede enumerar N problemas ni nombrar la salida ejecutable. Con el schema laxo
 * y esta función en el handler, el agente recibe un solo `{ ok:false, error }`
 * accionable. Mismo razonamiento que el de `evidence_url` en
 * `packages/core/src/story.ts`.
 */

// ---------------------------------------------------------------------------
// Placeholders
// ---------------------------------------------------------------------------

/**
 * Regex `not` contra el placeholder **pelado**. Se aplica a los campos de texto
 * libre del envelope (`test_command`) y a los segmentos de path/query de las
 * `evidence_url` (ver `submit-qa-results.ts`).
 *
 * Está anclada al string **entero** a propósito: `pnpm test -- --grep "todo list"`
 * es un comando legítimo y no tiene que caer por contener "todo".
 *
 * Lo que mata, medido: `test_command: "n/a"`, `"TODO"`, `"---"`, `"???"`, el
 * string vacío. Lo que **no** mata, por la misma ancla: `"TODO: correr los
 * tests"`, `"true"`, `"echo ok"`. `MIN_COMMAND_LEN` tampoco filtra nada útil —
 * cualquier cosa de tres caracteres pasa. No lo vendas como más de lo que es: el
 * server no corrió nada, así que no tiene forma de saber si un comando corre
 * tests. `test_command` es **trazabilidad**, igual que `test_output_hash`: dice
 * qué se declaró haber corrido y hace distinguibles dos corridas, no es una
 * barrera contra un agente que quiere pasar sin correr. Lo que sí es barrera es
 * `test_exit_code` cruzado con el veredicto y la cobertura de criterios, más
 * abajo.
 */
const PLACEHOLDER_TEXT =
  /^(n\s*[/\\]?\s*a|na|nd|tbd|todo|to-?do|pending|none|null|nil|undefined|unknown|placeholder|fixme|changeme|xxx+|\?+|-+|_+|\.+)$/i;

/** `true` si el texto es relleno (`n/a`, `TODO`, `TBD`, `---`, `???`, ...). */
export function isPlaceholderText(raw: string): boolean {
  const normalized = raw.trim().replace(/\s+/g, ' ');
  if (normalized.length === 0) return true;
  return PLACEHOLDER_TEXT.test(normalized);
}

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

/** Forma cruda tal como llega del borde MCP: todo opcional, todo sospechoso. */
export type RawQaEnvelope = QaRunEnvelopeInput;

export interface QaEnvelopeContext {
  /** El veredicto declarado en la prosa. Se usa para chequear coherencia, no para decidir. */
  verdict: QaVerdict;
  /**
   * Denominador de `acceptance_criteria`, sacado de `story.acceptance_criteria.length`.
   * **No lo pone el agente**: si lo pusiera, infla el denominador y el número no dice nada.
   */
  acceptance_criteria_total: number;
  /** Momento de la corrida; inyectable para tests. */
  now?: string;
}

export type QaEnvelopeValidation =
  | { ok: true; envelope: StoryQaEnvelope }
  | { ok: false; issues: ValidationIssue[] };

const HASH_RE = /^sha256:([0-9a-f]{64})$/i;
const AC_RE = /^\s*(\d{1,5})\s*\/\s*(\d{1,5})\s*$/;
const MIN_COMMAND_LEN = 3;

/** El bloque que le mostramos al agente cuando lo manda mal o no lo manda. */
export const QA_ENVELOPE_TEMPLATE =
  `envelope:{schema:"${QA_ENVELOPE_SCHEMA}", test_command:"<el comando exacto que corriste>", ` +
  'test_exit_code:<0 si pasó>, test_output_hash:"sha256:<64 hex del output>", ' +
  'acceptance_criteria:"<cubiertos>/<total de la story>"}';

function issue(message: string): ValidationIssue {
  return { severity: 'error', section: 'envelope', message };
}

export function validateQaEnvelope(
  raw: RawQaEnvelope | undefined | null,
  ctx: QaEnvelopeContext,
): QaEnvelopeValidation {
  if (raw === undefined || raw === null || typeof raw !== 'object') {
    return {
      ok: false,
      issues: [
        issue(
          'falta el bloque "envelope". Sin él no hay corrida que auditar: el veredicto sería ' +
            'sólo prosa. Mandá ' +
            QA_ENVELOPE_TEMPLATE,
        ),
      ],
    };
  }

  const issues: ValidationIssue[] = [];

  // --- schema ---------------------------------------------------------------
  if (raw.schema === undefined) {
    issues.push(issue(`falta "schema"; tiene que ser exactamente "${QA_ENVELOPE_SCHEMA}"`));
  } else if (raw.schema.trim() !== QA_ENVELOPE_SCHEMA) {
    issues.push(
      issue(
        `"schema" es ${JSON.stringify(raw.schema)}; la única versión que este server entiende es ` +
          `"${QA_ENVELOPE_SCHEMA}"`,
      ),
    );
  }

  // --- test_command ---------------------------------------------------------
  const command = raw.test_command?.trim() ?? '';
  if (raw.test_command === undefined || command.length === 0) {
    issues.push(
      issue('falta "test_command": el comando exacto con el que corriste la verificación'),
    );
  } else if (isPlaceholderText(command)) {
    issues.push(
      issue(
        `"test_command" es relleno (${JSON.stringify(raw.test_command)}). Poné el comando exacto ` +
          'que ejecutaste, por ejemplo "pnpm --filter @sdlc/server test"',
      ),
    );
  } else if (command.length < MIN_COMMAND_LEN) {
    issues.push(
      issue(
        `"test_command" (${JSON.stringify(command)}) es demasiado corto para ser un comando real`,
      ),
    );
  }

  // --- test_exit_code -------------------------------------------------------
  const exitCode = raw.test_exit_code;
  let exitCodeOk = false;
  if (exitCode === undefined) {
    issues.push(
      issue('falta "test_exit_code": el código de salida del comando (0 si la corrida pasó)'),
    );
  } else if (!Number.isInteger(exitCode) || exitCode < 0 || exitCode > 255) {
    issues.push(
      issue(
        `"test_exit_code" tiene que ser un entero entre 0 y 255 (llegó ${JSON.stringify(exitCode)})`,
      ),
    );
  } else {
    exitCodeOk = true;
  }

  // --- test_output_hash -----------------------------------------------------
  //
  // Qué NO es este hash: **no es verificación**. El server no corrió los tests,
  // así que no tiene contra qué comparar y nunca va a poder decir que el output
  // es auténtico. Sirve igual, por dos motivos concretos:
  //
  //  1. obliga al agente a haber tenido el output en la mano — no se puede
  //     sintetizar un sha256 de algo que no se leyó sin inventar deliberadamente;
  //  2. hace distinguibles a posteriori dos corridas que dicen lo mismo con
  //     outputs distintos: mismo comando, mismo exit code, hash distinto ⇒ son
  //     corridas distintas, y eso se ve en el log de eventos.
  //
  // Es **trazabilidad, no verificación**. No lo vendas como más que eso: ni acá,
  // ni en los mensajes de error, ni en la descripción de la tool.
  let hash = '';
  if (raw.test_output_hash === undefined || raw.test_output_hash.trim().length === 0) {
    issues.push(
      issue(
        'falta "test_output_hash": sha256 del output completo de la corrida, con el prefijo ' +
          '"sha256:" (no lo verificamos contra nada — es trazabilidad, sirve para distinguir ' +
          'dos corridas que dicen lo mismo)',
      ),
    );
  } else {
    const m = HASH_RE.exec(raw.test_output_hash.trim());
    if (!m) {
      issues.push(
        issue(
          `"test_output_hash" (${JSON.stringify(raw.test_output_hash)}) no tiene la forma ` +
            '"sha256:<64 hex>"',
        ),
      );
    } else {
      hash = `sha256:${(m[1] as string).toLowerCase()}`;
    }
  }

  // --- acceptance_criteria --------------------------------------------------
  const total = ctx.acceptance_criteria_total;
  let covered = 0;
  let acOk = false;
  if (raw.acceptance_criteria === undefined || raw.acceptance_criteria.trim().length === 0) {
    issues.push(
      issue(
        `falta "acceptance_criteria": cuántos criterios de aceptación cubriste, con el formato ` +
          `"<cubiertos>/${total}" (el denominador es el de la story, no lo elegís vos)`,
      ),
    );
  } else {
    const m = AC_RE.exec(raw.acceptance_criteria);
    if (!m) {
      issues.push(
        issue(
          `"acceptance_criteria" (${JSON.stringify(raw.acceptance_criteria)}) no tiene el formato ` +
            `"N/M"; mandá "<cubiertos>/${total}"`,
        ),
      );
    } else {
      const declaredCovered = Number(m[1]);
      const declaredTotal = Number(m[2]);
      if (declaredTotal !== total) {
        // El denominador lo pone la story. Dejar que lo declare el agente es
        // dejarlo inflar el total hasta que "6/10" suene bien: el número deja de
        // decir nada. Acá se compara contra `story.acceptance_criteria.length`.
        issues.push(
          issue(
            `el denominador de "acceptance_criteria" no coincide: declaraste ${declaredTotal} y la ` +
              `story tiene ${total} criterio(s) de aceptación. Mandá "<cubiertos>/${total}"`,
          ),
        );
      } else if (declaredCovered > declaredTotal) {
        issues.push(
          issue(
            `"acceptance_criteria" cubre más de lo que hay: ${declaredCovered} de ${declaredTotal}`,
          ),
        );
      } else {
        covered = declaredCovered;
        acOk = true;
      }
    }
  }

  // --- coherencia veredicto ↔ envelope --------------------------------------
  //
  // El veredicto se deriva del envelope, no de la prosa: un `passed` con la
  // corrida en rojo es exactamente el mismo tipo de incoherencia que un `passed`
  // con un caso `failed`, y se rechaza igual.
  if (exitCodeOk && ctx.verdict === 'passed' && exitCode !== 0) {
    issues.push(
      issue(
        `verdict "passed" con test_exit_code=${exitCode}: la corrida que adjuntás falló. ` +
          'Mandá verdict:"blocked" con block_reason describiendo qué rompió, o arreglá el código, ' +
          'volvé a correr los tests hasta exit code 0 y reintentá submit_qa_results con el envelope ' +
          'de esa corrida nueva',
      ),
    );
  }

  // El numerador tampoco es libre. El denominador lo ponía la story, pero
  // `covered` sólo tenía techo (`covered > total` se rechazaba) y no participaba
  // de la coherencia con el veredicto: `acceptance_criteria: "0/3"` con
  // `verdict: "passed"` cerraba la story y, un paso después, el flow entero.
  // Declarar que cubriste cero de tres criterios y llamarlo "pasó" es la misma
  // incoherencia que un `passed` con la corrida en rojo, y se rechaza igual.
  //
  // Con `blocked` no aplica a propósito: un bloqueo se manda justamente porque la
  // verificación no llegó al final, así que la cobertura parcial es el dato, no un
  // problema — exigirla completa dejaría sin forma de reportar el bloqueo. La
  // asimetría es la misma que con el exit code: sólo el camino que **avanza** el
  // flow tiene que cerrar.
  if (acOk && ctx.verdict === 'passed' && covered !== total) {
    issues.push(
      issue(
        `verdict "passed" con acceptance_criteria ${covered}/${total}: quedan ${total - covered} ` +
          'criterio(s) de aceptación sin cubrir, así que la story no está verificada. Cubrí los que ' +
          `faltan y reintentá submit_qa_results con "${total}/${total}", o mandá verdict:"blocked" con ` +
          'block_reason diciendo qué criterio quedó sin verificar y por qué',
      ),
    );
  }

  if (issues.length > 0) return { ok: false, issues };

  // Invariante: llegar acá implica que los cinco campos validaron.
  if (!exitCodeOk || !acOk || hash.length === 0) {
    /* c8 ignore next */
    return { ok: false, issues: [issue('envelope incompleto')] };
  }

  return {
    ok: true,
    envelope: {
      schema: QA_ENVELOPE_SCHEMA,
      test_command: command,
      test_exit_code: exitCode as number,
      test_output_hash: hash,
      acceptance_criteria: { covered, total },
      submitted_at: ctx.now ?? new Date().toISOString(),
    },
  };
}
