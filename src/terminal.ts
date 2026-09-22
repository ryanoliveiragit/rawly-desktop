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
 * POR QUE NÃO node-pty: ele é código nativo e teria de ser recompilado para
 * cada plataforma e cada versão do Electron, o que quebraria o empacotamento
 * que já funciona. O PTY sai do que o sistema já tem — python3 (que também dá
 * o redimensionamento certo, pelo ioctl) e, se faltar, o `script`. No Windows,
 * PowerShell sem PTY: dá para rodar comando, não para rodar tela cheia.
 */
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
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

interface Sessao {
	processo: ChildProcessWithoutNullStreams;
	redimensiona: boolean;
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
		let aberto;
		try {
			aberto = abrirProcesso(alvoDe(pedido.container), cwd, cols, rows);
		} catch (erro) {
			return { ok: false, erro: erro instanceof Error ? erro.message : 'não abriu' };
		}

		const sessao: Sessao = {
			processo: aberto.processo,
			redimensiona: aberto.redimensiona,
			decoder: new TextDecoder('utf-8')
		};
		sessoes.set(id, sessao);

		const mandar = (bruto: Buffer) => {
			// stream: true mantém caractere multibyte inteiro entre pedaços.
			janela()?.webContents.send('terminal:saida', {
				id,
				dados: sessao.decoder.decode(bruto, { stream: true })
			});
		};
		aberto.processo.stdout.on('data', mandar);
		aberto.processo.stderr.on('data', mandar);
		aberto.processo.on('error', (erro) => {
			janela()?.webContents.send('terminal:saida', {
				id,
				dados: `\r\n[não deu para abrir o terminal: ${erro.message}]\r\n`
			});
		});
		aberto.processo.on('close', (codigo) => {
			sessoes.delete(id);
			janela()?.webContents.send('terminal:fim', { id, codigo: codigo ?? 0 });
		});
		return { ok: true, redimensiona: aberto.redimensiona };
	});

	ipcMain.on('terminal:teclas', (_evento, bruto: unknown) => {
		const { id, dados } = (bruto ?? {}) as { id?: string; dados?: string };
		if (!id || typeof dados !== 'string') return;
		sessoes.get(id)?.processo.stdin.write(dados);
	});

	ipcMain.on('terminal:tamanho', (_evento, bruto: unknown) => {
		const { id, cols, rows } = (bruto ?? {}) as { id?: string; cols?: number; rows?: number };
		if (!id || !cols || !rows) return;
		const sessao = sessoes.get(id);
		if (!sessao?.redimensiona) return;
		// O tamanho vai pelo canal de controle, nunca pelo teclado: escrever
		// `stty` no shell sujaria a tela a cada ajuste.
		const controle = sessao.processo.stdio[3] as NodeJS.WritableStream | undefined;
		controle?.write(`R ${rows} ${cols}\n`);
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
		sessoes.get(id)?.processo.kill();
		sessoes.delete(id);
	});
}

/** Fecha tudo quando o app sai: shell órfão fica rodando para sempre. */
export function closeAllTerminals(): void {
	for (const sessao of sessoes.values()) sessao.processo.kill();
	sessoes.clear();
}
