import { contextBridge, ipcRenderer } from 'electron';

/** O cursor laranja só recebe quem é a pessoa (nome e foto embutida). */
contextBridge.exposeInMainWorld('cursorOverlay', {
	onPerson: (callback: (person: { name: string; photo: string | null }) => void) => {
		ipcRenderer.on('cursor-overlay:person', (_event, person: { name: string; photo: string | null }) => callback(person));
	}
});
