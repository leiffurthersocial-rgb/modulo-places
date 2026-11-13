// Copy runtime decoders (Basis transcoder) from node_modules into public/vendor so they are served
// as static files (KTX2Loader loads them by path). Runs on postinstall; output is gitignored.
import { copyFileSync, mkdirSync } from 'node:fs';
const dst = 'public/vendor/basis';
mkdirSync(dst, { recursive: true });
for (const f of ['basis_transcoder.js', 'basis_transcoder.wasm']) {
  copyFileSync(`node_modules/three/examples/jsm/libs/basis/${f}`, `${dst}/${f}`);
}
console.log('vendor decoders copied');
