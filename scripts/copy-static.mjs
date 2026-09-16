// Leva para `out/` o que não passa pelo tsc: as páginas do seletor de tela, a offline, a faixa e o cursor do controle remoto.
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const src = fileURLToPath(new URL('../src/', import.meta.url));
const out = fileURLToPath(new URL('../out/', import.meta.url));
for (const file of [
	'picker.html',
	'picker.js',
	'offline.html',
	'offline.js',
	'remote-control/overlay.html',
	'remote-control/overlay.js',
	'remote-control/cursor-overlay.html',
	'remote-control/cursor-overlay.js'
]) {
	mkdirSync(dirname(`${out}${file}`), { recursive: true });
	copyFileSync(`${src}${file}`, `${out}${file}`);
}
