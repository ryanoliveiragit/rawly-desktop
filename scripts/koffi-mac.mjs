// O koffi (entrada nativa do controle remoto) publica o binário de cada sistema e arquitetura num
// pacote opcional, e o npm só instala o da máquina. O build do Mac sai para arm64 e x64 na mesma
// máquina: este script instala os dois (sem mexer no package.json nem no lock) antes do
// electron-builder. Fora do Mac não faz nada.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'darwin') {
	console.log('koffi-mac: só precisa rodar no Mac');
	process.exit(0);
}

const root = fileURLToPath(new URL('..', import.meta.url));
const { version } = JSON.parse(readFileSync(`${root}node_modules/koffi/package.json`, 'utf8'));
execFileSync(
	'npm',
	[
		'install',
		'--no-save',
		'--force',
		'--ignore-scripts',
		`@koromix/koffi-darwin-arm64@${version}`,
		`@koromix/koffi-darwin-x64@${version}`
	],
	{ cwd: root, stdio: 'inherit' }
);
