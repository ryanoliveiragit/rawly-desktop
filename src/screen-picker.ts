import { BrowserWindow, desktopCapturer, ipcMain, session, type Streams } from 'electron';
import { outPath } from './paths';
import type { PickerChoice, PickerPayload, PickerSource } from './picker-preload';

/**
 * `getDisplayMedia` no Electron não tem seletor próprio: sem este handler o
 * "Compartilhar tela" e o "Gravar tela" do site falham. Aqui a lista de telas
 * e janelas vem do `desktopCapturer` e a pessoa escolhe numa janela pequena.
 *
 * No Mac 15+ o seletor do sistema é usado no lugar (`useSystemPicker`). No
 * Linux com Wayland, o próprio `getSources` abre o seletor do sistema (portal
 * do PipeWire) e devolve só o que a pessoa escolheu: aí não há o que perguntar.
 * O áudio do sistema só existe no Windows (`loopback`).
 */
const wayland =
	process.platform === 'linux' &&
	(process.env.XDG_SESSION_TYPE === 'wayland' || Boolean(process.env.WAYLAND_DISPLAY));

export function installScreenShare(getParent: () => BrowserWindow | null): void {
	session.defaultSession.setDisplayMediaRequestHandler(
		async (request, callback) => {
			// O callback só aceita uma resposta; sem argumento, o pedido é negado
			// (o site recebe o mesmo NotAllowedError de quando a pessoa cancela).
			let answered = false;
			const answer = (streams?: Streams) => {
				if (answered) return;
				answered = true;
				(callback as unknown as (streams?: Streams) => void)(streams);
			};
			try {
				if (!request.videoRequested) {
					answer();
					return;
				}
				const sources = await desktopCapturer.getSources({
					types: ['screen', 'window'],
					thumbnailSize: { width: 320, height: 180 },
					fetchWindowIcons: true
				});
				const canLoopback = request.audioRequested && process.platform === 'win32';
				if (sources.length === 0) {
					answer();
					return;
				}
				if (wayland && sources.length === 1) {
					answer(streamsFor(sources[0]!, canLoopback));
					return;
				}
				const choice = await pickSource(
					sources.map<PickerSource>((source) => ({
						id: source.id,
						name: source.name,
						kind: source.id.startsWith('screen:') ? 'screen' : 'window',
						thumbnail: source.thumbnail.isEmpty() ? '' : source.thumbnail.toDataURL(),
						appIcon: source.appIcon && !source.appIcon.isEmpty() ? source.appIcon.toDataURL() : null
					})),
					canLoopback,
					getParent()
				);
				const chosen = choice ? sources.find((source) => source.id === choice.id) : undefined;
				if (!chosen) {
					answer();
					return;
				}
				answer(streamsFor(chosen, canLoopback && choice!.audio));
			} catch (err) {
				console.warn('[rawly] compartilhar tela falhou', err);
				answer();
			}
		},
		{ useSystemPicker: process.platform === 'darwin' }
	);
}

function streamsFor(source: Electron.DesktopCapturerSource, audio: boolean): Streams {
	return audio ? { video: source, audio: 'loopback' } : { video: source };
}

/** Abre o seletor e resolve com a escolha, ou `null` se a pessoa cancelou ou fechou. */
function pickSource(
	sources: PickerSource[],
	audio: boolean,
	parent: BrowserWindow | null
): Promise<PickerChoice | null> {
	return new Promise((resolve) => {
		const picker = new BrowserWindow({
			parent: parent ?? undefined,
			modal: Boolean(parent),
			width: 760,
			height: 600,
			minWidth: 560,
			minHeight: 420,
			title: 'Compartilhar tela',
			backgroundColor: '#17171a',
			autoHideMenuBar: true,
			minimizable: false,
			maximizable: false,
			fullscreenable: false,
			show: false,
			webPreferences: {
				preload: outPath('picker-preload.js'),
				contextIsolation: true,
				sandbox: true,
				nodeIntegration: false
			}
		});
		let settled = false;
		const finish = (choice: PickerChoice | null) => {
			if (settled) return;
			settled = true;
			ipcMain.removeListener('picker:choose', onChoose);
			resolve(choice);
			if (!picker.isDestroyed()) picker.close();
		};
		const onChoose = (event: Electron.IpcMainEvent, choice: PickerChoice | null) => {
			if (event.sender.id !== picker.webContents.id) return;
			finish(choice && typeof choice.id === 'string' ? { id: choice.id, audio: Boolean(choice.audio) } : null);
		};
		ipcMain.on('picker:choose', onChoose);
		picker.on('closed', () => finish(null));
		picker.webContents.on('did-finish-load', () => {
			const payload: PickerPayload = { sources, audio };
			picker.webContents.send('picker:sources', payload);
		});
		picker.once('ready-to-show', () => picker.show());
		void picker.loadFile(outPath('picker.html'));
	});
}
