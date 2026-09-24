/**
 * A atualização leve: baixa só o código do app, alguns megabytes, e deixa
 * pronto para a próxima abertura.
 *
 * O caminho completo (`updater.ts`, `electron-updater`) continua existindo e
 * continua sendo o único que resolve tudo — mas ele baixa o app inteiro e, no
 * Linux, pede a senha do computador. Este aqui cobre o caso comum: mudou o
 * nosso código, e só ele. Grava na pasta da pessoa, não pede senha nenhuma, e
 * a troca acontece sozinha quando o app abrir de novo.
 *
 * Quando o pacote pede mais do que o instalador desta máquina tem — outro
 * Electron, outro node-pty — o `depsHash` do manifesto não bate com o do
 * instalador e este módulo simplesmente não baixa: aí é o caminho completo que
 * tem de rodar. É uma conta automática, para ninguém precisar lembrar.
 */
import { app } from 'electron';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
	compararVersao,
	gravarEstado,
	lerEstado,
	pastaDosBundles,
	versaoEmUso
} from './bundle-store';

interface Manifesto {
	versao: string;
	arquivo: string;
	sha512: string;
	tamanho: number;
	depsHash: string;
}

export type ResultadoDaBusca =
	| { tipo: 'em-dia' }
	| { tipo: 'baixada'; versao: string }
	| { tipo: 'precisa-instalador'; versao: string }
	| { tipo: 'sem-resposta' };

/** O `build-info.json` do INSTALADOR, não o do pacote que estiver rodando. */
function depsDoInstalador(): string | null {
	const caminho = app.isPackaged
		? path.join(process.resourcesPath, 'app.asar', 'out', 'build-info.json')
		: path.join(__dirname, 'build-info.json');
	try {
		return (JSON.parse(fs.readFileSync(caminho, 'utf8')) as { depsHash?: string }).depsHash ?? null;
	} catch {
		return null;
	}
}

const sha512De = (dados: Buffer) => createHash('sha512').update(dados).digest('base64');

/**
 * Procura, baixa e guarda. Não troca nada agora: quem troca é a abertura
 * seguinte (`bundle-store.escolherBundle`).
 */
export async function procurarPacoteLeve(appUrl: URL): Promise<ResultadoDaBusca> {
	const base = new URL('/downloads/desktop/', appUrl);
	let manifesto: Manifesto;
	try {
		const resposta = await fetch(new URL('bundle-latest.json', base), {
			cache: 'no-store',
			signal: AbortSignal.timeout(20_000)
		});
		if (!resposta.ok) return { tipo: 'sem-resposta' };
		manifesto = (await resposta.json()) as Manifesto;
	} catch {
		// Sem rede, ou o site ainda não publica pacote leve nenhum.
		return { tipo: 'sem-resposta' };
	}
	if (!manifesto?.versao || !manifesto.arquivo || !manifesto.sha512) {
		return { tipo: 'sem-resposta' };
	}

	const estado = lerEstado();
	const jaTem = estado.proxima && compararVersao(estado.proxima.versao, manifesto.versao) >= 0;
	if (jaTem || compararVersao(manifesto.versao, versaoEmUso()) <= 0) return { tipo: 'em-dia' };

	// O pacote leve só troca o nosso código: se o que está embaixo dele mudou,
	// quem resolve é o instalador completo.
	const daMaquina = depsDoInstalador();
	if (daMaquina && manifesto.depsHash && manifesto.depsHash !== daMaquina) {
		return { tipo: 'precisa-instalador', versao: manifesto.versao };
	}

	let dados: Buffer;
	try {
		const resposta = await fetch(new URL(manifesto.arquivo, base), {
			cache: 'no-store',
			signal: AbortSignal.timeout(5 * 60_000)
		});
		if (!resposta.ok) return { tipo: 'sem-resposta' };
		dados = Buffer.from(await resposta.arrayBuffer());
	} catch {
		return { tipo: 'sem-resposta' };
	}

	// Conferir antes de gravar: um arquivo cortado no meio viraria um app que
	// não abre, e a trava de tentativas só o descobriria depois de duas.
	if (sha512De(dados) !== manifesto.sha512) {
		console.warn('[rawly/atualização] o pacote baixado não confere com o manifesto; descartado.');
		return { tipo: 'sem-resposta' };
	}

	const arquivo = `Rawly-bundle-${manifesto.versao}.asar`;
	try {
		fs.mkdirSync(pastaDosBundles(), { recursive: true });
		const destino = path.join(pastaDosBundles(), arquivo);
		const temporario = `${destino}.parcial`;
		fs.writeFileSync(temporario, dados);
		fs.renameSync(temporario, destino);
	} catch (erro) {
		console.warn('[rawly/atualização] não deu para guardar o pacote:', erro);
		return { tipo: 'sem-resposta' };
	}

	gravarEstado({ ...lerEstado(), proxima: { versao: manifesto.versao, arquivo } });
	console.log('[rawly/atualização] pacote', manifesto.versao, 'pronto para a próxima abertura.');
	return { tipo: 'baixada', versao: manifesto.versao };
}
