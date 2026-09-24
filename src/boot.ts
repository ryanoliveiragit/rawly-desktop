/**
 * A primeira coisa que roda no app: decide QUAL código abrir.
 *
 * O instalador traz uma cópia do app em `out/`. A atualização leve
 * (`hot-update.ts`) pode ter deixado uma mais nova num `.asar` dentro da pasta
 * da pessoa. Este arquivo escolhe entre as duas e carrega — é só isso, e é de
 * propósito: ele é a única parte que NUNCA é substituída, então precisa ser
 * pequena o bastante para não ter o que quebrar.
 *
 * `--sem-bundle` abre o que veio no instalador, ignorando o pacote baixado. É
 * a saída de emergência, para o caso de uma versão ruim passar pelas travas.
 */
import { app } from 'electron';
import Module from 'node:module';
import path from 'node:path';
import { escolherBundle } from './bundle-store';

function carregar(): void {
	if (!app.isPackaged || process.argv.includes('--sem-bundle')) {
		require('./main');
		return;
	}

	let pacote: string | null = null;
	try {
		pacote = escolherBundle();
	} catch (erro) {
		console.warn('[rawly/atualização] não deu para ler os pacotes baixados:', erro);
	}

	if (!pacote) {
		require('./main');
		return;
	}

	// O pacote leve traz só o NOSSO código; koffi, node-pty, dbus e o
	// electron-updater continuam sendo os que o instalador trouxe. O `require`
	// deles sai da pasta do pacote e não acha nada, então ensinamos ao Node
	// mais um lugar onde procurar.
	//
	// Pelo `NODE_PATH` de propósito: o `Module.globalPaths` moderno é uma cópia
	// congelada, e empurrar nele não muda nada (foi o que aconteceu na primeira
	// tentativa — "Cannot find module 'electron-updater'"). A variável é
	// apagada logo depois de o Node lê-la, porque ela é herdada por todo
	// processo filho, e o terminal do app abre shells: um `node` rodando no
	// projeto de alguém não pode enxergar as bibliotecas do Rawly.
	const doInstalador = path.join(process.resourcesPath, 'app.asar', 'node_modules');
	const anterior = process.env.NODE_PATH;
	process.env.NODE_PATH = anterior ? `${doInstalador}${path.delimiter}${anterior}` : doInstalador;
	(Module as unknown as { _initPaths: () => void })._initPaths();
	if (anterior === undefined) delete process.env.NODE_PATH;
	else process.env.NODE_PATH = anterior;

	try {
		require(path.join(pacote, 'main.js'));
		console.log('[rawly/atualização] abrindo pelo pacote', path.basename(pacote));
	} catch (erro) {
		// A contagem de tentativas já subiu; mesmo assim, não deixamos a pessoa
		// com um app que não abre por causa disto: cai para o do instalador agora.
		console.warn('[rawly/atualização] o pacote baixado não carregou, usando o do instalador:', erro);
		require('./main');
	}
}

carregar();
