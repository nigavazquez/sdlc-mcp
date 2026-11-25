declare const __SDLC_VERSION__: string | undefined;

/** Versión del paquete, grabada por esbuild en el build. Desde las fuentes (tests) es `dev`. */
export const SDLC_VERSION: string = typeof __SDLC_VERSION__ === 'string' ? __SDLC_VERSION__ : 'dev';

export type InstallOrigin = 'npm' | 'monorepo';

/**
 * De dónde corre el CLI: instalado por npm (node_modules o la caché de npx) o desde un
 * clon del monorepo. `init` lo deja en config.json y `doctor` lo reporta.
 */
export function originOf(cliPath: string): InstallOrigin {
  return /[\\/](node_modules|_npx)[\\/]/.test(cliPath) ? 'npm' : 'monorepo';
}
