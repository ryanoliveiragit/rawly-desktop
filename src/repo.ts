/**
 * O projeto no disco: ler, salvar e falar com o git — tudo na pasta que o app
 * mantém (22/09/2026: "quero editar o código dentro do Rawly e o container
 * entender o que eu modifiquei, subir no dev que eu startei, e depois criar o
 * PR").
 *
 * É o que fecha o ciclo de uma IDE. Antes o editor da tela gravava pela API do
 * GitHub: virava commit num ramo e o container, que monta a pasta local, não
 * via nada — o servidor de desenvolvimento continuava servindo o código
 * antigo. Agora salvar escreve o arquivo aqui; o container enxerga na hora
 * (mesma pasta montada) e recarrega sozinho, como faria no seu editor.
 *
 * Commit e envio viram passos explícitos, como em qualquer IDE: primeiro você
 * vê rodando, depois decide o que vira pull request.
 */
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, normalize, resolve, sep } from 'node:path';
import { ipcMain } from 'electron';

/** Nada fora da pasta do projeto: o caminho vem da tela. */
function dentro(pasta: string, caminho: string): string | null {
	const base = resolve(pasta);
	const alvo = resolve(base, normalize(caminho));
	return alvo === base || alvo.startsWith(base + sep) ? alvo : null;
}

const CREDENCIAL = '!f() { echo username=x-access-token; echo "password=$RAWLY_GIT_TOKEN"; }; f';

function git(
	pasta: string,
	argumentos: string[],
	opcoes: { token?: string; entrada?: string } = {}
): Promise<{ ok: boolean; saida: string }> {
	return new Promise((resolve) => {
		const processo = spawn('git', argumentos, {
			cwd: pasta,
			env: opcoes.token ? { ...process.env, RAWLY_GIT_TOKEN: opcoes.token } : process.env
		});
		let saida = '';
		processo.stdout.on('data', (p) => (saida += p));
		processo.stderr.on('data', (p) => (saida += p));
		processo.on('error', (erro) => resolve({ ok: false, saida: erro.message }));
		processo.on('close', (codigo) => resolve({ ok: codigo === 0, saida }));
		if (opcoes.entrada !== undefined) {
			processo.stdin.write(opcoes.entrada);
			processo.stdin.end();
		}
	});
}

export interface ArquivoMudado {
	path: string;
	/** Duas letras do porcelain do git: ` M`, `A `, `??`, `D `… */
	estado: string;
	diff: string | null;
}

export function registerRepo(): void {
	ipcMain.handle('repo:ler', async (_e, bruto: unknown) => {
		const { pasta, caminho } = (bruto ?? {}) as { pasta?: string; caminho?: string };
		if (!pasta || !caminho) return { ok: false, erro: 'pedido incompleto' };
		const alvo = dentro(pasta, caminho);
		if (!alvo) return { ok: false, erro: 'caminho fora do projeto' };
		try {
			const conteudo = await readFile(alvo, 'utf8');
			return { ok: true, conteudo };
		} catch (erro) {
			return { ok: false, erro: erro instanceof Error ? erro.message : 'não deu para ler' };
		}
	});

	ipcMain.handle('repo:salvar', async (_e, bruto: unknown) => {
		const { pasta, caminho, conteudo } = (bruto ?? {}) as {
			pasta?: string;
			caminho?: string;
			conteudo?: string;
		};
		if (!pasta || !caminho || typeof conteudo !== 'string') return { ok: false, erro: 'pedido incompleto' };
		const alvo = dentro(pasta, caminho);
		if (!alvo) return { ok: false, erro: 'caminho fora do projeto' };
		try {
			await mkdir(dirname(alvo), { recursive: true });
			await writeFile(alvo, conteudo, 'utf8');
			return { ok: true };
		} catch (erro) {
			return { ok: false, erro: erro instanceof Error ? erro.message : 'não deu para salvar' };
		}
	});

	/** O `git status` da pasta, com o diff de cada arquivo tocado. */
	ipcMain.handle('repo:status', async (_e, bruto: unknown) => {
		const { pasta } = (bruto ?? {}) as { pasta?: string };
		if (!pasta) return { ok: false };
		const ramo = await git(pasta, ['rev-parse', '--abbrev-ref', 'HEAD']);
		const estado = await git(pasta, ['status', '--porcelain=v1']);
		if (!estado.ok) return { ok: false, erro: estado.saida.slice(-300) };

		const arquivos: ArquivoMudado[] = [];
		for (const linha of estado.saida.split('\n')) {
			if (!linha.trim()) continue;
			const marca = linha.slice(0, 2);
			const caminho = linha.slice(3).trim().replace(/^"|"$/g, '');
			// Arquivo novo não tem diff contra nada: o conteúdo é a novidade.
			const diff = marca.includes('?')
				? null
				: (await git(pasta, ['diff', 'HEAD', '--', caminho])).saida.slice(0, 20000);
			arquivos.push({ path: caminho, estado: marca, diff });
		}

		// O que já foi confirmado aqui e ainda não foi para o GitHub.
		const aFrente = await git(pasta, ['rev-list', '--count', '@{upstream}..HEAD']).catch(() => ({
			ok: false,
			saida: '0'
		}));
		return {
			ok: true,
			ramo: ramo.saida.trim(),
			arquivos,
			porEnviar: Number.parseInt(aFrente.saida.trim(), 10) || 0
		};
	});

	ipcMain.handle('repo:descartar', async (_e, bruto: unknown) => {
		const { pasta, caminho } = (bruto ?? {}) as { pasta?: string; caminho?: string };
		if (!pasta || !caminho) return { ok: false };
		// Arquivo versionado volta ao que era; arquivo novo é apagado.
		const versionado = await git(pasta, ['ls-files', '--error-unmatch', caminho]);
		const feito = versionado.ok
			? await git(pasta, ['checkout', '--', caminho])
			: await git(pasta, ['clean', '-f', '--', caminho]);
		return { ok: feito.ok, erro: feito.ok ? undefined : feito.saida.slice(-300) };
	});

	ipcMain.handle('repo:ramos', async (_e, bruto: unknown) => {
		const { pasta } = (bruto ?? {}) as { pasta?: string };
		if (!pasta) return { ok: false };
		const atual = await git(pasta, ['rev-parse', '--abbrev-ref', 'HEAD']);
		const lista = await git(pasta, ['branch', '--format=%(refname:short)']);
		return {
			ok: true,
			atual: atual.saida.trim(),
			ramos: lista.saida.split('\n').map((l) => l.trim()).filter(Boolean)
		};
	});

	ipcMain.handle('repo:criar-ramo', async (_e, bruto: unknown) => {
		const { pasta, nome } = (bruto ?? {}) as { pasta?: string; nome?: string };
		if (!pasta || !nome) return { ok: false };
		const feito = await git(pasta, ['checkout', '-b', nome]);
		return { ok: feito.ok, erro: feito.ok ? undefined : feito.saida.slice(-300) };
	});

	ipcMain.handle('repo:trocar-ramo', async (_e, bruto: unknown) => {
		const { pasta, nome } = (bruto ?? {}) as { pasta?: string; nome?: string };
		if (!pasta || !nome) return { ok: false };
		const feito = await git(pasta, ['checkout', nome]);
		return { ok: feito.ok, erro: feito.ok ? undefined : feito.saida.slice(-300) };
	});

	/** Confirma tudo que está mudado, com a autoria de quem está no Rawly. */
	ipcMain.handle('repo:confirmar', async (_e, bruto: unknown) => {
		const { pasta, mensagem, autor, email } = (bruto ?? {}) as {
			pasta?: string;
			mensagem?: string;
			autor?: string;
			email?: string;
		};
		if (!pasta || !mensagem?.trim()) return { ok: false, erro: 'Escreva a mensagem do commit.' };
		const juntou = await git(pasta, ['add', '-A']);
		if (!juntou.ok) return { ok: false, erro: juntou.saida.slice(-300) };
		const feito = await git(pasta, [
			'-c', `user.name=${autor || 'Rawly'}`,
			'-c', `user.email=${email || 'rawly@rawlyapp.com.br'}`,
			'commit', '-m', mensagem.trim()
		]);
		return { ok: feito.ok, erro: feito.ok ? undefined : feito.saida.slice(-400) };
	});

	/** Envia o ramo para o GitHub, com o token curto que o Rawly deu. */
	ipcMain.handle('repo:enviar', async (_e, bruto: unknown) => {
		const { pasta, token, ramo } = (bruto ?? {}) as { pasta?: string; token?: string; ramo?: string };
		if (!pasta || !token) return { ok: false, erro: 'pedido incompleto' };
		const alvo = ramo?.trim() || (await git(pasta, ['rev-parse', '--abbrev-ref', 'HEAD'])).saida.trim();
		const feito = await git(
			pasta,
			['-c', `credential.helper=${CREDENCIAL}`, 'push', '-u', 'origin', `HEAD:${alvo}`],
			{ token }
		);
		return { ok: feito.ok, ramo: alvo, erro: feito.ok ? undefined : feito.saida.slice(-400) };
	});

	/** A árvore de arquivos do projeto, do jeito que o git a enxerga. */
	ipcMain.handle('repo:arvore', async (_e, bruto: unknown) => {
		const { pasta } = (bruto ?? {}) as { pasta?: string };
		if (!pasta) return { ok: false };
		// Versionados e não-ignorados: é o que interessa e já pula node_modules.
		const lista = await git(pasta, ['ls-files', '--cached', '--others', '--exclude-standard']);
		if (!lista.ok) return { ok: false, erro: lista.saida.slice(-300) };
		return {
			ok: true,
			arquivos: lista.saida.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 20000)
		};
	});

	/** Busca no conteúdo, na pasta — o grep que a lupa da tela usa no app. */
	ipcMain.handle('repo:buscar', async (_e, bruto: unknown) => {
		const { pasta, termo } = (bruto ?? {}) as { pasta?: string; termo?: string };
		if (!pasta || !termo || termo.length < 2) return { ok: true, resultados: [] };
		// `git grep` respeita o .gitignore e é rápido mesmo em repositório grande.
		const achado = await git(pasta, [
			'grep', '-n', '-I', '--untracked', '--ignore-case', '--max-count=8', '-e', termo
		]);
		const resultados = achado.saida
			.split('\n')
			.map((linha) => {
				const partes = /^(.+?):(\d+):(.*)$/.exec(linha);
				if (!partes?.[1] || !partes[2]) return null;
				return {
					path: partes[1],
					linha: Number(partes[2]),
					texto: (partes[3] ?? '').trim().slice(0, 200)
				};
			})
			.filter((x): x is { path: string; linha: number; texto: string } => x !== null)
			.slice(0, 200);
		return { ok: true, resultados };
	});
}
