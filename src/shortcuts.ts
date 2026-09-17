/**
 * Atalhos globais da casca (pedido em 16/09/2026): Ctrl+Shift+M, ou ⌘⇧M no Mac,
 * liga e desliga o microfone da chamada mesmo com o Rawly atrás de outra janela,
 * como no Discord. O site pede o atalho só enquanto está numa chamada
 * (`setMute(true)`) e solta ao sair, para não roubar a combinação de outros apps
 * o tempo todo. A casca só avisa que foi apertado; quem liga e desliga é o site.
 *
 * Uma página por vez: a última que pediu fica com o atalho; fechar, recarregar ou
 * navegar solta. No Wayland o registro passa pelo portal GlobalShortcuts (o
 * sistema pode perguntar ou recusar); recusado, vale o atalho da página, com a
 * janela em foco.
 */
import { app, globalShortcut, ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron';
import { isAppUrl } from './config';

export const MUTE_SHORTCUT = 'CommandOrControl+Shift+M';

export function installShortcuts(options: { appUrl: URL }): void {
	let owner: WebContents | null = null;
	let detach: (() => void) | null = null;

	const release = () => {
		detach?.();
		detach = null;
		owner = null;
		if (globalShortcut.isRegistered(MUTE_SHORTCUT)) globalShortcut.unregister(MUTE_SHORTCUT);
	};

	const fromApp = (event: IpcMainInvokeEvent) => isAppUrl(event.senderFrame?.url ?? '', options.appUrl);

	ipcMain.handle('shortcut:mute', (event, enabled: unknown): boolean => {
		if (!fromApp(event)) return false;
		const sender = event.sender;
		if (enabled !== true) {
			if (owner && owner.id === sender.id) release();
			return false;
		}
		release();
		let registered = false;
		try {
			registered = globalShortcut.register(MUTE_SHORTCUT, () => {
				if (owner && !owner.isDestroyed()) owner.send('shortcut:mute-pressed');
			});
		} catch (error) {
			console.warn('[rawly] atalho do microfone: registro falhou', error);
		}
		if (!registered) {
			console.warn(`[rawly] atalho do microfone: o sistema não deixou registrar ${MUTE_SHORTCUT}`);
			return false;
		}
		owner = sender;
		const lost = () => {
			if (owner === sender) release();
		};
		sender.on('destroyed', lost);
		sender.on('did-navigate', lost);
		sender.on('render-process-gone', lost);
		detach = () => {
			if (sender.isDestroyed()) return;
			sender.removeListener('destroyed', lost);
			sender.removeListener('did-navigate', lost);
			sender.removeListener('render-process-gone', lost);
		};
		return true;
	});

	app.on('will-quit', () => release());
}
