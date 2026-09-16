/**
 * O que os dois jeitos de injetar entrada (nativo e portal do Wayland) têm em comum: a fila que
 * mantém a ordem dos eventos e junta movimentos acumulados, e o registro do que está apertado,
 * para soltar tudo ao parar (ninguém fica com Ctrl ou o botão do mouse presos). Sem Electron:
 * roda nos testes com `node --test`.
 */
import { isModifierCode } from './keymap';
import type { MouseButton, RemoteBackendKind, RemoteInput } from './protocol';

/** Erro com mensagem pronta para a tela (pt-BR); qualquer outro vira uma mensagem genérica. */
export class ControlError extends Error {
	override readonly name = 'ControlError';
}

export interface InputBackend {
	readonly kind: RemoteBackendKind;
	/** Aplica um evento já validado. Lançar erro encerra a sessão. */
	apply(event: RemoteInput): void | Promise<void>;
	/** Solta o que ficou apertado e libera o sistema. Não lança. */
	close(): Promise<void>;
}

/**
 * Teclas e botões apertados por quem controla. `press` diz se o evento segue para o sistema:
 * soltar o que não foi apertado aqui é descartado.
 */
export class PressedState {
	private readonly keys = new Set<string>();
	private readonly buttons = new Set<MouseButton>();

	key(code: string, down: boolean): boolean {
		if (down) {
			this.keys.add(code);
			return true;
		}
		return this.keys.delete(code);
	}

	button(button: MouseButton, down: boolean): boolean {
		if (down) {
			this.buttons.add(button);
			return true;
		}
		return this.buttons.delete(button);
	}

	heldKeys(): string[] {
		return [...this.keys];
	}

	heldButtons(): MouseButton[] {
		return [...this.buttons];
	}

	/** Esvazia e devolve o que soltar: botões, depois teclas comuns, modificadoras por último. */
	drain(): { buttons: MouseButton[]; keys: string[] } {
		const keys = [...this.keys].reverse();
		const buttons = [...this.buttons];
		this.keys.clear();
		this.buttons.clear();
		return {
			buttons,
			keys: [...keys.filter((code) => !isModifierCode(code)), ...keys.filter((code) => isModifierCode(code))]
		};
	}
}

/**
 * Aplica os eventos um de cada vez, na ordem. Enquanto um evento espera (o portal responde por
 * D-Bus), movimentos seguidos na fila viram só o último. Um erro para a fila e avisa uma vez.
 */
export class InputQueue {
	private pending: RemoteInput[] = [];
	private running: Promise<void> | null = null;
	private closed = false;
	private warnedFull = false;

	constructor(
		private readonly apply: (event: RemoteInput) => void | Promise<void>,
		private readonly onError: (error: unknown) => void,
		private readonly limit = 500
	) {}

	get size(): number {
		return this.pending.length;
	}

	push(event: RemoteInput): void {
		if (this.closed) return;
		const last = this.pending[this.pending.length - 1];
		if (event.type === 'move' && last?.type === 'move') {
			this.pending[this.pending.length - 1] = event;
		} else if (this.pending.length >= this.limit) {
			if (!this.warnedFull) console.warn('[rawly] controle remoto: fila cheia, descartando eventos');
			this.warnedFull = true;
			return;
		} else {
			this.pending.push(event);
		}
		this.running ??= this.drain();
	}

	private async drain(): Promise<void> {
		try {
			while (!this.closed && this.pending.length > 0) {
				const next = this.pending.shift()!;
				await this.apply(next);
			}
		} catch (error) {
			this.closed = true;
			this.pending = [];
			this.onError(error);
		} finally {
			this.running = null;
		}
	}

	/** Para de aceitar eventos, descarta os que não começaram e espera o que está em curso. */
	async close(): Promise<void> {
		this.closed = true;
		this.pending = [];
		await this.running;
	}
}
