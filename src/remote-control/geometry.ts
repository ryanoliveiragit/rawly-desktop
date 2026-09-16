/**
 * De "0,4 da largura da tela compartilhada" para o ponto que cada sistema entende. Sem
 * Electron: roda nos testes com `node --test`.
 *
 * - A tela certa sai do `display_id` que o `desktopCapturer` deu à fonte escolhida, casado
 *   com o `id` de `screen.getAllDisplays()`.
 * - Mac: pontos globais, iguais aos `bounds` do Electron (DIP).
 * - Windows e X11: pixels físicos. A origem física da tela vem do sistema e o tamanho é
 *   `bounds × scaleFactor`, então a fração cai no pixel exato mesmo com escala de 125% ou 150%.
 * - Wayland (portal): pixels lógicos do stream que o portal devolveu.
 */

export interface Point {
	x: number;
	y: number;
}

export interface Size {
	width: number;
	height: number;
}

export interface Rect extends Point, Size {}

export interface DisplayLike {
	id: number;
	bounds: Rect;
	scaleFactor: number;
}

export function clampUnit(value: number): number {
	return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

/** "screen:1:0" → "1"; janelas ("window:…") e ids estranhos → `null`. */
export function screenIdFromSourceId(sourceId: string | null | undefined): string | null {
	const match = /^screen:([^:]+)(?::|$)/.exec(sourceId ?? '');
	return match?.[1] ?? null;
}

export function isWindowSource(sourceId: string | null | undefined): boolean {
	return (sourceId ?? '').startsWith('window:');
}

export interface DisplayTarget {
	displayId: string | null;
	sourceId: string | null;
}

/**
 * A tela a controlar. `exact` diz se ela saiu da fonte compartilhada (ou é a única que existe);
 * `false` quer dizer "não deu para saber, ficou a principal".
 */
export function pickDisplay<T extends DisplayLike>(
	displays: readonly T[],
	target: DisplayTarget,
	primaryId: number | null
): { display: T; exact: boolean } | null {
	if (displays.length === 0) return null;
	const byId = (id: string | null) => (id ? displays.find((display) => String(display.id) === id) : undefined);
	const exact = byId(target.displayId) ?? byId(screenIdFromSourceId(target.sourceId));
	if (exact) return { display: exact, exact: true };
	if (displays.length === 1) return { display: displays[0]!, exact: true };
	const primary = displays.find((display) => display.id === primaryId) ?? displays[0]!;
	return { display: primary, exact: false };
}

export function distance(a: Point, b: Point): number {
	return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Ponto em DIP (o Mac usa assim): nunca passa da última coluna ou linha da tela. */
export function toDipPoint(x: number, y: number, bounds: Rect): Point {
	const px = bounds.x + clampUnit(x) * bounds.width;
	const py = bounds.y + clampUnit(y) * bounds.height;
	return {
		x: Math.min(px, bounds.x + Math.max(0, bounds.width - 1)),
		y: Math.min(py, bounds.y + Math.max(0, bounds.height - 1))
	};
}

/** Pixel físico inteiro: origem física da tela + fração × tamanho em pixels. */
export function toPhysicalPoint(x: number, y: number, physicalOrigin: Point, bounds: Rect, scaleFactor: number): Point {
	const scale = Number.isFinite(scaleFactor) && scaleFactor > 0 ? scaleFactor : 1;
	const width = Math.max(1, Math.round(bounds.width * scale));
	const height = Math.max(1, Math.round(bounds.height * scale));
	return {
		x: Math.round(physicalOrigin.x) + Math.min(width - 1, Math.floor(clampUnit(x) * width)),
		y: Math.round(physicalOrigin.y) + Math.min(height - 1, Math.floor(clampUnit(y) * height))
	};
}

/**
 * Origem física de uma tela quando o sistema não informa: no X11 o Electron dá
 * `nativeOrigin`; sem ele, a escala é uma só para todas as telas.
 */
export function fallbackPhysicalOrigin(bounds: Rect, scaleFactor: number, nativeOrigin?: Point | null): Point {
	if (nativeOrigin && Number.isFinite(nativeOrigin.x) && Number.isFinite(nativeOrigin.y)) return nativeOrigin;
	const scale = Number.isFinite(scaleFactor) && scaleFactor > 0 ? scaleFactor : 1;
	return { x: Math.round(bounds.x * scale), y: Math.round(bounds.y * scale) };
}

/**
 * `SendInput` com `MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK`: 0–65535 cobre a área de
 * trabalho virtual inteira (todas as telas), em pixels físicos.
 */
export function toVirtualDeskAbsolute(point: Point, virtualScreen: Rect): Point {
	const spanX = Math.max(1, virtualScreen.width - 1);
	const spanY = Math.max(1, virtualScreen.height - 1);
	const clamp = (n: number) => Math.min(65535, Math.max(0, Math.round(n)));
	return {
		x: clamp(((point.x - virtualScreen.x) * 65535) / spanX),
		y: clamp(((point.y - virtualScreen.y) * 65535) / spanY)
	};
}

/** Ponto no stream do portal (pixels lógicos, `double`). */
export function toStreamPoint(x: number, y: number, size: Size): Point {
	return {
		x: Math.min(clampUnit(x) * size.width, Math.max(0, size.width - 1)),
		y: Math.min(clampUnit(y) * size.height, Math.max(0, size.height - 1))
	};
}

/**
 * Junta a rolagem em pixels (sinal do navegador: positivo = para baixo/direita) em passos
 * inteiros de `stepPx`, guardando o resto para o próximo evento. Serve a quem só entende
 * "cliques" de roda (X11, portal) e ao Windows (`stepPx` = 100 / 120 por unidade).
 */
export class WheelAccumulator {
	private restX = 0;
	private restY = 0;

	constructor(private readonly stepPx: number) {}

	push(dx: number, dy: number): Point {
		this.restX += Number.isFinite(dx) ? dx : 0;
		this.restY += Number.isFinite(dy) ? dy : 0;
		const x = this.steps(this.restX);
		const y = this.steps(this.restY);
		this.restX -= x * this.stepPx;
		this.restY -= y * this.stepPx;
		return { x, y };
	}

	/** Passos inteiros, sem perder um passo para o arredondamento (100 ÷ (100/120) = 119,999…). */
	private steps(rest: number): number {
		const raw = rest / this.stepPx;
		const steps = Math.trunc(raw + Math.sign(raw) * 1e-9);
		return steps === 0 ? 0 : steps;
	}

	reset(): void {
		this.restX = 0;
		this.restY = 0;
	}
}
