import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, writeFileSync } from 'node:fs';
import { access, constants, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { app, dialog, net, type BrowserWindow } from 'electron';
import { autoUpdater, type UpdateInfo } from 'electron-updater';
import { bundleUpdateBlocker, macBundleOf, macSwapScript, pickMacZip } from './mac-update-plan';

/**
 * Atualização no Mac sem a assinatura da Apple (pedido em 16/09/2026). O
 * atualizador padrão do Mac (Squirrel) recusa app sem assinatura, então quem
 * usava o Mac tinha de baixar o `.dmg` e trocar o app à mão a cada versão.
 *
 * Aqui o `electron-updater` só lê o `latest-mac.yml` do site. O resto é nosso:
 * baixa o `.zip` da arquitetura, confere o sha512 do feed, extrai com o `ditto`
 * do macOS e pergunta se reinicia. Na resposta, um script espera o app fechar,
 * troca o `Rawly.app` em Aplicativos (devolvendo o antigo se a troca falhar) e
 * abre de novo. "Depois" troca ao sair, sem reabrir.
 *
 * O app trocado é um executável novo para o macOS: a permissão de
 * Acessibilidade do controle da tela precisa ser ligada de novo.
 */

const FEED_URL = 'https://rawly-ten.vercel.app/downloads/desktop/';

interface Prepared {
	version: string;
	bundle: string;
	newBundle: string;
	workDir: string;
}

let prepared: Prepared | null = null;
let preparing: string | null = null;
let swapping = false;

function log(...args: unknown[]): void {
	console.log('[rawly/atualização mac]', ...args);
}

function run(command: string, args: string[]): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { stdio: 'ignore' });
		child.on('error', reject);
		child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${command} saiu com ${code}`))));
	});
}

/** Baixa para `target` conferindo o sha512 (base64) e o tamanho do feed. */
async function download(url: string, target: string, sha512: string, size?: number): Promise<void> {
	const response = await net.fetch(url);
	if (!response.ok || !response.body) throw new Error(`download respondeu ${response.status}`);
	const hash = createHash('sha512');
	const file = createWriteStream(target);
	let bytes = 0;
	const reader = response.body.getReader();
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			hash.update(value);
			bytes += value.byteLength;
			if (!file.write(value)) await new Promise<void>((resolve) => file.once('drain', resolve));
		}
	} finally {
		await new Promise<void>((resolve, reject) => file.end((err?: Error | null) => (err ? reject(err) : resolve())));
	}
	if (size && bytes !== size) throw new Error(`tamanho ${bytes}, esperado ${size}`);
	if (hash.digest('base64') !== sha512) throw new Error('sha512 não confere');
}

async function prepare(info: UpdateInfo): Promise<void> {
	if (preparing === info.version || prepared?.version === info.version) return;
	const bundle = macBundleOf(app.getPath('exe'));
	if (!bundle) return log('fora de um pacote .app: sem atualização');
	const blocker = bundleUpdateBlocker(bundle);
	if (blocker) return log(blocker);
	try {
		await access(path.dirname(bundle), constants.W_OK);
	} catch {
		return log(`sem permissão para gravar em ${path.dirname(bundle)}: sem atualização`);
	}
	const zip = pickMacZip(info.files ?? [], process.arch);
	if (!zip) return log('o feed não tem o .zip desta arquitetura');

	preparing = info.version;
	const workDir = await mkdtemp(path.join(tmpdir(), 'rawly-atualizacao-'));
	try {
		const zipPath = path.join(workDir, 'Rawly.zip');
		const url = new URL(zip.url, String(autoUpdater.getFeedURL() ?? FEED_URL)).toString();
		log(`baixando ${info.version}: ${url}`);
		await download(url, zipPath, zip.sha512, zip.size);
		const extractDir = path.join(workDir, 'novo');
		await run('/usr/bin/ditto', ['-x', '-k', zipPath, extractDir]);
		const app_ = (await readdir(extractDir)).find((name) => name.endsWith('.app'));
		if (!app_) throw new Error('o .zip não tem um .app');
		await rm(zipPath, { force: true });
		if (prepared) await rm(prepared.workDir, { recursive: true, force: true });
		prepared = { version: info.version, bundle, newBundle: path.join(extractDir, app_), workDir };
		log(`versão ${info.version} pronta em ${prepared.newBundle}`);
	} catch (err) {
		log('falhou ao preparar:', err instanceof Error ? err.message : err);
		await rm(workDir, { recursive: true, force: true });
		throw err;
	} finally {
		preparing = null;
	}
}

/** Solta o script de troca, desligado do app, e deixa o app sair. Síncrono: no `will-quit` não dá tempo de esperar. */
function swap(reopen: boolean): void {
	if (!prepared || swapping) return;
	swapping = true;
	const script = path.join(prepared.workDir, 'trocar.sh');
	writeFileSync(
		script,
		macSwapScript({ pid: process.pid, bundle: prepared.bundle, newBundle: prepared.newBundle, workDir: prepared.workDir, reopen }),
		{ mode: 0o700 }
	);
	const child = spawn('/bin/bash', [script], { detached: true, stdio: 'ignore' });
	child.unref();
	log(`trocando pela ${prepared.version}${reopen ? ' e abrindo de novo' : ' ao sair'}`);
}

async function askToRestart(version: string, win: BrowserWindow | null): Promise<void> {
	const options: Electron.MessageBoxOptions = {
		type: 'info',
		title: 'Nova versão pronta',
		message: `A versão ${version} do Rawly está pronta.`,
		detail: 'Reinicie agora para usar, ou deixe para quando fechar o app.',
		buttons: ['Reiniciar agora', 'Depois'],
		defaultId: 0,
		cancelId: 1,
		noLink: true
	};
	const { response } =
		win && !win.isDestroyed() ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
	if (response !== 0) return;
	swap(true);
	app.quit();
}

export function startMacUpdater(opts: { getWindow: () => BrowserWindow | null }): () => void {
	autoUpdater.autoDownload = false;
	autoUpdater.autoInstallOnAppQuit = false;
	autoUpdater.on('update-available', (info) => {
		void prepare(info)
			.then(() => {
				if (prepared?.version === info.version) return askToRestart(info.version, opts.getWindow());
			})
			.catch(() => undefined);
	});
	// "Depois": troca ao sair, sem abrir de novo.
	app.on('will-quit', () => {
		if (prepared && !swapping) swap(false);
	});
	return () => {
		autoUpdater.checkForUpdates().catch((err: unknown) => {
			log('falha ao checar:', err instanceof Error ? err.message : err);
		});
	};
}
