// shims re-exporting the host's module instances + the Tailwind compiler bundle for Jint
import fs from 'fs'; import { buildSync } from 'esbuild'; import { createRequire } from 'module';
const require = createRequire(import.meta.url);
fs.mkdirSync('host/public/_lo', { recursive: true });
const shim = (key, names) => `const m=globalThis.__lo[${JSON.stringify(key)}];export default m.default??m;\n` + names.filter(n => n !== 'default' && /^[A-Za-z]\w*$/.test(n)).map(n => `export const ${n}=m.${n};`).join('\n');
for (const [k, f] of [['react', 'react'], ['react/jsx-runtime', 'jsx-runtime'], ['react-dom', 'react-dom']]) fs.writeFileSync(`host/public/_lo/${f}.js`, shim(k, Object.keys(require(k))));
const sdk = [...fs.readFileSync('host/sdk.tsx', 'utf8').matchAll(/export (?:const|function) (\w+)/g)].map(m => m[1]);
fs.writeFileSync('host/public/_lo/sdk.js', shim('@laborchestra/sdk', sdk));
buildSync({ entryPoints: ['tw/entry.js'], bundle: true, minify: true, format: 'iife', target: 'es2022', loader: { '.css': 'text' }, outfile: 'dist/tailwind.js' });
