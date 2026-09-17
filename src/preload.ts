import { contextBridge, ipcRenderer } from 'electron';
// Só tipos: o preload roda no sandbox e não pode carregar outros arquivos.
import type {
	RemoteControlCapabilities,
	RemoteControlSharedSource,
	RemoteInput,
	StartResult,
	StopReason
} from './remote-control/protocol';

/**
 * A ponte entre o site e a casca, exposta como `window.rawlyDesktop`. É tudo
 * que o site enxerga do Electron: em que sistema está, a versão da casca, o
 * selo de não lidas e o controle remoto da tela (docs/controle-remoto.md).
 * Roda no sandbox, sem acesso ao Node.
 */
const version =
	process.argv
		.find((arg) => arg.startsWith('--rawly-version='))
		?.slice('--rawly-version='.length) ?? '';

/** `hidden:<altura>`: a barra do sistema está escondida e a faixa do site é a barra da janela. */
const chromeArg =
	process.argv.find((arg) => arg.startsWith('--rawly-chrome='))?.slice('--rawly-chrome='.length) ?? '';
const chrome = chromeArg.startsWith('hidden')
	? { titleBar: 'hidden' as const, height: Number(chromeArg.split(':')[1] ?? '32') || 32 }
	: { titleBar: 'native' as const, height: 0 };

contextBridge.exposeInMainWorld('rawlyDesktop', {
	platform: process.platform,
	version,
	chrome,
	setBadge: (count?: number): Promise<void> => ipcRenderer.invoke('badge:set', Number(count ?? 0)),
	/** Atalhos globais (`shortcuts.ts`): o do microfone vale com o Rawly atrás de outra janela. */
	shortcuts: {
		setMute: (enabled: boolean): Promise<boolean> => ipcRenderer.invoke('shortcut:mute', enabled === true),
		onMute: (callback: () => void): (() => void) => {
			const listener = () => callback();
			ipcRenderer.on('shortcut:mute-pressed', listener);
			return () => {
				ipcRenderer.removeListener('shortcut:mute-pressed', listener);
			};
		}
	},
	control: {
		capabilities: (): Promise<RemoteControlCapabilities> => ipcRenderer.invoke('control:capabilities'),
		sharedSources: (): Promise<RemoteControlSharedSource[]> => ipcRenderer.invoke('control:shared-sources'),
		start: (opts: { controllerName: string; controllerPhoto?: string | null; sourceId?: string }): Promise<StartResult> =>
			ipcRenderer.invoke('control:start', {
				controllerName: opts?.controllerName,
				controllerPhoto: opts?.controllerPhoto,
				sourceId: opts?.sourceId
			}),
		input: (event: RemoteInput): void => ipcRenderer.send('control:input', event),
		stop: (): Promise<void> => ipcRenderer.invoke('control:stop'),
		onStop: (callback: (reason: StopReason) => void): (() => void) => {
			const listener = (_event: Electron.IpcRendererEvent, reason: StopReason) => callback(reason);
			ipcRenderer.on('control:stopped', listener);
			return () => {
				ipcRenderer.removeListener('control:stopped', listener);
			};
		}
	}
});
