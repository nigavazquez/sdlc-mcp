/**
 * Reglas de arquitectura que hasta ahora sólo vivían en ARCHITECTURE.md.
 *
 * Las cuatro que están acá son las que el repo ya declaró por escrito y sostenía
 * únicamente con la disciplina de quien revisa: un import que las violara compilaba,
 * pasaba los tests y pasaba CI. Las cuatro se cumplen hoy, así que este linter entra en
 * verde — su trabajo es el futuro, no el presente.
 *
 * Sobre la versión: dependency-cruiser 16 es la última que soporta Node 20
 * (`^18.17||>=20`), que es el pin del repo. Las 17+ exigen ^22||^24||>=26 y CI
 * —que corre en 20— las rechaza. Subir el pin de Node es una decisión aparte.
 *
 * Regla para agregar reglas: sólo las que el repo ya decidió y puede explicar. Un
 * linter que impone criterios que nadie discutió se termina desactivando.
 */
module.exports = {
  forbidden: [
    {
      name: 'sin-ciclos',
      severity: 'error',
      comment:
        'Un ciclo entre módulos hace que el orden de inicialización importe y que ' +
        'nada se pueda entender por separado.',
      from: {},
      to: { circular: true },
    },
    {
      name: 'tools-no-tocan-adapters',
      severity: 'error',
      comment:
        'Las tools resuelven su adapter en tiempo de llamada a través del provider ' +
        '(ConfigBackedTaskSystemProvider y compañía), porque el adapter concreto ' +
        'depende de la config del workspace. Una tool que importe el adapter directo ' +
        'hornea la elección y saltea la resolución por tenant. Ver ARCHITECTURE.md ' +
        '§ Modelo de adapters.',
      from: { path: '^apps/server/src/mcp/tools/' },
      to: {
        path: '^apps/server/src/adapters/',
        pathNot: '(provider|index)\\.ts$',
      },
    },
    {
      name: 'packages-no-dependen-de-apps',
      severity: 'error',
      comment:
        'packages/ son las piezas compartidas y apps/ las consume. La flecha al ' +
        'revés convierte a core en algo que no se puede publicar ni reusar.',
      from: { path: '^packages/' },
      to: { path: '^apps/' },
    },
    {
      name: 'core-es-hoja',
      severity: 'error',
      comment:
        '@sdlc/core son tipos y schemas: si empieza a depender de otro package del ' +
        'monorepo deja de ser la base sobre la que los demás se apoyan.',
      from: { path: '^packages/core/' },
      to: { path: '^packages/(?!core/)' },
    },
  ],

  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '(node_modules|dist|\\.turbo)' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.base.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      extensions: ['.ts', '.js', '.mjs', '.cjs'],
    },
    reporterOptions: {
      text: { highlightFocused: true },
    },
  },
};
