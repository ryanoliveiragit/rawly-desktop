import { contextBridge, ipcRenderer } from 'electron';

/**
 * A ponte entre o site e a casca, exposta como `window.rawlyDesktop`. É tudo
 * que o site enxerga do Electron: em que sistema está, a versão da casca e o
 * selo de não lidas. Roda no sandbox, sem acesso ao Node.
 */
const version =
	process.argv
		.find((arg) => arg.startsWith('--rawly-version='))
		?.slice('--rawly-version='.length) ?? '';

contextBridge.exposeInMainWorld('rawlyDesktop', {
	platform: process.platform,
	version,
	setBadge: (count?: number): Promise<void> => ipcRenderer.invoke('badge:set', Number(count ?? 0))
});
