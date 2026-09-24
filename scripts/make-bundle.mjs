// O pacote leve: `out/` inteiro dentro de um `.asar`, mais o manifesto que o
// app lê para saber se vale baixar.
//
//   npm run bundle           (depois de `npm run compile`)
//
// Sai em `dist/bundle/`: o `.asar` com o número da versão no nome (para nunca
// servir um arquivo velho por cache) e o `bundle-latest.json`, que é o que o
// app procura. A CI sobe os dois para o R2, o `.asar` primeiro — assim quem
// checar no meio do caminho não encontra um manifesto apontando para um
// arquivo que ainda não existe.
//
// Por que `.asar` e não um zip: o Electron lê `.asar` como se fosse pasta, sem
// descompactar nada, então o app carrega o código direto do arquivo baixado.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import asar from '@electron/asar';

const raiz = fileURLToPath(new URL('../', import.meta.url));
const pacote = JSON.parse(readFileSync(`${raiz}package.json`, 'utf8'));
const info = JSON.parse(readFileSync(`${raiz}out/build-info.json`, 'utf8'));

if (info.versao !== pacote.version) {
	throw new Error(
		`out/build-info.json está na ${info.versao} e o package.json na ${pacote.version}: rode "npm run compile" antes.`
	);
}

const saida = `${raiz}dist/bundle`;
rmSync(saida, { recursive: true, force: true });
mkdirSync(saida, { recursive: true });

const nome = `Rawly-bundle-${pacote.version}.asar`;
const destino = `${saida}/${nome}`;
await asar.createPackage(`${raiz}out`, destino);

const dados = readFileSync(destino);
const manifesto = {
	versao: pacote.version,
	arquivo: nome,
	sha512: createHash('sha512').update(dados).digest('base64'),
	tamanho: statSync(destino).size,
	depsHash: info.depsHash
};
writeFileSync(`${saida}/bundle-latest.json`, `${JSON.stringify(manifesto, null, '\t')}\n`);

const mb = (manifesto.tamanho / (1024 * 1024)).toFixed(1).replace('.', ',');
console.log(`pacote leve ${pacote.version}: ${nome} (${mb} MB), impressão ${manifesto.depsHash}`);
