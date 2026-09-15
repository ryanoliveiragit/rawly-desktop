import { dialog, type BrowserWindow } from 'electron';
import { autoUpdater } from 'electron-updater';

/**
 * Atualização automática pelo próprio site: `latest.yml` (Windows),
 * `latest-mac.yml` e `latest-linux.yml` em
 * `https://rawly-ten.vercel.app/downloads/desktop/` (o `publish` de
 * `electron-builder.yml`, gravado em `app-update.yml` no pacote). O site
 * redireciona cada arquivo para uma URL assinada do R2, e o atualizador segue
 * o redirecionamento. Checa ao abrir e a cada 6 h, baixa em silêncio e só
 * então pergunta se reinicia agora. Se o site ainda não servir os arquivos ou
 * a rede falhar, só registra no log.
 *
 * No Mac só funciona com o app assinado; no Linux, só no AppImage.
 */
const SIX_HOURS = 6 * 60 * 60 * 1000;

export function startUpdater(opts: { enabled: boolean; getWindow: () => BrowserWindow | null }): void {
	if (!opts.enabled) return;
	autoUpdater.autoDownload = true;
	autoUpdater.autoInstallOnAppQuit = true;
	autoUpdater.logger = {
		info: (message: unknown) => console.log('[rawly/atualização]', message),
		warn: (message: unknown) => console.warn('[rawly/atualização]', message),
		error: (message: unknown) => console.warn('[rawly/atualização]', message),
		debug: () => {}
	};
	autoUpdater.on('error', (err) => {
		console.warn('[rawly/atualização] sem atualização:', err instanceof Error ? err.message : err);
	});
	autoUpdater.on('update-downloaded', (info) => {
		void askToRestart(info.version, opts.getWindow());
	});

	const check = () => {
		autoUpdater.checkForUpdates().catch((err: unknown) => {
			console.warn('[rawly/atualização] falha ao checar:', err instanceof Error ? err.message : err);
		});
	};
	setTimeout(check, 10_000);
	setInterval(check, SIX_HOURS);
}

async function askToRestart(version: string, win: BrowserWindow | null): Promise<void> {
	const options: Electron.MessageBoxOptions = {
		type: 'info',
		title: 'Nova versão pronta',
		message: `A versão ${version} do Rawly está pronta.`,
		detail: 'Reinicie agora para usar, ou deixe para a próxima vez que abrir o app.',
		buttons: ['Reiniciar agora', 'Depois'],
		defaultId: 0,
		cancelId: 1,
		noLink: true
	};
	const { response } =
		win && !win.isDestroyed()
			? await dialog.showMessageBox(win, options)
			: await dialog.showMessageBox(options);
	if (response === 0) autoUpdater.quitAndInstall();
}
