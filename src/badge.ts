import { app, nativeImage, type BrowserWindow } from 'electron';
import { resourcePath } from './paths';

/**
 * O número de não lidas que o site manda por `window.rawlyDesktop.setBadge`.
 * No Mac vai para a dock e no Linux para o lançador (onde ele suporta); no
 * Windows vira um selo sobre o ícone da barra de tarefas (`build/badge/N.png`,
 * 10 = "9+") e a janela pisca enquanto não tem foco.
 */
export function applyBadge(win: BrowserWindow | null, count: number): void {
	const n = Math.max(0, Math.floor(Number.isFinite(count) ? count : 0));
	if (process.platform === 'win32') {
		if (!win || win.isDestroyed()) return;
		if (n === 0) {
			win.setOverlayIcon(null, '');
			win.flashFrame(false);
			return;
		}
		const image = nativeImage.createFromPath(resourcePath(`badge/${Math.min(n, 10)}.png`));
		win.setOverlayIcon(image.isEmpty() ? null : image, `${n} não lidas`);
		if (!win.isFocused()) win.flashFrame(true);
		return;
	}
	app.setBadgeCount(n);
	if (process.platform === 'linux' && win && !win.isDestroyed()) {
		if (n > 0 && !win.isFocused()) win.flashFrame(true);
		if (n === 0) win.flashFrame(false);
	}
}
