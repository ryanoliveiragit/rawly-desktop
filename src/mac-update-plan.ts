/**
 * As contas do atualizador próprio do Mac (`mac-updater.ts`), sem Electron, para
 * o teste rodar no Node: qual zip baixar, onde está o `Rawly.app` que roda, se
 * dá para trocá-lo ali e o script que faz a troca depois que o app fecha.
 */

export interface FeedFile {
	url: string;
	sha512: string;
	size?: number;
}

/** O zip da arquitetura do Mac (`Rawly-mac-arm64.zip` ou `Rawly-mac-x64.zip`); o `.dmg` não serve para trocar o app. */
export function pickMacZip(files: readonly FeedFile[], arch: string): FeedFile | null {
	const wanted = arch === 'arm64' ? 'arm64' : 'x64';
	return files.find((file) => file.url.endsWith('.zip') && file.url.includes(`-${wanted}.`)) ?? null;
}

/** `/Applications/Rawly.app/Contents/MacOS/Rawly` → `/Applications/Rawly.app`; fora de um pacote `.app`, nulo. */
export function macBundleOf(exePath: string): string | null {
	const match = /^(.*?\.app)\/Contents\/MacOS\/[^/]+$/.exec(exePath);
	return match?.[1] ?? null;
}

/**
 * Por que não dá para trocar o app onde ele está, ou nulo quando dá. Aberto de
 * dentro do `.dmg` (em `/Volumes`) ou pela "translocação" do macOS (app baixado
 * e aberto sem mover para Aplicativos), a pasta é só leitura ou some ao fechar.
 */
export function bundleUpdateBlocker(bundle: string): string | null {
	if (bundle.startsWith('/Volumes/')) {
		return 'O Rawly está aberto de dentro do instalador: arraste-o para Aplicativos e abra de lá para ele se atualizar sozinho.';
	}
	if (bundle.includes('/AppTranslocation/')) {
		return 'O Rawly está aberto fora de Aplicativos: arraste-o para Aplicativos e abra de lá para ele se atualizar sozinho.';
	}
	return null;
}

/** Aspas simples do shell: o caminho entra no script do jeito que é, com espaço ou acento. */
export function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * O script que troca o app: espera o Rawly fechar, põe o atual de lado, move o
 * novo para o lugar (se falhar, devolve o antigo), tira a quarentena do macOS e
 * abre de novo. Nada é apagado antes de o novo estar no lugar.
 */
export function macSwapScript({
	pid,
	bundle,
	newBundle,
	workDir,
	reopen
}: {
	pid: number;
	bundle: string;
	newBundle: string;
	workDir: string;
	reopen: boolean;
}): string {
	const current = shellQuote(bundle);
	const fresh = shellQuote(newBundle);
	const backup = shellQuote(`${bundle}.anterior`);
	return [
		'#!/bin/bash',
		'# Rawly: troca o app pela versão nova depois que ele fecha.',
		`while kill -0 ${Math.trunc(pid)} 2>/dev/null; do sleep 0.2; done`,
		`rm -rf ${backup}`,
		`if mv ${current} ${backup}; then`,
		`\tif mv ${fresh} ${current}; then`,
		`\t\txattr -dr com.apple.quarantine ${current} 2>/dev/null`,
		`\t\trm -rf ${backup}`,
		'\telse',
		`\t\tmv ${backup} ${current}`,
		'\tfi',
		'fi',
		reopen ? `open ${current}` : ':',
		`rm -rf ${shellQuote(workDir)}`,
		''
	].join('\n');
}
