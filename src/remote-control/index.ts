/**
 * Controle remoto da tela (docs/controle-remoto.md): quem assiste a uma tela compartilhada na
 * voz da Central pede, quem compartilha aceita no site, e o site chama esta ponte para a casca
 * injetar mouse e teclado no sistema.
 *
 * Travas de segurança, todas aqui no processo principal:
 * - só a origem do app fala com a ponte, e só a página que começou a sessão manda entrada;
 * - entrada sem sessão ativa é descartada, e todo evento passa pela validação do `protocol.ts`;
 * - enquanto dura, uma faixa sempre por cima mostra quem controla, com "Parar";
 * - um atalho global para na hora, mesmo com o foco em outro app ({@link STOP_SHORTCUT});
 * - fechar, recarregar ou perder a janela do site para; erro na entrada para;
 * - ao parar, tudo que estava apertado é solto.
 */
import {
	app,
	BrowserWindow,
	dialog,
	globalShortcut,
	ipcMain,
	screen,
	shell,
	systemPreferences,
	type Display,
	type IpcMainEvent,
	type IpcMainInvokeEvent,
	type MessageBoxOptions,
	type WebContents
} from 'electron';
import { isAppUrl } from '../config';
import { outPath } from '../paths';
import { ControlError, InputQueue, type InputBackend } from './backend';
import { fallbackPhysicalOrigin, isWindowSource, pickDisplay } from './geometry';
import { openNativeBackend, probeNative, type ScreenMapping } from './native-backend';
import { PortalBackend, probePortal } from './portal-backend';
import {
	parseRemoteInput,
	parseStartOptions,
	type RemoteControlCapabilities,
	type RemoteControlSharedSource,
	type StartResult,
	type StopReason
} from './protocol';
import { SharedSourceRegistry, type CapturedSource } from './shared-sources';

/**
 * Atalho global para parar: Ctrl+Alt+Shift+P (⌘⌥⇧P no Mac). Não é atalho do Windows, do macOS
 * nem do GNOME, e só fica registrado enquanto alguém controla a tela.
 */
export const STOP_SHORTCUT = 'CommandOrControl+Alt+Shift+P';

/** O mesmo teste do `screen-picker.ts`. */
const wayland =
	process.platform === 'linux' &&
	(process.env.XDG_SESSION_TYPE === 'wayland' || Boolean(process.env.WAYLAND_DISPLAY));

const OVERLAY_WIDTH = 520;
const OVERLAY_HEIGHT = 48;
/** Parar não pode travar esperando o sistema (um D-Bus parado, por exemplo). */
const CLOSE_TIMEOUT_MS = 3000;

const MAC_PERMISSION_REASON =
	'Falta liberar o Rawly em Ajustes do Sistema › Privacidade e Segurança › Acessibilidade.';

type Platform = RemoteControlCapabilities['platform'];

interface Session {
	owner: WebContents;
	backend: InputBackend;
	queue: InputQueue;
	overlay: BrowserWindow | null;
	cleanup: Array<() => void>;
}

export interface RemoteControl {
	/** O seletor de "Compartilhar tela" avisa cada fonte escolhida. */
	recordSharedSource(source: CapturedSource): void;
}

function currentPlatform(): Platform | null {
	const platform = process.platform;
	return platform === 'win32' || platform === 'darwin' || platform === 'linux' ? platform : null;
}

function shortcutLabel(): string {
	return process.platform === 'darwin' ? '⌘⌥⇧P' : 'Ctrl+Alt+Shift+P';
}

function withTimeout(promise: Promise<void>, ms: number): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, ms);
		promise
			.catch((error) => console.warn('[rawly] controle remoto: falha ao encerrar', error))
			.finally(() => {
				clearTimeout(timer);
				resolve();
			});
	});
}

async function capabilities(): Promise<RemoteControlCapabilities> {
	const platform = currentPlatform();
	if (!platform) {
		return { available: false, platform: 'linux', backend: null, reason: 'O controle remoto não funciona neste sistema.' };
	}
	if (wayland) {
		const reason = await probePortal();
		return reason
			? { available: false, platform, backend: 'wayland-portal', reason }
			: { available: true, platform, backend: 'wayland-portal' };
	}
	const reason = probeNative(platform);
	if (reason) return { available: false, platform, backend: 'native', reason };
	if (platform === 'darwin' && !systemPreferences.isTrustedAccessibilityClient(false)) {
		return { available: false, platform, backend: 'native', reason: MAC_PERMISSION_REASON, needsPermission: true };
	}
	return { available: true, platform, backend: 'native' };
}

/** No Mac, explica a permissão de Acessibilidade e leva aos Ajustes se a pessoa quiser. */
async function askAccessibility(parent: BrowserWindow | null): Promise<void> {
	const options: MessageBoxOptions = {
		type: 'info',
		buttons: ['Abrir Ajustes', 'Agora não'],
		defaultId: 0,
		cancelId: 1,
		message: 'Permita que o Rawly controle este Mac',
		detail:
			'Para outra pessoa mexer no mouse e no teclado deste Mac pela chamada, o macOS pede a permissão de Acessibilidade. ' +
			'Em Ajustes do Sistema › Privacidade e Segurança › Acessibilidade, ligue o Rawly e aceite o pedido de controle de novo. ' +
			'Dá para desligar quando quiser, e cada pedido continua precisando da sua aprovação.'
	};
	const { response } = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options);
	if (response !== 0) return;
	// Põe o Rawly na lista de Acessibilidade (com o aviso do próprio macOS) e abre o painel.
	systemPreferences.isTrustedAccessibilityClient(true);
	void shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility');
}

function screenMapping(display: Display): ScreenMapping {
	const { bounds, scaleFactor } = display;
	let physicalOrigin = fallbackPhysicalOrigin(bounds, scaleFactor, process.platform === 'linux' ? display.nativeOrigin : null);
	if (process.platform === 'win32') {
		try {
			physicalOrigin = screen.dipToScreenPoint({ x: bounds.x, y: bounds.y });
		} catch (error) {
			console.warn('[rawly] controle remoto: dipToScreenPoint falhou', error);
		}
	}
	return { bounds, scaleFactor, physicalOrigin };
}

function openOverlay(name: string, display: Display | null, shortcut: string | null, onClosed: () => void): BrowserWindow {
	const area = (display ?? screen.getPrimaryDisplay()).workArea;
	const width = Math.min(OVERLAY_WIDTH, Math.max(320, area.width - 24));
	// Linux: janela transparente depende do compositor; a faixa sai retangular e opaca.
	const transparent = process.platform !== 'linux';
	const overlay = new BrowserWindow({
		width,
		height: OVERLAY_HEIGHT,
		x: Math.round(area.x + (area.width - width) / 2),
		y: area.y + 12,
		title: 'Controle remoto',
		frame: false,
		transparent,
		backgroundColor: transparent ? '#00000000' : '#1c1c20',
		resizable: false,
		minimizable: false,
		maximizable: false,
		fullscreenable: false,
		skipTaskbar: true,
		alwaysOnTop: true,
		// Sem foco: o teclado de quem controla continua indo para o app que estava na frente.
		focusable: false,
		acceptFirstMouse: true,
		show: false,
		...(process.platform === 'darwin' ? { type: 'panel' } : {}),
		webPreferences: {
			preload: outPath('remote-control/overlay-preload.js'),
			contextIsolation: true,
			sandbox: true,
			nodeIntegration: false
		}
	});
	overlay.setAlwaysOnTop(true, 'screen-saver');
	overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
	overlay.on('closed', onClosed);
	overlay.once('ready-to-show', () => overlay.showInactive());
	const query: Record<string, string> = { name };
	if (shortcut) query.shortcut = shortcut;
	if (!transparent) query.solid = '1';
	void overlay.loadFile(outPath('remote-control/overlay.html'), { query });
	return overlay;
}

export function installRemoteControl(options: { appUrl: URL }): RemoteControl {
	const sources = new SharedSourceRegistry();
	let session: Session | null = null;
	/** O `start()` em curso (no Wayland ele espera a pessoa responder o pedido do sistema). */
	let starting: { ownerId: number; cancelled: boolean } | null = null;

	const fromApp = (event: IpcMainEvent | IpcMainInvokeEvent) =>
		isAppUrl(event.senderFrame?.url ?? '', options.appUrl);

	async function end(reason: StopReason | null): Promise<void> {
		const current = session;
		if (!current) return;
		session = null;
		for (const undo of current.cleanup.splice(0)) {
			try {
				undo();
			} catch (error) {
				console.warn('[rawly] controle remoto: falha ao limpar', error);
			}
		}
		const overlay = current.overlay;
		current.overlay = null;
		if (overlay && !overlay.isDestroyed()) overlay.close();
		// O site sabe na hora; soltar as teclas e fechar o portal vem logo depois.
		if (reason && !current.owner.isDestroyed()) current.owner.send('control:stopped', reason);
		await withTimeout(current.queue.close(), CLOSE_TIMEOUT_MS);
		await withTimeout(current.backend.close(), CLOSE_TIMEOUT_MS);
	}

	async function openBackend(
		sourceId: string | null,
		parent: BrowserWindow | null
	): Promise<{ backend: InputBackend; display: Display | null }> {
		if (wayland) {
			// O portal escolhe a tela no próprio pedido do sistema.
			let opened: InputBackend | null = null;
			opened = await PortalBackend.open(() => {
				if (session && session.backend === opened) void end('user');
			});
			return { backend: opened, display: null };
		}
		if (isWindowSource(sourceId)) throw new ControlError('Só dá para controlar uma tela inteira, não uma janela.');
		if (process.platform === 'darwin' && !systemPreferences.isTrustedAccessibilityClient(false)) {
			await askAccessibility(parent);
			throw new ControlError(MAC_PERMISSION_REASON);
		}
		const shared: RemoteControlSharedSource | null = sourceId ? sources.find(sourceId) : sources.latestScreen();
		const picked = pickDisplay(
			screen.getAllDisplays(),
			{ displayId: shared?.displayId ?? null, sourceId: shared?.sourceId ?? sourceId },
			screen.getPrimaryDisplay().id
		);
		if (!picked) throw new ControlError('Não achei a tela compartilhada.');
		if (!picked.exact) console.warn('[rawly] controle remoto: tela compartilhada não identificada, usando a principal');
		return { backend: openNativeBackend(process.platform, screenMapping(picked.display)), display: picked.display };
	}

	function begin(owner: WebContents, controllerName: string, backend: InputBackend, display: Display | null): void {
		const cleanup: Array<() => void> = [];
		const current: Session = {
			owner,
			backend,
			overlay: null,
			cleanup,
			queue: new InputQueue(
				(event) => backend.apply(event),
				(error) => {
					console.warn('[rawly] controle remoto: erro ao aplicar entrada', error);
					if (session === current) void end('error');
				}
			)
		};
		session = current;

		// Fechar, recarregar ou perder a página que começou a sessão para o controle.
		const closed = () => {
			if (session === current) void end('closed');
		};
		owner.on('destroyed', closed);
		owner.on('render-process-gone', closed);
		owner.on('did-navigate', closed);
		cleanup.push(() => {
			if (owner.isDestroyed()) return;
			owner.removeListener('destroyed', closed);
			owner.removeListener('render-process-gone', closed);
			owner.removeListener('did-navigate', closed);
		});
		const win = BrowserWindow.fromWebContents(owner);
		if (win) {
			// No Mac fechar só esconde a janela; mesmo assim a pessoa saiu dela.
			win.on('close', closed);
			cleanup.push(() => {
				if (!win.isDestroyed()) win.removeListener('close', closed);
			});
		}

		let registered = false;
		try {
			registered = globalShortcut.register(STOP_SHORTCUT, () => {
				if (session === current) void end('shortcut');
			});
		} catch (error) {
			console.warn('[rawly] controle remoto: atalho global falhou', error);
		}
		if (registered) cleanup.push(() => globalShortcut.unregister(STOP_SHORTCUT));
		else console.warn(`[rawly] controle remoto: o atalho ${STOP_SHORTCUT} não foi registrado`);

		current.overlay = openOverlay(controllerName, display, registered ? shortcutLabel() : null, () => {
			if (session === current) void end('user');
		});
	}

	ipcMain.handle('control:capabilities', async (event): Promise<RemoteControlCapabilities> => {
		if (!fromApp(event)) {
			return { available: false, platform: currentPlatform() ?? 'linux', backend: null, reason: 'Origem não autorizada.' };
		}
		return capabilities();
	});

	ipcMain.handle('control:shared-sources', (event): RemoteControlSharedSource[] => (fromApp(event) ? sources.list() : []));

	ipcMain.handle('control:start', async (event, raw: unknown): Promise<StartResult> => {
		if (!fromApp(event)) return { ok: false, error: 'Origem não autorizada.' };
		if (starting) return { ok: false, error: 'Já tem um pedido de controle em andamento.' };
		const owner = event.sender;
		const attempt = { ownerId: owner.id, cancelled: false };
		starting = attempt;
		// O pedido do GNOME pode demorar: se a página recarregar ou o site desistir no meio, não começa.
		const abandon = () => {
			attempt.cancelled = true;
		};
		owner.once('did-navigate', abandon);
		try {
			const { controllerName, sourceId } = parseStartOptions(raw);
			await end(null);
			const { backend, display } = await openBackend(sourceId, BrowserWindow.fromWebContents(owner));
			if (owner.isDestroyed() || attempt.cancelled) {
				await withTimeout(backend.close(), CLOSE_TIMEOUT_MS);
				return { ok: false, error: 'O pedido de controle foi cancelado.' };
			}
			begin(owner, controllerName, backend, display);
			return { ok: true };
		} catch (error) {
			if (error instanceof ControlError) return { ok: false, error: error.message };
			console.warn('[rawly] controle remoto: não começou', error);
			return { ok: false, error: 'Não deu para começar o controle remoto.' };
		} finally {
			if (!owner.isDestroyed()) owner.removeListener('did-navigate', abandon);
			starting = null;
		}
	});

	ipcMain.on('control:input', (event, raw: unknown) => {
		const current = session;
		if (!current || event.sender.id !== current.owner.id || !fromApp(event)) return;
		const input = parseRemoteInput(raw);
		if (input) current.queue.push(input);
	});

	ipcMain.handle('control:stop', async (event) => {
		if (!fromApp(event)) return;
		if (starting && starting.ownerId === event.sender.id) starting.cancelled = true;
		if (session && event.sender.id === session.owner.id) await end(null);
	});

	ipcMain.on('control:overlay-stop', (event) => {
		const overlay = session?.overlay;
		if (overlay && !overlay.isDestroyed() && event.sender.id === overlay.webContents.id) void end('user');
	});

	app.on('before-quit', () => void end('closed'));

	return {
		recordSharedSource: (source) => {
			sources.record({ id: source.id, name: source.name, display_id: source.display_id });
		}
	};
}
