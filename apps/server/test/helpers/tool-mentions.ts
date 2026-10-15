/**
 * Menciones de llamadas a tools con la forma canónica `nombre({a, b?, c:"valor"})`.
 *
 * La forma es estrecha a propósito: una línea, un nombre en snake_case, llaves adentro de
 * los paréntesis. Lo que no calce no se revisa. Un falso negativo es tolerable; un falso
 * positivo hace que alguien desactive el test.
 */
export interface ToolMention {
  tool: string;
  args: MentionArg[];
  /** El texto tal cual, para que el mensaje de error diga qué hay que corregir. */
  raw: string;
}

export interface MentionArg {
  key: string;
  /** `clave?` en la mención: el prompt la declara opcional. */
  optional: boolean;
  /** `clave:"valor"`: el valor literal, para cruzarlo contra el schema. */
  value?: string;
}

const CALL = /([a-z][a-z0-9_]*)\(\{([^{}()\n]*)\}\)/g;

export function parseToolMentions(text: string): ToolMention[] {
  const mentions: ToolMention[] = [];
  for (const match of text.matchAll(CALL)) {
    const [raw, tool, body] = match as unknown as [string, string, string];
    mentions.push({ tool, args: parseArgs(body), raw });
  }
  return mentions;
}

function parseArgs(body: string): MentionArg[] {
  return body
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const colon = part.indexOf(':');
      const keyPart = (colon === -1 ? part : part.slice(0, colon)).trim();
      const optional = keyPart.endsWith('?');
      const key = optional ? keyPart.slice(0, -1) : keyPart;
      // Sólo un valor entre comillas es un literal; `clave: algo` sin comillas es un
      // placeholder y no hay nada que cruzar.
      const quoted = colon === -1 ? null : /^["'](.*)["']$/.exec(part.slice(colon + 1).trim());
      return quoted ? { key, optional, value: quoted[1] } : { key, optional };
    });
}
