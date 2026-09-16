/**
 * O contrato da ponte `window.rawlyDesktop.control` (docs/controle-remoto.md) e a validação do
 * que chega do site. Tudo que vem da página passa por aqui antes de virar mouse ou teclado.
 * Sem Electron: roda nos testes com `node --test`.
 */

export type RemoteBackendKind = 'native' | 'wayland-portal';

export interface RemoteControlCapabilities {
	/** Dá para injetar entrada neste computador agora? */
	available: boolean;
	platform: 'win32' | 'darwin' | 'linux';
	backend: RemoteBackendKind | null;
	/** Por que não (em pt-BR, para a tela). */
	reason?: string;
	/**
	 * Só falta a permissão do sistema (Acessibilidade no Mac): o site deixa pedir o controle, e é o
	 * `start()` que explica a permissão e abre os Ajustes.
	 */
	needsPermission?: boolean;
}

export type MouseButton = 'left' | 'middle' | 'right';
export type PressAction = 'down' | 'up';

export type RemoteInput =
	/** Posição absoluta na tela compartilhada, de 0 a 1 (0,0 = canto de cima à esquerda). */
	| { type: 'move'; x: number; y: number }
	| { type: 'button'; button: MouseButton; action: PressAction; x: number; y: number }
	/** Rolagem em pixels (deltaMode já convertido), com a posição do cursor. */
	| { type: 'wheel'; dx: number; dy: number; x: number; y: number }
	/** `KeyboardEvent.code` e `KeyboardEvent.key` de quem controla. */
	| { type: 'key'; code: string; key: string; action: PressAction };

export interface RemoteControlSharedSource {
	/** Id do `desktopCapturer` ("screen:1:0"). */
	sourceId: string;
	/** `display_id` do Electron, quando a fonte é uma tela inteira. */
	displayId: string | null;
	name: string;
	/** Quando foi escolhida no seletor (ms). */
	at: number;
}

export type StartResult = { ok: true } | { ok: false; error: string };

export type StopReason = 'user' | 'shortcut' | 'error' | 'closed';

export interface StartOptions {
	controllerName: string;
	sourceId: string | null;
}

/** Uma rolagem maior que isso num evento só é lixo (ou abuso). */
const MAX_WHEEL_PX = 4000;
const MAX_NAME = 60;
const CODE_PATTERN = /^[A-Za-z0-9]{1,32}$/;

function record(value: unknown): Record<string, unknown> | null {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function finite(value: unknown): number | null {
	return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function unit(value: unknown): number | null {
	const n = finite(value);
	return n === null ? null : Math.min(1, Math.max(0, n));
}

function action(value: unknown): PressAction | null {
	return value === 'down' || value === 'up' ? value : null;
}

/** Valida um evento vindo do site; `null` descarta. Coordenadas saem presas entre 0 e 1. */
export function parseRemoteInput(value: unknown): RemoteInput | null {
	const event = record(value);
	if (!event) return null;
	switch (event.type) {
		case 'move': {
			const x = unit(event.x);
			const y = unit(event.y);
			return x === null || y === null ? null : { type: 'move', x, y };
		}
		case 'button': {
			const x = unit(event.x);
			const y = unit(event.y);
			const press = action(event.action);
			const button = event.button;
			if (x === null || y === null || !press) return null;
			if (button !== 'left' && button !== 'middle' && button !== 'right') return null;
			return { type: 'button', button, action: press, x, y };
		}
		case 'wheel': {
			const x = unit(event.x);
			const y = unit(event.y);
			const dx = finite(event.dx);
			const dy = finite(event.dy);
			if (x === null || y === null || dx === null || dy === null) return null;
			const clamp = (n: number) => Math.min(MAX_WHEEL_PX, Math.max(-MAX_WHEEL_PX, n));
			return { type: 'wheel', dx: clamp(dx), dy: clamp(dy), x, y };
		}
		case 'key': {
			const press = action(event.action);
			const code = event.code;
			const key = typeof event.key === 'string' ? event.key.slice(0, 32) : '';
			if (!press || typeof code !== 'string' || !CODE_PATTERN.test(code)) return null;
			return { type: 'key', code, key, action: press };
		}
		default:
			return null;
	}
}

/** O nome de quem controla, para a faixa: uma linha, sem controle, com limite. */
export function controllerLabel(value: unknown): string {
	const text = typeof value === 'string' ? value.replace(/[\p{Cc}\p{Cf}]+/gu, ' ').replace(/\s+/g, ' ').trim() : '';
	return text ? Array.from(text).slice(0, MAX_NAME).join('') : 'Alguém';
}

export function parseStartOptions(value: unknown): StartOptions {
	const options = record(value) ?? {};
	const sourceId = typeof options.sourceId === 'string' && options.sourceId.length <= 128 ? options.sourceId : null;
	return { controllerName: controllerLabel(options.controllerName), sourceId };
}
