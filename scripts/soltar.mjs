// Solta uma versão nova do app — um comando só.
//
//   npm run soltar -- "o terminal volta com o que estava escrito"
//   npm run soltar -- --minor "ambiente do projeto em container"
//
// Ele sobe o número da versão, commita, cria a tag `vX.Y.Z` e empurra. A CI
// (.github/workflows/build.yml) faz o resto: gera o pacote leve, gera os
// instaladores dos três sistemas e sobe tudo para o R2.
//
// Existia por isto: a versão do `package.json` e a tag tinham de bater
// exatamente, senão a CI parava — e eram cinco passos à mão para cada
// correção. O erro mais comum era esquecer um deles.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const raiz = fileURLToPath(new URL('../', import.meta.url));
const git = (...args) => execFileSync('git', args, { cwd: raiz, encoding: 'utf8' }).trim();

const argumentos = process.argv.slice(2);
const tipo = argumentos.includes('--minor') ? 'minor' : argumentos.includes('--major') ? 'major' : 'patch';
const mensagem = argumentos.filter((a) => !a.startsWith('--')).join(' ').trim();

if (!mensagem) {
	console.error('Diga o que mudou:  npm run soltar -- "o que mudou nesta versão"');
	process.exit(1);
}
if (git('status', '--porcelain')) {
	console.error('Há mudança sem commit. Commite (ou guarde) antes de soltar a versão.');
	process.exit(1);
}

const caminho = `${raiz}package.json`;
const pacote = JSON.parse(readFileSync(caminho, 'utf8'));
const [maior, menor, correcao] = pacote.version.split('.').map(Number);
const nova =
	tipo === 'major'
		? `${maior + 1}.0.0`
		: tipo === 'minor'
			? `${maior}.${menor + 1}.0`
			: `${maior}.${menor}.${correcao + 1}`;

if (git('tag', '--list', `v${nova}`)) {
	console.error(`a tag v${nova} já existe: apague-a ou suba outra versão.`);
	process.exit(1);
}

// O `package.json` é escrito com tabulação e uma linha em branco no fim, como
// o resto do repositório: reescrever com outro formato sujaria todo diff.
pacote.version = nova;
writeFileSync(caminho, `${JSON.stringify(pacote, null, '\t')}\n`);

git('add', 'package.json');
git('commit', '-m', `${nova}: ${mensagem}`);
git('tag', '-a', `v${nova}`, '-m', `Rawly desktop v${nova}`);
git('push', 'origin', 'HEAD');
git('push', 'origin', `v${nova}`);

const remoto = git('remote', 'get-url', 'origin').replace(/\.git$/, '');
console.log(`\nv${nova} no ar em instantes.`);
console.log(`  acompanhe: ${remoto}/actions`);
console.log('  quem já tem o app recebe o pacote leve sozinho, sem reinstalar nada.');
