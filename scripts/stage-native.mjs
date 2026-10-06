// Copies the freshly built native audio module to native/prebuilt/<platform>-<arch>/, where the desktop app
// looks for the one matching the computer it runs on (an app download for one architecture never loads a module
// built for another). Usage: node scripts/stage-native.mjs [arch]   (default: this machine's architecture)
import fs from 'node:fs';
import path from 'node:path';

const arch = process.argv[2] ?? process.arch;
const src = path.join('native', 'build', 'Release', 'cal_audio.node');
if (!fs.existsSync(src)) {
  console.error(`No native module at ${src}: run npm run build:native first`);
  process.exit(1);
}
const dir = path.join('native', 'prebuilt', `${process.platform}-${arch}`);
fs.mkdirSync(dir, { recursive: true });
fs.copyFileSync(src, path.join(dir, 'cal_audio.node'));
console.log(`Native audio module for ${process.platform}-${arch} → ${dir}`);
