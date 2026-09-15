// Leva para `out/` o que não passa pelo tsc: as páginas do seletor de tela e a offline.
import { copyFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const src = fileURLToPath(new URL('../src/', import.meta.url));
const out = fileURLToPath(new URL('../out/', import.meta.url));
mkdirSync(out, { recursive: true });
for (const file of ['picker.html', 'picker.js', 'offline.html', 'offline.js']) {
	copyFileSync(`${src}${file}`, `${out}${file}`);
}
