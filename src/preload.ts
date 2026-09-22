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
	/**
	 * O terminal do app (docs: o shell roda no processo principal, a página só
	 * desenha). É isto que o Rawly usa quando está aberto aqui dentro; no
	 * navegador ele fala com a máquina pelo socket, que é mais lento.
	 */
	terminal: {
		disponivel: true,
		abrir: (pedido: {
			id: string;
			cwd: string;
			cols: number;
			rows: number;
			container?: string | null;
		}): Promise<{ ok: boolean; erro?: string; redimensiona?: boolean }> =>
			ipcRenderer.invoke('terminal:abrir', pedido),
		teclas: (id: string, dados: string): void => ipcRenderer.send('terminal:teclas', { id, dados }),
		tamanho: (id: string, cols: number, rows: number): void =>
			ipcRenderer.send('terminal:tamanho', { id, cols, rows }),
		fechar: (id: string): void => ipcRenderer.send('terminal:fechar', { id }),
		escolherPasta: (): Promise<string | null> => ipcRenderer.invoke('terminal:escolher-pasta'),
		/**
		 * Deixa o projeto pronto em disco (clona na primeira vez) e devolve onde
		 * ele ficou. É isto que permite abrir o terminal de um projeto conectado
		 * sem ninguém ter clonado nada à mão.
		 */
		prepararProjeto: (pedido: {
			slug: string;
			repoUrl: string;
			token: string;
		}): Promise<{ ok: boolean; pasta?: string; novo?: boolean; erro?: string }> =>
			ipcRenderer.invoke('terminal:preparar-projeto', pedido),
		/** Ouve o que sai de uma aba. Devolve a função que desliga o ouvinte. */
		aoReceber: (id: string, callback: (dados: string) => void): (() => void) => {
			const saida = (_evento: unknown, dados: { id: string; dados: string }) => {
				if (dados?.id === id) callback(dados.dados);
			};
			const fim = (_evento: unknown, dados: { id: string }) => {
				if (dados?.id === id) callback('\r\n[sessão encerrada]\r\n');
			};
			ipcRenderer.on('terminal:saida', saida);
			ipcRenderer.on('terminal:fim', fim);
			return () => {
				ipcRenderer.removeListener('terminal:saida', saida);
				ipcRenderer.removeListener('terminal:fim', fim);
			};
		}
	},
	control: {
		capabilities: (): Promise<RemoteControlCapabilities> => ipcRenderer.invoke('control:capabilities'),
		sharedSources: (): Promise<RemoteControlSharedSource[]> => ipcRenderer.invoke('control:shared-sources'),
		start: (opts: {
			controllerName: string;
			controllerPhoto?: string | null;
			sourceId?: string;
			lease?: string;
		}): Promise<StartResult> =>
			ipcRenderer.invoke('control:start', {
				controllerName: opts?.controllerName,
				controllerPhoto: opts?.controllerPhoto,
				sourceId: opts?.sourceId,
				lease: opts?.lease
			}),
		/** A licença renovada pelo servidor (0.6.0+): sem ela, a sessão para quando a anterior vence. */
		renew: (lease: string): Promise<StartResult> => ipcRenderer.invoke('control:renew', lease),
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
