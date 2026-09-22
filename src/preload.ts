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
	/** O ambiente do projeto: container montado sobre a pasta que o app mantém. */
	ambiente: {
		status: (slug: string): Promise<{
			ok: boolean;
			motor?: 'podman' | 'docker' | null;
			nome?: string;
			existe?: boolean;
			rodando?: boolean;
			subindo?: boolean;
			aviso?: string;
		}> => ipcRenderer.invoke('ambiente:status', { slug }),
		preparar: (pedido: {
			slug: string;
			pasta: string;
			plano: unknown;
			recriar?: boolean;
		}): Promise<{ ok: boolean; nome?: string; porta?: number; erro?: string }> =>
			ipcRenderer.invoke('ambiente:preparar', pedido),
		remover: (slug: string): Promise<{ ok: boolean }> => ipcRenderer.invoke('ambiente:remover', { slug }),
		/** Sobe o projeto dentro do container (o `npm run dev` dele). */
		rodar: (pedido: {
			slug: string;
			comando: string;
			porta?: number;
		}): Promise<{ ok: boolean; erro?: string; jaRodando?: boolean }> =>
			ipcRenderer.invoke('ambiente:rodar', pedido),
		parar: (slug: string): Promise<{ ok: boolean }> => ipcRenderer.invoke('ambiente:parar', { slug }),
		/** O log da montagem, enquanto ela acontece. */
		aoLog: (callback: (dados: string) => void): (() => void) => {
			const ouvinte = (_evento: unknown, dados: { dados: string }) => callback(dados?.dados ?? '');
			ipcRenderer.on('ambiente:log', ouvinte);
			return () => ipcRenderer.removeListener('ambiente:log', ouvinte);
		}
	},
	/**
	 * O projeto no disco: o editor da tela grava aqui, e é por isso que o
	 * container (que monta esta pasta) recarrega na hora. Commit e envio são
	 * passos separados, como em qualquer IDE.
	 */
	repo: {
		ler: (pasta: string, caminho: string): Promise<{ ok: boolean; conteudo?: string; erro?: string }> =>
			ipcRenderer.invoke('repo:ler', { pasta, caminho }),
		salvar: (pasta: string, caminho: string, conteudo: string): Promise<{ ok: boolean; erro?: string }> =>
			ipcRenderer.invoke('repo:salvar', { pasta, caminho, conteudo }),
		arvore: (pasta: string): Promise<{ ok: boolean; arquivos?: string[]; erro?: string }> =>
			ipcRenderer.invoke('repo:arvore', { pasta }),
		buscar: (
			pasta: string,
			termo: string
		): Promise<{ ok: boolean; resultados?: { path: string; linha: number; texto: string }[] }> =>
			ipcRenderer.invoke('repo:buscar', { pasta, termo }),
		status: (pasta: string): Promise<{
			ok: boolean;
			ramo?: string;
			arquivos?: { path: string; estado: string; diff: string | null }[];
			porEnviar?: number;
			erro?: string;
		}> => ipcRenderer.invoke('repo:status', { pasta }),
		descartar: (pasta: string, caminho: string): Promise<{ ok: boolean; erro?: string }> =>
			ipcRenderer.invoke('repo:descartar', { pasta, caminho }),
		ramos: (pasta: string): Promise<{ ok: boolean; atual?: string; ramos?: string[] }> =>
			ipcRenderer.invoke('repo:ramos', { pasta }),
		criarRamo: (pasta: string, nome: string): Promise<{ ok: boolean; erro?: string }> =>
			ipcRenderer.invoke('repo:criar-ramo', { pasta, nome }),
		trocarRamo: (pasta: string, nome: string): Promise<{ ok: boolean; erro?: string }> =>
			ipcRenderer.invoke('repo:trocar-ramo', { pasta, nome }),
		confirmar: (pedido: {
			pasta: string;
			mensagem: string;
			autor?: string;
			email?: string;
		}): Promise<{ ok: boolean; erro?: string }> => ipcRenderer.invoke('repo:confirmar', pedido),
		enviar: (pedido: {
			pasta: string;
			token: string;
			ramo?: string;
		}): Promise<{ ok: boolean; ramo?: string; erro?: string }> => ipcRenderer.invoke('repo:enviar', pedido)
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
