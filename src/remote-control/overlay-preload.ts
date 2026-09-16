import { contextBridge, ipcRenderer } from 'electron';

/** A faixa "Fulano está controlando sua tela" só sabe pedir para parar. */
contextBridge.exposeInMainWorld('controlOverlay', {
	stop: () => ipcRenderer.send('control:overlay-stop')
});
