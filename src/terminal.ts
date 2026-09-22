/**
 * O terminal do Rawly rodando DENTRO do app (21/09/2026: "quero que funcione
 * igual uma IDE").
 *
 * É por isso que o terminal do VS Code é instantâneo e o nosso não era: lá o
 * shell roda no mesmo programa que desenha a janela, e os dois conversam por
 * IPC — memória, não rede. Aqui é a mesma coisa: o processo principal abre o
 * PTY, e a página recebe o que sai por `webContents.send`. Nenhuma tecla sai
 * desta máquina.
 *
 * No navegador o Rawly continua conversando com a máquina pelo socket, que é o
 * melhor possível fora do app. Aqui dentro, não há intermediário.
 *
 * O PTY vem do `node-pty` (22/09/2026), que é o que o VS Code usa: PTY de
 * verdade nas três plataformas — inclusive no Windows, pelo ConPTY — com
 * redimensionamento nativo. Ele é código nativo e precisa ser recompilado para
 * a versão do Electron (`electron-builder install-app-deps` faz isso, como já
 * fazia com o koffi).
 *
 * O caminho antigo continua como reserva, e não por gosto: se o módulo nativo
 * não carregar (um empacotamento sem o rebuild, uma arquitetura sem binário), o
 * terminal ainda abre com o `python3` ou o `script` do sistema, em vez de a aba
 * simplesmente não funcionar.
 */
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { dialog, ipcMain, type BrowserWindow } from 'electron';

/** O PTY em Python: abre o shell e ouve o tamanho num canal à parte (fd 3). */
const PTY_PY = [
	'import os,pty,sys,select,fcntl,termios,struct',
	'alvo=sys.argv[1:] or [os.environ.get("SHELL","/bin/bash"),"-i"]',
	'pid,fd=pty.fork()',
	'if pid==0:',
	'    os.execvp(alvo[0],alvo)',
	'def tamanho(linhas,colunas):',
	'    fcntl.ioctl(fd,termios.TIOCSWINSZ,struct.pack("HHHH",linhas,colunas,0,0))',
	'tamanho(int(os.environ.get("LINES","24")),int(os.environ.get("COLUMNS","80")))',
	'controle=os.fdopen(3,"rb",0)',
	'restante=b""',
	'while True:',
	'    try:',
	'        prontos,_,_=select.select([fd,0,3],[],[])',
	'    except (OSError,ValueError):',
	'        break',
	'    if fd in prontos:',
	'        try: saida=os.read(fd,65536)',
	'        except OSError: break',
	'        if not saida: break',
	'        os.write(1,saida)',
	'    if 0 in prontos:',
	'        entrada=os.read(0,65536)',
	'        if not entrada: break',
	'        os.write(fd,entrada)',
	'    if 3 in prontos:',
	'        restante+=os.read(3,4096)',
	'        while b"\\n" in restante:',
	'            linha,restante=restante.split(b"\\n",1)',
	'            partes=linha.decode().split()',
	'            if len(partes)==3 and partes[0]=="R":',
	'                tamanho(int(partes[1]),int(partes[2]))',
	'os.close(fd)'
].join('\n');

/**
 * O que uma sessão precisa saber fazer, venha ela do node-pty ou do caminho de
 * reserva. Quem usa não precisa saber de qual dos dois veio.
 */
interface Terminal {
	escrever: (dados: string) => void;
	tamanho: (cols: number, rows: number) => void;
	encerrar: () => void;
	aoSair: (callback: (codigo: number) => void) => void;
}

interface Sessao {
	terminal: Terminal;
	decoder: TextDecoder;
}

const sessoes = new Map<string, Sessao>();

function existe(programa: string): boolean {
	const teste = spawnSync(process.platform === 'win32' ? 'where' : 'which', [programa], {
		stdio: 'ignore'
	});
	return teste.status === 0;
}

interface Alvo {
	programa: string;
	argumentos: string[];
}

/** O que abrir: o shell da pessoa, ou um shell dentro do container do projeto. */
function alvoDe(container?: string | null): Alvo {
	const shell = process.env.SHELL || (process.platform === 'win32' ? 'powershell.exe' : 'bash');
	if (container) {
		const motor = existe('podman') ? 'podman' : existe('docker') ? 'docker' : null;
		if (motor) {
			return {
				programa: motor,
				argumentos: [
					'exec',
					'-it',
					'-w',
					'/workspace',
					container,
					'sh',
					'-c',
					'command -v bash >/dev/null && exec bash -l || exec sh -l'
				]
			};
		}
	}
	return { programa: shell, argumentos: process.platform === 'win32' ? [] : ['-i'] };
}

/**
 * O PTY do node-pty. Devolve `null` quando o módulo nativo não carrega — e aí
 * o caminho de reserva assume.
 */
function abrirComNodePty(
	alvo: Alvo,
	cwd: string,
	cols: number,
	rows: number,
	aoDados: (texto: string) => void
): Terminal | null {
	try {
		// Carregado sob demanda: um módulo nativo ausente não pode impedir o app
		// de abrir.
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const pty = require('node-pty') as typeof import('node-pty');
		const processo = pty.spawn(alvo.programa, alvo.argumentos, {
			name: 'xterm-256color',
			cwd,
			cols,
			rows,
			env: { ...process.env, TERM: 'xterm-256color' } as Record<string, string>
		});
		processo.onData((dados) => aoDados(dados));
		return {
			escrever: (dados) => processo.write(dados),
			tamanho: (c, r) => {
				try {
					processo.resize(c, r);
				} catch {
					// Janela fechando no meio do ajuste: nada a fazer.
				}
			},
			encerrar: () => processo.kill(),
			aoSair: (callback) => processo.onExit(({ exitCode }) => callback(exitCode))
		};
	} catch (erro) {
		console.warn('[rawly/terminal] node-pty indisponível, usando o caminho de reserva:', erro);
		return null;
	}
}

function abrirProcesso(
	alvo: Alvo,
	cwd: string,
	cols: number,
	rows: number
): { processo: ChildProcessWithoutNullStreams; redimensiona: boolean } {
	const env = {
		...process.env,
		TERM: 'xterm-256color',
		COLUMNS: String(cols),
		LINES: String(rows)
	};
	const opcoes = { cwd, env } as const;

	if (process.platform !== 'win32' && existe('python3')) {
		const processo = spawn('python3', ['-c', PTY_PY, alvo.programa, ...alvo.argumentos], {
			...opcoes,
			stdio: ['pipe', 'pipe', 'pipe', 'pipe']
		}) as ChildProcessWithoutNullStreams;
		return { processo, redimensiona: true };
	}
	if (process.platform !== 'win32' && existe('script')) {
		const linha = [alvo.programa, ...alvo.argumentos].join(' ');
		const argumentos =
			process.platform === 'darwin'
				? ['-q', '/dev/null', alvo.programa, ...alvo.argumentos]
				: ['-qfc', linha, '/dev/null'];
		return { processo: spawn('script', argumentos, opcoes) as ChildProcessWithoutNullStreams, redimensiona: false };
	}
	return {
		processo: spawn(alvo.programa, alvo.argumentos, opcoes) as ChildProcessWithoutNullStreams,
		redimensiona: false
	};
}

/**
 * O projeto do Rawly na máquina, preparado pelo próprio app.
 *
 * Ninguém deveria precisar clonar nada à mão para mexer no código de um
 * projeto que já está conectado no Rawly (pedido de 21/09/2026: "o projeto não
 * pode estar dentro do meu PC — só fica dentro do Rawly o repositório
 * conectado"). Fisicamente o código precisa existir em algum disco para um
 * shell trabalhar nele; o que muda é quem cuida: o app clona em
 * `~/.rawly/projetos/<projeto>` e mantém atualizado, e a pessoa nunca escolhe
 * pasta nem lembra onde ficou.
 *
 * O token de acesso não entra na linha de comando (apareceria em `ps`): ele vai
 * por variável de ambiente, lida por um auxiliar de credencial do próprio git.
 */
const CREDENCIAL =
	'!f() { echo username=x-access-token; echo "password=$RAWLY_GIT_TOKEN"; }; f';

function git(argumentos: string[], cwd: string, token?: string): Promise<{ ok: boolean; saida: string }> {
	return new Promise((resolve) => {
		const processo = spawn('git', argumentos, {
			cwd,
			env: token ? { ...process.env, RAWLY_GIT_TOKEN: token } : process.env
		});
		let saida = '';
		processo.stdout.on('data', (p) => (saida += p));
		processo.stderr.on('data', (p) => (saida += p));
		processo.on('error', (erro) => resolve({ ok: false, saida: erro.message }));
		processo.on('close', (codigo) => resolve({ ok: codigo === 0, saida }));
	});
}

export interface PrepararProjeto {
	/** Identificador curto do projeto: vira o nome da pasta. */
	slug: string;
	repoUrl: string;
	/** Token de leitura do GitHub, curto, vindo do Rawly. */
	token: string;
}

export interface AbrirTerminal {
	id: string;
	cwd: string;
	cols: number;
	rows: number;
	/** Nome do container do projeto, quando a aba deve abrir dentro dele. */
	container?: string | null;
}

/**
 * Liga o terminal do app. Uma chamada por janela; as sessões vivem enquanto o
 * app viver, como as abas de terminal de qualquer IDE.
 */
export function registerTerminal(janela: () => BrowserWindow | null): void {
	ipcMain.handle('terminal:abrir', (_evento, bruto: unknown) => {
		const pedido = (bruto ?? {}) as Partial<AbrirTerminal>;
		const id = String(pedido.id ?? '');
		if (!id) return { ok: false, erro: 'sem id' };
		if (sessoes.has(id)) return { ok: true, jaAberta: true };

		const cols = Math.min(400, Math.max(20, Number(pedido.cols) || 80));
		const rows = Math.min(200, Math.max(5, Number(pedido.rows) || 24));
		const cwd = pedido.cwd && typeof pedido.cwd === 'string' ? pedido.cwd : process.env.HOME || '.';
		const alvo = alvoDe(pedido.container);
		const decoder = new TextDecoder('utf-8');
		const escrever = (dados: string) => janela()?.webContents.send('terminal:saida', { id, dados });

		let terminal = abrirComNodePty(alvo, cwd, cols, rows, escrever);
		let nativo = terminal !== null;

		if (!terminal) {
			// Reserva: o PTY sai do python3 ou do `script` do sistema.
			let aberto;
			try {
				aberto = abrirProcesso(alvo, cwd, cols, rows);
			} catch (erro) {
				return { ok: false, erro: erro instanceof Error ? erro.message : 'não abriu' };
			}
			const processo = aberto.processo;
			const receber = (bruto: Buffer) =>
				// stream: true mantém caractere multibyte inteiro entre pedaços.
				escrever(decoder.decode(bruto, { stream: true }));
			processo.stdout.on('data', receber);
			processo.stderr.on('data', receber);
			processo.on('error', (erro) =>
				escrever(`\r\n[não deu para abrir o terminal: ${erro.message}]\r\n`)
			);
			terminal = {
				escrever: (dados) => processo.stdin.write(dados),
				tamanho: (c, r) => {
					if (!aberto.redimensiona) return;
					const controle = processo.stdio[3] as NodeJS.WritableStream | undefined;
					controle?.write(`R ${r} ${c}\n`);
				},
				encerrar: () => processo.kill(),
				aoSair: (callback) => processo.on('close', (codigo) => callback(codigo ?? 0))
			};
			nativo = false;
		}

		sessoes.set(id, { terminal, decoder });
		terminal.aoSair((codigo) => {
			sessoes.delete(id);
			janela()?.webContents.send('terminal:fim', { id, codigo });
		});
		return { ok: true, nativo };
	});

	/**
	 * Garante o projeto em disco e devolve a pasta. Clona na primeira vez;
	 * depois só busca o que mudou, sem tocar no que a pessoa estiver editando.
	 */
	ipcMain.handle('terminal:preparar-projeto', async (_evento, bruto: unknown) => {
		const pedido = (bruto ?? {}) as Partial<PrepararProjeto>;
		const slug = String(pedido.slug ?? '').replace(/[^a-z0-9-]/gi, '');
		if (!slug || !pedido.repoUrl) return { ok: false, erro: 'pedido incompleto' };

		const base = join(homedir(), '.rawly', 'projetos', slug);
		const repo = pedido.repoUrl.replace(/\.git$/, '') + '.git';
		if (existsSync(join(base, '.git'))) {
			// Já está aqui: traz o que mudou no repositório, sem mexer no trabalho
			// em andamento (nada de reset, nada de checkout).
			await git(['-c', `credential.helper=${CREDENCIAL}`, 'fetch', '--all', '--prune'], base, pedido.token);
			return { ok: true, pasta: base, novo: false };
		}

		await mkdir(join(homedir(), '.rawly', 'projetos'), { recursive: true });
		const clone = await git(
			['-c', `credential.helper=${CREDENCIAL}`, 'clone', repo, base],
			homedir(),
			pedido.token
		);
		if (!clone.ok) return { ok: false, erro: clone.saida.slice(-400) };
		await git(['config', 'user.useConfigOnly', 'false'], base);
		return { ok: true, pasta: base, novo: true };
	});

	ipcMain.on('terminal:teclas', (_evento, bruto: unknown) => {
		const { id, dados } = (bruto ?? {}) as { id?: string; dados?: string };
		if (!id || typeof dados !== 'string') return;
		sessoes.get(id)?.terminal.escrever(dados);
	});

	ipcMain.on('terminal:tamanho', (_evento, bruto: unknown) => {
		const { id, cols, rows } = (bruto ?? {}) as { id?: string; cols?: number; rows?: number };
		if (!id || !cols || !rows) return;
		// Nunca pelo teclado: escrever `stty` no shell sujaria a tela a cada ajuste.
		sessoes.get(id)?.terminal.tamanho(cols, rows);
	});

	/**
	 * Onde o terminal abre. A página não sabe caminho de disco (nem deve saber
	 * sozinha): quem escolhe é a pessoa, no diálogo do sistema, e o Rawly guarda
	 * a escolha por projeto.
	 */
	ipcMain.handle('terminal:escolher-pasta', async () => {
		const alvo = janela();
		const escolha = await dialog.showOpenDialog(alvo ?? undefined!, {
			title: 'Pasta do projeto',
			properties: ['openDirectory', 'createDirectory'],
			buttonLabel: 'Usar esta pasta'
		});
		return escolha.canceled ? null : (escolha.filePaths[0] ?? null);
	});

	ipcMain.on('terminal:fechar', (_evento, bruto: unknown) => {
		const { id } = (bruto ?? {}) as { id?: string };
		if (!id) return;
		sessoes.get(id)?.terminal.encerrar();
		sessoes.delete(id);
	});
}

/** Fecha tudo quando o app sai: shell órfão fica rodando para sempre. */
export function closeAllTerminals(): void {
	for (const sessao of sessoes.values()) sessao.terminal.encerrar();
	sessoes.clear();
}
