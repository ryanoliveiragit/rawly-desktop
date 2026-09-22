/**
 * Rawly para Mac, Linux e Windows: uma casca Electron que abre o site de
 * produção, como o Discord. O app inteiro continua no site; aqui ficam só as
 * coisas que um app instalado faz e o navegador não: janela própria lembrada
 * entre aberturas, uma instância só, seletor de tela para o "Compartilhar
 * tela", selo de não lidas no ícone, página offline, atualização automática, o
 * controle remoto da tela (`remote-control/`) e o atalho global do microfone
 * (`shortcuts.ts`).
 *
 * Segurança: a janela só carrega a origem do app; todo link para fora abre
 * no navegador do sistema; o site roda no sandbox, sem Node, e só enxerga a
 * ponte `window.rawlyDesktop` do preload.
 */
import {
	app,
	BrowserWindow,
	ipcMain,
	Menu,
	session,
	shell,
	type BrowserWindowConstructorOptions
} from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { applyBadge } from './badge';
import { isAppUrl, readConfig } from './config';
import { aboutPanel, buildMenu } from './menu';
import { outPath, resourcePath } from './paths';
import { installPermissionHandlers } from './permissions';
import { installRemoteControl } from './remote-control';
import { installScreenShare } from './screen-picker';
import { installShortcuts } from './shortcuts';
import { closeAllTerminals, registerTerminal } from './terminal';
import { registerRepo } from './repo';
import { registerWorkspace } from './workspace';
import { startUpdater } from './updater';
import { DEFAULT_SIZE, readWindowState, trackWindowState } from './window-state';

const APP_USER_MODEL_ID = 'digital.nevus.rawly';
const BACKGROUND = '#17171a';
/** A faixa de status do site tem 28px (× a escala da interface): a barra do sistema some e os controles da janela caem nela. */
const TITLE_BAR_HEIGHT = 32;
const TITLE_BAR_SYMBOL = '#b8b8c0';

const config = readConfig();
let mainWindow: BrowserWindow | null = null;
/** No Mac fechar a janela só a esconde; `quitting` diz que é para sair de verdade. */
let quitting = false;

// Windows: o mesmo id do atalho que o instalador cria, senão os avisos saem sem nome e sem ícone.
app.setAppUserModelId(APP_USER_MODEL_ID);
if (!app.isPackaged) {
	app.setName('Rawly');
	// Em desenvolvimento, dados (cookies, estado da janela) separados do app instalado.
	app.setPath('userData', path.join(app.getPath('appData'), 'Rawly-dev'));
}
if (process.platform === 'linux') {
	// Wayland: captura de tela pelo PipeWire, e o atalho global de parar o controle remoto pelo
	// portal GlobalShortcuts (sem ele o atalho só funcionaria com a janela do Rawly em foco).
	app.commandLine.appendSwitch('enable-features', 'WebRTCPipeWireCapturer,GlobalShortcutsPortal');
	// O .desktop que o instalador cria (`desktopName` no package.json): o lançador agrupa a janela e mostra o selo.
	app.setDesktopName('rawly-desktop.desktop');
}

if (!app.requestSingleInstanceLock()) {
	app.quit();
} else {
	app.on('second-instance', () => focusMain());
	app.on('web-contents-created', (_event, contents) => guardNavigation(contents));
	app.on('before-quit', () => {
		quitting = true;
		// Shell órfão fica rodando para sempre depois que a janela some.
		closeAllTerminals();
	});
	app.on('window-all-closed', () => {
		if (process.platform !== 'darwin') app.quit();
	});
	app.on('activate', () => focusMain());
	app.on('browser-window-focus', (_event, win) => win.flashFrame(false));
	void app.whenReady().then(bootstrap);
}

function bootstrap(): void {
	app.userAgentFallback = desktopUserAgent(app.userAgentFallback);
	aboutPanel(config.appUrl);
	Menu.setApplicationMenu(
		buildMenu({
			dev: config.dev,
			reload: () => mainWindow?.webContents.reload(),
			about: () => app.showAboutPanel()
		})
	);
	if (process.platform !== 'darwin') {
		session.defaultSession.setSpellCheckerLanguages(['pt-BR', 'en-US']);
	}
	installPermissionHandlers(session.defaultSession, config.appUrl);
	const remoteControl = installRemoteControl({ appUrl: config.appUrl });
	installShortcuts({ appUrl: config.appUrl });
	// O terminal do app: o shell roda aqui dentro, e a página fala com ele por
	// IPC. É o que faz a aba Código do Rawly responder como uma IDE responde.
	registerTerminal(() => mainWindow);
	// O ambiente do projeto (container) também mora aqui: no app não há programa
	// nenhum para instalar, e é ele que alcança o Podman ou o Docker da máquina.
	registerWorkspace(() => mainWindow);
	// Ler, salvar e o git da pasta do projeto: é o que faz o editor da tela
	// mexer nos arquivos que o container está servindo.
	registerRepo();
	installScreenShare(
		() => mainWindow,
		(source) => remoteControl.recordSharedSource(source)
	);
	ipcMain.handle('badge:set', (event, count: unknown) => {
		// Só o site manda no selo; a página offline e qualquer outra origem são ignoradas.
		if (!isAppUrl(event.senderFrame?.url ?? '', config.appUrl)) return;
		applyBadge(mainWindow, typeof count === 'number' ? count : 0);
	});

	createMainWindow();
	startUpdater({
		enabled: app.isPackaged && !config.dev && !config.screenshotPath,
		getWindow: () => mainWindow
	});
}

/** O UA do Chromium sem os tokens do Electron (que confundem captchas), mais o nosso. */
function desktopUserAgent(base: string): string {
	const escaped = app.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	return `${base
		.replace(new RegExp(` ${escaped}/[^ ]+`), '')
		.replace(/ Electron\/[^ ]+/, '')} RawlyDesktop/${app.getVersion()}`;
}

function webPreferences(): BrowserWindowConstructorOptions['webPreferences'] {
	return {
		preload: outPath('preload.js'),
		contextIsolation: true,
		sandbox: true,
		nodeIntegration: false,
		spellcheck: true,
		additionalArguments: [`--rawly-version=${app.getVersion()}`, `--rawly-chrome=hidden:${TITLE_BAR_HEIGHT}`]
	};
}

function createMainWindow(): BrowserWindow {
	const state = readWindowState();
	const win = new BrowserWindow({
		...DEFAULT_SIZE,
		...(state.bounds ?? {}),
		show: false,
		title: 'Rawly',
		backgroundColor: BACKGROUND,
		// Windows e Linux: sem barra de menu à vista (Alt mostra), como o Discord.
		autoHideMenuBar: process.platform !== 'darwin',
		// A barra do sistema some (pedido em 15/09/2026): a faixa de status do site vira a
		// barra da janela — arrasta por ela, e os botões de fechar/minimizar/maximizar
		// ficam sobrepostos nela (no Mac, os semáforos no canto, sobre o trilho).
		titleBarStyle: 'hidden',
		...(process.platform === 'darwin'
			? { trafficLightPosition: { x: 12, y: 9 } }
			: { titleBarOverlay: { color: BACKGROUND, symbolColor: TITLE_BAR_SYMBOL, height: TITLE_BAR_HEIGHT } }),
		icon: process.platform === 'linux' ? resourcePath('icon.png') : undefined,
		webPreferences: webPreferences()
	});
	mainWindow = win;
	trackWindowState(win);
	if (state.maximized) win.maximize();
	win.once('ready-to-show', () => win.show());

	win.on('close', (event) => {
		if (process.platform === 'darwin' && !quitting) {
			event.preventDefault();
			win.hide();
		}
	});
	win.on('closed', () => {
		if (mainWindow === win) mainWindow = null;
	});

	const load = () => void win.loadURL(config.appUrl.href);
	// Sem rede (ou o site fora do ar): a página offline, que volta sozinha quando der.
	win.webContents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
		if (!isMainFrame || code === -3 /* ERR_ABORTED: navegação trocada no meio */) return;
		console.warn(`[rawly] não carregou ${url}: ${code} ${description}`);
		void win.loadFile(outPath('offline.html'), {
			query: { url: config.appUrl.href, code: String(code) }
		});
	});
	win.webContents.on('render-process-gone', (_event, details) => {
		if (details.reason === 'clean-exit' || details.reason === 'killed') return;
		console.warn('[rawly] a página caiu, recarregando', details.reason);
		setTimeout(load, 1000);
	});
	if (config.screenshotPath) armScreenshot(win, config.screenshotPath, config.keepOpen);
	load();
	return win;
}

/** `--screenshot=<caminho>`: captura a janela 3s depois do último carregamento e sai. */
function armScreenshot(win: BrowserWindow, target: string, keepOpen: boolean): void {
	let timer: NodeJS.Timeout | null = null;
	win.webContents.on('did-finish-load', () => {
		if (timer) clearTimeout(timer);
		timer = setTimeout(async () => {
			try {
				const image = await win.webContents.capturePage();
				fs.mkdirSync(path.dirname(target), { recursive: true });
				fs.writeFileSync(target, image.toPNG());
				console.log(`[rawly] screenshot ${target} de ${win.webContents.getURL()}`);
			} catch (err) {
				console.error('[rawly] screenshot falhou', err);
			}
			if (!keepOpen) {
				quitting = true;
				app.quit();
			}
		}, 3000);
	});
}

function focusMain(): void {
	if (!mainWindow || mainWindow.isDestroyed()) {
		createMainWindow();
		return;
	}
	if (mainWindow.isMinimized()) mainWindow.restore();
	mainWindow.show();
	mainWindow.focus();
}

/**
 * Só a origem do app navega dentro das janelas; o resto abre no navegador.
 * Vale para a janela principal, para as janelas que o site abrir
 * (`target=_blank` da própria origem) e para o seletor de tela.
 */
function guardNavigation(contents: Electron.WebContents): void {
	contents.on('will-navigate', (event, url) => {
		if (isAppUrl(url, config.appUrl)) return;
		event.preventDefault();
		openOutside(url);
	});
	contents.setWindowOpenHandler(({ url }) => {
		if (isAppUrl(url, config.appUrl)) {
			return {
				action: 'allow',
				overrideBrowserWindowOptions: {
					width: 1100,
					height: 760,
					backgroundColor: BACKGROUND,
					autoHideMenuBar: true,
					webPreferences: webPreferences()
				}
			};
		}
		openOutside(url);
		return { action: 'deny' };
	});
	contents.on('will-attach-webview', (event) => event.preventDefault());
}

function openOutside(url: string): void {
	if (/^(https?|mailto|tel):/i.test(url)) void shell.openExternal(url);
}
