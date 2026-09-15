/**
 * O que a casca precisa saber antes de abrir a janela: onde o app mora e as
 * flags de desenvolvimento. `--url=` vence `RAWLY_URL`, que vence a produção.
 */

export const PRODUCTION_URL = 'https://rawly-ten.vercel.app';

export interface DesktopConfig {
	/** Endereço do app; só esta origem carrega dentro da janela. */
	appUrl: URL;
	/** `--dev`: ferramentas de desenvolvimento no menu e sem atualização automática. */
	dev: boolean;
	/** `--screenshot=<caminho>`: captura a janela depois de carregar e sai (sem `--keep`). */
	screenshotPath: string | null;
	keepOpen: boolean;
}

function argValue(name: string): string | null {
	const prefix = `--${name}=`;
	const hit = process.argv.find((arg) => arg.startsWith(prefix));
	return hit ? hit.slice(prefix.length) : null;
}

export function readConfig(): DesktopConfig {
	const raw = argValue('url') ?? process.env.RAWLY_URL ?? PRODUCTION_URL;
	let appUrl: URL;
	try {
		appUrl = new URL(raw);
	} catch {
		console.warn(`[rawly] endereço inválido "${raw}", usando a produção`);
		appUrl = new URL(PRODUCTION_URL);
	}
	return {
		appUrl,
		dev: process.argv.includes('--dev'),
		screenshotPath: argValue('screenshot'),
		keepOpen: process.argv.includes('--keep')
	};
}

/** A URL é da origem do app (mesmo esquema, host e porta)? */
export function isAppUrl(url: string, appUrl: URL): boolean {
	try {
		return new URL(url).origin === appUrl.origin;
	} catch {
		return false;
	}
}
