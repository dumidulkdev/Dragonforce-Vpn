import { build } from 'esbuild';

await Promise.all([
  build({
    entryPoints: ['src/main/index.ts', 'src/main/preload.ts', 'src/main/desktop.ts'],
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    external: ['electron'],
    outExtension: { '.js': '.cjs' },
    outdir: 'dist-electron',
    logLevel: 'info',
  }),
  build({
    entryPoints: ['src/main/standalone.ts'],
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    define: { 'import.meta.url': '__controllerModuleUrl' },
    banner: { js: "var __controllerModuleUrl = require('node:url').pathToFileURL(__filename).href;" },
    outfile: 'dist-electron/controller.cjs',
    logLevel: 'info',
  }),
]);
