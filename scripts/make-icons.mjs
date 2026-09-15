// Deriva `build/icon.icns` (Mac) e `build/icon.ico` (Windows) do `build/icon.png`.
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const png2icons = require('png2icons');
const build = fileURLToPath(new URL('../build/', import.meta.url));
const input = readFileSync(`${build}icon.png`);

const icns = png2icons.createICNS(input, png2icons.BICUBIC2, 0);
const ico = png2icons.createICO(input, png2icons.BICUBIC2, 0, false, true);
if (!icns || !ico) throw new Error('png2icons não gerou os ícones');
writeFileSync(`${build}icon.icns`, icns);
writeFileSync(`${build}icon.ico`, ico);
console.log(`icon.icns (${icns.length} bytes) e icon.ico (${ico.length} bytes) em ${build}`);
