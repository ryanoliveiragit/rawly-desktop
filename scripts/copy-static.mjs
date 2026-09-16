// Leva para `out/` o que não passa pelo tsc: as páginas do seletor de tela, a offline, a faixa e o cursor do controle remoto.
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
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
	'remote-control/cursor-overlay-page.js'
]) {
	// Script de página com o mesmo nome de um módulo .ts sobrescreve o que o tsc compilou:
	// foi assim que o 0.4.0 carregou o script do cursor no processo principal e não abria.
	if (file.endsWith('.js') && existsSync(`${src}${file.replace(/\.js$/, '.ts')}`)) {
		throw new Error(`${file} tem o mesmo nome de ${file.replace(/\.js$/, '.ts')}: renomeie o script da página.`);
	}
	mkdirSync(dirname(`${out}${file}`), { recursive: true });
	copyFileSync(`${src}${file}`, `${out}${file}`);
}
