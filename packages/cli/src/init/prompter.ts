import { createInterface } from 'node:readline/promises';
import type { Prompter } from './init.js';

/** Preguntas en la terminal. Exige TTY: `init` es interactivo salvo con todos los flags. */
export function terminalPrompter(): Prompter {
  if (!process.stdin.isTTY) {
    throw new Error(
      '`sdlc init` es interactivo: corrélo en una terminal o pasá --server, --workspace, --exclude y --yes',
    );
  }
  const ask = async (question: string, defaultValue?: string): Promise<string> => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = await rl.question(
        defaultValue ? `${question} [${defaultValue}]: ` : `${question}: `,
      );
      return answer.trim() === '' && defaultValue !== undefined ? defaultValue : answer;
    } finally {
      rl.close();
    }
  };
  return {
    ask,
    confirm: async (question) => /^(s|si|sí|y|yes)$/i.test((await ask(`${question} (s/N)`)).trim()),
  };
}
