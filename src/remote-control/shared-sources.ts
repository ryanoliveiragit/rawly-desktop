/**
 * As fontes escolhidas no seletor de "Compartilhar tela", da mais antiga para a mais nova. O
 * site casa cada faixa publicada com uma delas pelo horário (`at`) e pede o controle daquela
 * tela. Sem Electron: roda nos testes com `node --test`.
 */
import { screenIdFromSourceId } from './geometry';
import type { RemoteControlSharedSource } from './protocol';

/** O que importa de um `DesktopCapturerSource`. */
export interface CapturedSource {
	id: string;
	name: string;
	display_id: string;
}

export class SharedSourceRegistry {
	private items: RemoteControlSharedSource[] = [];

	constructor(
		private readonly limit = 12,
		private readonly now: () => number = Date.now
	) {}

	/** Escolher a mesma fonte de novo a leva para o fim, com o horário novo. */
	record(source: CapturedSource): RemoteControlSharedSource {
		const entry: RemoteControlSharedSource = {
			sourceId: source.id,
			displayId: source.display_id || null,
			name: source.name,
			at: this.now()
		};
		this.items = [...this.items.filter((item) => item.sourceId !== source.id), entry].slice(-this.limit);
		return entry;
	}

	list(): RemoteControlSharedSource[] {
		return this.items.map((item) => ({ ...item }));
	}

	find(sourceId: string): RemoteControlSharedSource | null {
		return this.items.find((item) => item.sourceId === sourceId) ?? null;
	}

	/** A tela inteira escolhida por último (janelas não contam). */
	latestScreen(): RemoteControlSharedSource | null {
		for (let index = this.items.length - 1; index >= 0; index -= 1) {
			const item = this.items[index]!;
			if (screenIdFromSourceId(item.sourceId) !== null) return item;
		}
		return null;
	}
}
