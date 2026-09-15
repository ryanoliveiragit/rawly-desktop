import { app, screen, type BrowserWindow, type Rectangle } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Tamanho e posição da janela lembrados entre aberturas, em
 * `<userData>/window-state.json`. Se o monitor sumiu (a janela ficaria fora
 * da tela), volta ao tamanho padrão centralizado.
 */
export interface WindowState {
	bounds: Rectangle | null;
	maximized: boolean;
}

const DEFAULT: WindowState = { bounds: null, maximized: false };
const MIN_WIDTH = 960;
const MIN_HEIGHT = 640;

function stateFile(): string {
	return path.join(app.getPath('userData'), 'window-state.json');
}

export function readWindowState(): WindowState {
	try {
		const parsed = JSON.parse(fs.readFileSync(stateFile(), 'utf8')) as Partial<WindowState>;
		const bounds = parsed.bounds;
		if (
			bounds &&
			[bounds.x, bounds.y, bounds.width, bounds.height].every((n) => Number.isFinite(n)) &&
			bounds.width >= MIN_WIDTH &&
			bounds.height >= MIN_HEIGHT &&
			fitsSomeDisplay(bounds)
		) {
			return { bounds, maximized: Boolean(parsed.maximized) };
		}
		return { bounds: null, maximized: Boolean(parsed.maximized) };
	} catch {
		return DEFAULT;
	}
}

/** Pelo menos metade da janela precisa estar em algum monitor. */
function fitsSomeDisplay(bounds: Rectangle): boolean {
	return screen.getAllDisplays().some((display) => {
		const area = display.workArea;
		const overlapX =
			Math.min(bounds.x + bounds.width, area.x + area.width) - Math.max(bounds.x, area.x);
		const overlapY =
			Math.min(bounds.y + bounds.height, area.y + area.height) - Math.max(bounds.y, area.y);
		return overlapX >= bounds.width / 2 && overlapY >= bounds.height / 2;
	});
}

/** Grava o estado a cada mudança (com folga de 400ms) e no fechamento. */
export function trackWindowState(win: BrowserWindow): void {
	let timer: NodeJS.Timeout | null = null;
	const save = () => {
		if (win.isDestroyed()) return;
		const state: WindowState = {
			bounds: win.isMaximized() || win.isFullScreen() ? win.getNormalBounds() : win.getBounds(),
			maximized: win.isMaximized()
		};
		try {
			fs.mkdirSync(path.dirname(stateFile()), { recursive: true });
			fs.writeFileSync(stateFile(), JSON.stringify(state));
		} catch (err) {
			console.warn('[rawly] não deu para guardar o estado da janela', err);
		}
	};
	const later = () => {
		if (timer) clearTimeout(timer);
		timer = setTimeout(save, 400);
	};
	win.on('resize', later);
	win.on('move', later);
	win.on('maximize', later);
	win.on('unmaximize', later);
	win.on('close', () => {
		if (timer) clearTimeout(timer);
		save();
	});
}

export const DEFAULT_SIZE = {
	width: 1280,
	height: 820,
	minWidth: MIN_WIDTH,
	minHeight: MIN_HEIGHT
};
