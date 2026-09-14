import { build } from 'esbuild';
await build({entryPoints:['src/index.ts'],outfile:'dist/index.js',bundle:true,packages:'external',platform:'node',format:'esm',target:'node22',sourcemap:false});
