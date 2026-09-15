import { contextBridge, ipcRenderer } from 'electron';

/** O seletor de tela recebe a lista de fontes e devolve a escolha (ou nada). */
export interface PickerSource {
	id: string;
	name: string;
	kind: 'screen' | 'window';
	thumbnail: string;
	appIcon: string | null;
}

export interface PickerPayload {
	sources: PickerSource[];
	/** A plataforma consegue capturar o áudio do sistema (só Windows). */
	audio: boolean;
}

export interface PickerChoice {
	id: string;
	audio: boolean;
}

contextBridge.exposeInMainWorld('picker', {
	onSources: (callback: (payload: PickerPayload) => void) => {
		ipcRenderer.on('picker:sources', (_event, payload: PickerPayload) => callback(payload));
	},
	choose: (id: string, audio: boolean) => ipcRenderer.send('picker:choose', { id, audio }),
	cancel: () => ipcRenderer.send('picker:choose', null)
});
