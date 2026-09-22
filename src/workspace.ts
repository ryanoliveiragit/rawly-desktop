/**
 * O ambiente do projeto dentro do app: um container por projeto, montado em
 * cima da pasta que o app já mantém (21/09/2026: "precisa funcionar como um
 * Docker da vida, que eu não preciso instalar tudo para rodar").
 *
 * A ideia é a do Codespaces, com uma diferença que simplifica tudo: o código
 * NÃO é clonado dentro do container. O app já mantém o projeto em
 * `~/.rawly/projetos/<projeto>` (terminal.ts), e essa pasta é montada no
 * container. Assim o editor, o git e o terminal veem os mesmos arquivos, e
 * derrubar o container não perde nada — nem exige token de clone lá dentro.
 *
 * O que o container dá: o Node (ou Python, ou Go) na versão certa e as
 * dependências instaladas, sem nada disso ser instalado na máquina de quem usa.
 *
 * Por que isto vive no app, e não no programa de linha de comando: no app não
 * há programa nenhum para instalar — ele já está aqui, e é ele que tem acesso
 * ao Podman ou ao Docker da máquina.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { ipcMain, type BrowserWindow } from 'electron';

export interface PlanoAmbiente {
	image: string;
	setup: string[];
	run: string | null;
	port: number;
	/** O projeto abre uma janela (Electron, Tauri) em vez de servir uma porta. */
	gui?: boolean;
	resumo: string;
}

/**
 * O que um app de janela precisa dentro do container, e o que ele precisa do
 * lado de fora.
 *
 * Um Electron dentro de um container é um Chromium: ele exige as bibliotecas
 * gráficas (que a imagem de Node não traz) e um servidor X para desenhar. Aqui
 * o X é o da própria máquina — o socket é montado no container, e a janela
 * aparece na tela de quem está usando, como qualquer outro programa. No
 * Wayland isso passa pelo XWayland, que já está de pé em qualquer sessão
 * moderna.
 *
 * O sandbox do Chromium não funciona sem privilégios que um container comum
 * não tem; por isso o app roda com ele desligado. Vale dizer o que isso
 * significa: o isolamento continua sendo o do container, não o do navegador.
 */
const LIBS_GUI =
	'apt-get update -qq && apt-get install -y -qq --no-install-recommends ' +
	'libgtk-3-0 libnss3 libasound2 libgbm1 libdrm2 libxshmfence1 libxkbcommon0 ' +
	'libatk-bridge2.0-0 libatspi2.0-0 libcups2 libxcomposite1 libxdamage1 libxrandr2 ' +
	'libpango-1.0-0 libcairo2 xauth x11-utils > /dev/null';

function argumentosDeTela(): string[] {
	const display = process.env.DISPLAY;
	if (!display || process.platform !== 'linux') return [];
	const args = [
		'-e', `DISPLAY=${display}`,
		'-e', 'ELECTRON_DISABLE_SANDBOX=1',
		'-v', '/tmp/.X11-unix:/tmp/.X11-unix:ro',
		// O Chromium usa memória compartilhada de verdade; com o padrão de 64 MB
		// ele fecha sozinho no primeiro quadro.
		'--shm-size=1g',
		'--ipc=host',
		// O SELinux do Fedora barra o socket do X vindo de container.
		'--security-opt', 'label=disable'
	];
	const xauth = process.env.XAUTHORITY;
	if (xauth) {
		args.push('-v', `${xauth}:/tmp/.Xauthority:ro`, '-e', 'XAUTHORITY=/tmp/.Xauthority');
	}
	if (existsSync('/dev/dri')) args.push('--device', '/dev/dri');
	return args;
}

/** Onde tentar baixar a imagem. Em muita rede o Docker Hub não responde. */
const REGISTROS = ['docker.io/library', 'public.ecr.aws/docker/library'];

function existe(programa: string): boolean {
	return spawnSync(process.platform === 'win32' ? 'where' : 'which', [programa], {
		stdio: 'ignore'
	}).status === 0;
}

function motor(): 'podman' | 'docker' | null {
	if (existe('podman')) return 'podman';
	if (existe('docker')) return 'docker';
	return null;
}

const nomeDo = (slug: string) => `rawly-${slug.replace(/[^a-z0-9-]/gi, '')}`;

/**
 * Uma porta livre nesta máquina, começando pela que o projeto prefere.
 *
 * Sem isto, montar o ambiente de um projeto que usa a porta 3000 numa máquina
 * que já tem algo na 3000 falhava com "address already in use" — e o container
 * nem chegava a existir. A porta publicada não precisa ser a mesma de dentro:
 * o projeto continua servindo na 3000 lá dentro, e a tela abre o endereço que
 * de fato ficou.
 */
function portaLivre(preferida: number): Promise<number> {
	const tentar = (porta: number, restantes: number): Promise<number> =>
		new Promise((resolve) => {
			if (restantes <= 0) return resolve(preferida);
			const servidor = createServer();
			servidor.once('error', () => resolve(tentar(porta + 1, restantes - 1)));
			servidor.once('listening', () => {
				servidor.close(() => resolve(porta));
			});
			servidor.listen(porta, '127.0.0.1');
		});
	return tentar(preferida, 25);
}

/** A porta que o container publicou no host, lida dele mesmo. */
async function portaPublicada(alvo: string, nome: string): Promise<number | null> {
	const { codigo, saida } = await correr(alvo, ['port', nome]);
	if (codigo !== 0) return null;
	const achado = /:(\d+)\s*$/m.exec(saida.trim());
	return achado ? Number(achado[1]) : null;
}


function correr(
	programa: string,
	argumentos: string[],
	aoLog?: (texto: string) => void
): Promise<{ codigo: number; saida: string }> {
	return new Promise((resolve) => {
		aoLog?.(`\x1b[2m$ ${programa} ${argumentos.join(' ')}\x1b[0m\r\n`);
		const processo = spawn(programa, argumentos);
		let saida = '';
		const receber = (bruto: Buffer) => {
			const texto = bruto.toString();
			saida += texto;
			aoLog?.(texto.replace(/\n/g, '\r\n'));
		};
		processo.stdout.on('data', receber);
		processo.stderr.on('data', receber);
		processo.on('error', (erro) => resolve({ codigo: 127, saida: erro.message }));
		processo.on('close', (codigo) => resolve({ codigo: codigo ?? 0, saida }));
	});
}

async function estado(nome: string): Promise<{ existe: boolean; rodando: boolean }> {
	const alvo = motor();
	if (!alvo) return { existe: false, rodando: false };
	const { codigo, saida } = await correr(alvo, ['inspect', '-f', '{{.State.Running}}', nome]);
	if (codigo !== 0) return { existe: false, rodando: false };
	return { existe: true, rodando: saida.trim() === 'true' };
}

/** O processo do projeto rodando dentro do container, por projeto. */
const rodando = new Map<string, ReturnType<typeof spawn>>();

export function registerWorkspace(janela: () => BrowserWindow | null): void {
	const log = (texto: string) => janela()?.webContents.send('ambiente:log', { dados: texto });

	ipcMain.handle('ambiente:status', async (_evento, bruto: unknown) => {
		const { slug } = (bruto ?? {}) as { slug?: string };
		if (!slug) return { ok: false };
		const alvo = motor();
		if (!alvo) {
			return {
				ok: true,
				motor: null,
				existe: false,
				rodando: false,
				aviso: 'Esta máquina não tem Podman nem Docker instalado.'
			};
		}
		const nome = nomeDo(slug);
		const atual = await estado(nome);
		return {
			ok: true,
			motor: alvo,
			nome,
			...atual,
			// A porta que vale é a que o container publicou, não a que o projeto
			// pediu: elas diferem quando a preferida estava ocupada.
			porta: atual.existe ? await portaPublicada(alvo, nome) : null,
			subindo: rodando.has(nome)
		};
	});

	ipcMain.handle('ambiente:preparar', async (_evento, bruto: unknown) => {
		const pedido = (bruto ?? {}) as { slug?: string; pasta?: string; plano?: PlanoAmbiente; recriar?: boolean };
		const alvo = motor();
		if (!alvo) return { ok: false, erro: 'Instale o Podman ou o Docker para montar o ambiente.' };
		if (!pedido.slug || !pedido.pasta || !pedido.plano) return { ok: false, erro: 'pedido incompleto' };

		const nome = nomeDo(pedido.slug);
		const plano = pedido.plano;
		log(`\x1b[1mMontando o ambiente do projeto\x1b[0m\r\n\x1b[2m${plano.resumo}\x1b[0m\r\n\r\n`);

		if (pedido.recriar) await correr(alvo, ['rm', '-f', nome]);
		let atual = await estado(nome);

		// Container parado pode falhar ao subir porque a porta que ele reservou
		// ficou ocupada por outra coisa. Nesse caso ele é refeito com uma porta
		// livre, em vez de deixar a pessoa com um ambiente que não sobe.
		if (atual.existe && !atual.rodando) {
			const ligou = await correr(alvo, ['start', nome], log);
			if (ligou.codigo !== 0) {
				if (/address already in use|port is already allocated/i.test(ligou.saida)) {
					log('\r\n\x1b[33mA porta reservada está ocupada; refazendo o container em outra.\x1b[0m\r\n');
					await correr(alvo, ['rm', '-f', nome], log);
					atual = { existe: false, rodando: false };
				} else {
					return { ok: false, erro: 'O container não subiu. Veja o log.' };
				}
			} else {
				atual = { existe: true, rodando: true };
			}
		}

		if (!atual.existe) {
			// A imagem vem do primeiro registro que responder.
			let imagem: string | null = null;
			for (const registro of plano.image.includes('/') ? [''] : REGISTROS) {
				const completa = registro ? `${registro}/${plano.image}` : plano.image;
				const puxou = await correr(alvo, ['pull', completa], log);
				if (puxou.codigo === 0) {
					imagem = completa;
					break;
				}
				log(`\x1b[33mNão deu por ${registro || 'esse registro'}; tentando outro…\x1b[0m\r\n`);
			}
			if (!imagem) return { ok: false, erro: `Não deu para baixar a imagem ${plano.image}.` };

			// A pasta do projeto é montada no container: os mesmos arquivos que o
			// editor e o git enxergam. `:Z` é o que o SELinux do Fedora exige.
			const volume = process.platform === 'linux' ? `${pedido.pasta}:/workspace:Z` : `${pedido.pasta}:/workspace`;
			const hostPorta = await portaLivre(plano.port);
			if (hostPorta !== plano.port) {
				log(`\x1b[2mA porta ${plano.port} está ocupada aqui; publicando em ${hostPorta}.\x1b[0m\r\n`);
			}
			// App de janela desenha na tela desta máquina; os outros só publicam porta.
			const tela = plano.gui ? argumentosDeTela() : [];
			if (plano.gui && tela.length === 0) {
				log('\x1b[33mSem DISPLAY nesta sessão: a janela do app não terá onde aparecer.\x1b[0m\r\n');
			}
			const criou = await correr(
				alvo,
				[
					'run', '-d', '--name', nome,
					'-v', volume,
					'-w', '/workspace',
					'-p', `${hostPorta}:${plano.port}`,
					...tela,
					imagem,
					// 'sleep infinity' não existe no busybox: este laço segura
					// qualquer imagem de pé.
					'sh', '-c', 'while :; do sleep 3600; done'
				],
				log
			);
			if (criou.codigo !== 0) return { ok: false, erro: 'Não deu para criar o container.' };
		} else if (!atual.rodando) {
			await correr(alvo, ['start', nome], log);
		}

		await correr(alvo, [
			'exec', nome, 'sh', '-lc',
			'git config --global --add safe.directory /workspace 2>/dev/null || true'
		]);

		if (plano.gui) {
			log('\r\n\x1b[1mInstalando as bibliotecas gráficas\x1b[0m \x1b[2m(um app de janela precisa delas)\x1b[0m\r\n');
			await correr(alvo, ['exec', '-u', '0', nome, 'sh', '-lc', LIBS_GUI], log);
		}

		for (const comando of plano.setup) {
			log(`\r\n\x1b[1mInstalando dependências\x1b[0m\r\n`);
			const instalou = await correr(alvo, ['exec', nome, 'sh', '-lc', `cd /workspace && ${comando}`], log);
			if (instalou.codigo !== 0) {
				log('\r\n\x1b[33mA instalação terminou com erro. Dá para continuar e resolver no terminal.\x1b[0m\r\n');
			}
		}

		const publicada = (await portaPublicada(alvo, nome)) ?? plano.port;
		log('\r\n\x1b[32mAmbiente pronto.\x1b[0m As abas do terminal passam a abrir dentro dele.\r\n');
		return { ok: true, nome, porta: publicada };
	});

	/**
	 * Sobe o projeto dentro do container (o `npm run dev` da vida).
	 *
	 * Faltava isto: montar o ambiente instalava as dependências e parava por
	 * aí, então o endereço do projeto não respondia e a tela ficava carregando
	 * para sempre. O processo fica vivo aqui, e o log vai para a tela como o de
	 * qualquer terminal.
	 */
	ipcMain.handle('ambiente:rodar', async (_evento, bruto: unknown) => {
		const { slug, comando } = (bruto ?? {}) as { slug?: string; comando?: string };
		const alvo = motor();
		if (!alvo || !slug || !comando) return { ok: false, erro: 'pedido incompleto' };
		const nome = nomeDo(slug);

		if (rodando.has(nome)) return { ok: true, jaRodando: true };
		// Um container parado não responde em porta nenhuma.
		const atual = await estado(nome);
		if (!atual.existe) return { ok: false, erro: 'Monte o ambiente antes de rodar.' };
		if (!atual.rodando) await correr(alvo, ['start', nome], log);

		log(`\r\n\x1b[1mSubindo o projeto\x1b[0m \x1b[2m(${comando})\x1b[0m\r\n`);
		// `-i` mantém o processo preso a este, para pará-lo depois; o HOST 0.0.0.0
		// é o que faz o servidor do projeto aceitar conexão de fora do container.
		const processo = spawn(alvo, [
			'exec', '-i',
			'-e', 'HOST=0.0.0.0',
			'-e', 'PORT=' + String((bruto as { porta?: number }).porta ?? 3000),
			// Para app de janela: o Electron precisa saber onde desenhar e que o
			// sandbox dele não vai funcionar aqui dentro.
			...(process.env.DISPLAY ? ['-e', `DISPLAY=${process.env.DISPLAY}`] : []),
			'-e', 'ELECTRON_DISABLE_SANDBOX=1',
			nome, 'sh', '-lc', `cd /workspace && ${comando}`
		]);
		rodando.set(nome, processo);
		const receber = (dados: Buffer) => log(dados.toString().replace(/\n/g, '\r\n'));
		processo.stdout?.on('data', receber);
		processo.stderr?.on('data', receber);
		processo.on('close', (codigo) => {
			rodando.delete(nome);
			log(`\r\n\x1b[2m[o projeto parou (código ${codigo ?? 0})]\x1b[0m\r\n`);
		});
		return { ok: true };
	});

	ipcMain.handle('ambiente:parar', async (_evento, bruto: unknown) => {
		const { slug } = (bruto ?? {}) as { slug?: string };
		if (!slug) return { ok: false };
		const nome = nomeDo(slug);
		rodando.get(nome)?.kill();
		rodando.delete(nome);
		// O processo dentro do container não morre junto: derruba pelo nome.
		const alvo = motor();
		if (alvo) await correr(alvo, ['exec', nome, 'sh', '-lc', 'pkill -f node || true']);
		return { ok: true };
	});

	ipcMain.handle('ambiente:remover', async (_evento, bruto: unknown) => {
		const { slug } = (bruto ?? {}) as { slug?: string };
		const alvo = motor();
		if (!alvo || !slug) return { ok: false };
		await correr(alvo, ['rm', '-f', nomeDo(slug)], log);
		return { ok: true };
	});
}
