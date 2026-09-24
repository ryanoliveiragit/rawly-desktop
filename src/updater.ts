import { dialog, shell, type BrowserWindow } from 'electron';
import { autoUpdater } from 'electron-updater';
import { versaoEmUso } from './bundle-store';
import { procurarPacoteLeve } from './hot-update';
import { startMacUpdater } from './mac-updater';

/**
 * A atualização do app, em dois caminhos — e o leve vem primeiro.
 *
 * 1. PACOTE LEVE (`hot-update.ts`): alguns megabytes com o nosso código,
 *    gravados na pasta da pessoa. Sem instalador, sem senha, sem reinstalar
 *    nada; a troca acontece na abertura seguinte. É o que cobre quase toda
 *    versão nova.
 * 2. INSTALADOR COMPLETO (`electron-updater`, os `latest*.yml` em
 *    `/downloads/desktop/`): só quando o Electron ou um binário nativo mudam,
 *    e o pacote leve se recusa a servir. No Mac, sem a assinatura da Apple,
 *    quem baixa e troca é o `mac-updater.ts`.
 *
 * Nada disso acontece em silêncio total: o menu tem "Procurar atualizações",
 * que diz o que encontrou, e quando a instalação automática não é possível o
 * app abre a página de download em vez de falhar calado — era assim que uma
 * atualização quebrada virava "tenho que baixar o instalador de novo".
 */
const SEIS_HORAS = 6 * 60 * 60 * 1000;
/** O pacote leve é barato de procurar, então pode ser mais de perto. */
const MEIA_HORA = 30 * 60 * 1000;

interface Opcoes {
	enabled: boolean;
	getWindow: () => BrowserWindow | null;
	appUrl: URL;
}

let opcoes: Opcoes | null = null;
/** A versão já oferecida: ninguém merece a mesma pergunta a cada meia hora. */
let jaPerguntou: string | null = null;
let procurando = false;

export function startUpdater(opts: Opcoes): void {
	opcoes = opts;
	if (!opts.enabled) return;

	autoUpdater.autoDownload = process.platform !== 'darwin';
	autoUpdater.autoInstallOnAppQuit = process.platform !== 'darwin';
	autoUpdater.logger = {
		info: (message: unknown) => console.log('[rawly/atualização]', message),
		warn: (message: unknown) => console.warn('[rawly/atualização]', message),
		error: (message: unknown) => console.warn('[rawly/atualização]', message),
		debug: () => {}
	};
	autoUpdater.on('error', (err) => {
		console.warn('[rawly/atualização] sem atualização:', err instanceof Error ? err.message : err);
	});
	if (process.platform === 'darwin') {
		startMacUpdater({ getWindow: opts.getWindow });
	} else {
		autoUpdater.on('update-downloaded', (info) => {
			void ofereceReinicio(info.version, 'instalador');
		});
	}

	setTimeout(() => void procurar(false), 10_000);
	setInterval(() => void procurar(false), MEIA_HORA);
	setInterval(() => void procurarInstalador(), SEIS_HORAS);
}

/**
 * Procura agora. `avisarSemNovidade` é o que diferencia o pedido da pessoa
 * (pelo menu, que sempre responde alguma coisa) da checagem de fundo, que só
 * fala quando tem o que dizer.
 */
export async function procurar(avisarSemNovidade: boolean): Promise<void> {
	if (!opcoes?.enabled) {
		if (avisarSemNovidade) await aviso('Atualização', 'Neste modo o app não se atualiza sozinho.');
		return;
	}
	if (procurando) return;
	procurando = true;
	try {
		const achado = await procurarPacoteLeve(opcoes.appUrl);
		if (achado.tipo === 'baixada') {
			await ofereceReinicio(achado.versao, 'pacote');
			return;
		}
		if (achado.tipo === 'precisa-instalador') {
			// A versão nova mexeu no que vem embaixo do nosso código: só o
			// instalador completo resolve.
			await procurarInstalador();
			return;
		}
		if (avisarSemNovidade) {
			await aviso(
				'Atualização',
				achado.tipo === 'em-dia'
					? `Você está na versão ${versaoEmUso()}, que é a mais nova.`
					: 'Não deu para falar com o servidor de atualização agora. Tente de novo daqui a pouco.'
			);
		}
	} finally {
		procurando = false;
	}
}

async function procurarInstalador(): Promise<void> {
	if (!opcoes?.enabled || process.platform === 'darwin') return;
	try {
		await autoUpdater.checkForUpdates();
	} catch (err) {
		console.warn('[rawly/atualização] falha ao checar:', err instanceof Error ? err.message : err);
	}
}

/**
 * A pergunta, com a diferença que importa dita na cara: o pacote leve reinicia
 * em segundos; o instalador completo é outra história (no Linux, pede a senha
 * do computador).
 */
async function ofereceReinicio(versao: string, origem: 'pacote' | 'instalador'): Promise<void> {
	if (jaPerguntou === `${origem}:${versao}`) return;
	jaPerguntou = `${origem}:${versao}`;
	const win = opcoes?.getWindow() ?? null;
	const opcoesDoAviso: Electron.MessageBoxOptions = {
		type: 'info',
		title: 'Nova versão pronta',
		message: `A versão ${versao} do Rawly está pronta.`,
		detail:
			origem === 'pacote'
				? 'Ela já foi baixada. Reiniciar leva um instante, e nada é instalado: se preferir, ela entra sozinha da próxima vez que você abrir o app.'
				: 'Reinicie agora para usar, ou deixe para a próxima vez que abrir o app.',
		buttons: ['Reiniciar agora', 'Depois'],
		defaultId: 0,
		cancelId: 1,
		noLink: true
	};
	const { response } =
		win && !win.isDestroyed()
			? await dialog.showMessageBox(win, opcoesDoAviso)
			: await dialog.showMessageBox(opcoesDoAviso);
	if (response !== 0) return;
	if (origem === 'pacote') {
		// O código novo já está no disco: abrir de novo é tudo o que falta.
		const { app } = await import('electron');
		app.relaunch();
		app.quit();
		return;
	}
	try {
		autoUpdater.quitAndInstall();
	} catch (err) {
		// Linux sem pkexec, permissão negada, pacote travado: em vez de sumir com
		// o erro no log, mandamos a pessoa para o download, que sempre funciona.
		console.warn('[rawly/atualização] não deu para instalar:', err);
		await abrirPaginaDeDownload();
	}
}

async function abrirPaginaDeDownload(): Promise<void> {
	if (!opcoes) return;
	await aviso(
		'Atualização',
		'Não deu para instalar a versão nova sozinho. Vou abrir a página de download para você pegar o instalador.'
	);
	await shell.openExternal(new URL('/baixar', opcoes.appUrl).toString());
}

async function aviso(title: string, message: string): Promise<void> {
	const win = opcoes?.getWindow() ?? null;
	const opcoesDoAviso: Electron.MessageBoxOptions = { type: 'info', title, message, buttons: ['Ok'] };
	if (win && !win.isDestroyed()) await dialog.showMessageBox(win, opcoesDoAviso);
	else await dialog.showMessageBox(opcoesDoAviso);
}
