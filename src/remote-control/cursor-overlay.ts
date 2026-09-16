/**
 * O cursor de quem controla na tela de quem compartilha (pedido em 16/09/2026): a seta laranja
 * com a foto da pessoa ao lado, numa janela pequena, transparente e que deixa o clique passar,
 * sempre por cima, que anda com o mouse de quem controla. O cursor do sistema continua sendo o
 * de quem compartilha (`native-backend.ts`).
 *
 * Fica fora da captura da tela no Windows e no Mac (`setContentProtection`): quem assiste já vê
 * o cursor laranja desenhado pelo site, sem atraso de vídeo. No Linux a captura inclui a janela.
 * No Wayland não há janela: o compositor não deixa posicionar nem manter por cima.
 */
import { BrowserWindow, type Display } from 'electron';
import { outPath } from '../paths';
import { toDipPoint } from './geometry';

/** A seta e a foto cabem aqui; a ponta da seta fica em ({@link TIP_X}, {@link TIP_Y}). */
const WIDTH = 64;
const HEIGHT = 56;
const TIP_X = 3;
const TIP_Y = 3;

export class CursorOverlay {
	private readonly window: BrowserWindow;
	private shown = false;
	private ready = false;
	private pending: { x: number; y: number } | null = null;

	constructor(
		private readonly display: Display,
		name: string,
		photo: string | null
	) {
		// Linux: sem compositor a transparência vira fundo preto; ainda assim é uma caixa pequena.
		this.window = new BrowserWindow({
			width: WIDTH,
			height: HEIGHT,
			x: display.bounds.x,
			y: display.bounds.y,
			title: 'Cursor de quem controla',
			frame: false,
			transparent: true,
			backgroundColor: '#00000000',
			hasShadow: false,
			resizable: false,
			movable: false,
			minimizable: false,
			maximizable: false,
			fullscreenable: false,
			skipTaskbar: true,
			alwaysOnTop: true,
			focusable: false,
			show: false,
			...(process.platform === 'darwin' ? { type: 'panel' } : {}),
			webPreferences: {
				preload: outPath('remote-control/cursor-overlay-preload.js'),
				contextIsolation: true,
				sandbox: true,
				nodeIntegration: false
			}
		});
		this.window.setIgnoreMouseEvents(true);
		this.window.setAlwaysOnTop(true, 'screen-saver');
		this.window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
		if (process.platform === 'win32' || process.platform === 'darwin') this.window.setContentProtection(true);
		this.window.webContents.once('did-finish-load', () => {
			if (this.window.isDestroyed()) return;
			this.window.webContents.send('cursor-overlay:person', { name, photo });
			this.ready = true;
			if (this.pending) this.move(this.pending.x, this.pending.y);
		});
		void this.window.loadFile(outPath('remote-control/cursor-overlay.html'));
	}

	/** A posição 0–1 de quem controla na tela controlada. */
	move(x: number, y: number): void {
		if (this.window.isDestroyed()) return;
		if (!this.ready) {
			this.pending = { x, y };
			return;
		}
		const point = toDipPoint(x, y, this.display.bounds);
		this.window.setPosition(Math.round(point.x) - TIP_X, Math.round(point.y) - TIP_Y, false);
		if (!this.shown) {
			this.shown = true;
			this.window.showInactive();
		}
	}

	close(): void {
		if (!this.window.isDestroyed()) this.window.close();
	}
}
