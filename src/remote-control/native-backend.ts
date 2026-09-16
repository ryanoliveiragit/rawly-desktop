/**
 * Entrada nativa no Windows, no Mac e no Linux com X11, chamando a API do próprio sistema pelo
 * koffi (FFI com binários N-API prontos; funciona no Electron sem recompilar):
 *
 * - Windows: `SendInput` do user32, com o mouse em coordenadas absolutas da área de trabalho
 *   virtual (todas as telas) e o teclado pelo scancode.
 * - Mac: eventos do CoreGraphics (`CGEventPost`), com arrasto, clique duplo e modificadoras.
 *   Precisa da permissão de Acessibilidade (o `index.ts` confere antes).
 * - X11: extensão XTEST (`libXtst`, que o próprio Electron já exige).
 *
 * O koffi só carrega na primeira sessão (ou consulta), nunca na abertura do app.
 *
 * **Dois cursores** (pedido em 16/09/2026): com `cursor` (a leitura do cursor do sistema), o
 * mouse de quem controla não arrasta o de quem compartilha. O movimento só desenha o cursor
 * laranja (`onPointer`); o do sistema vai até o ponto no clique, na roda e enquanto um botão
 * está apertado (arrastar), e volta para onde a pessoa tinha deixado logo depois, se ela não
 * mexeu no mouse nesse meio-tempo.
 */
import type * as KoffiModule from 'koffi';
import { ControlError, PressedState, type InputBackend } from './backend';
import {
	distance,
	toDipPoint,
	toPhysicalPoint,
	toVirtualDeskAbsolute,
	WheelAccumulator,
	type Point,
	type Rect
} from './geometry';
import { evdevKey, macKeycode, macModifierFlags, windowsKey, X11_BUTTON, X11_WHEEL, x11Keycode } from './keymap';
import type { MouseButton, RemoteInput } from './protocol';
import {
	encodeInputs,
	INPUT_SIZE,
	keyboardInput,
	mouseButtonInput,
	mouseMoveInput,
	mouseWheelInputs,
	WHEEL_DELTA,
	type WindowsInput
} from './windows-input';

type Koffi = typeof KoffiModule;
type NativeFn = ReturnType<KoffiModule.LibraryHandle['func']>;

/** A tela controlada, como o `index.ts` a mediu no Electron. */
export interface ScreenMapping {
	/** Em DIP (`display.bounds`). */
	bounds: Rect;
	scaleFactor: number;
	/** Canto de cima à esquerda em pixels físicos (Windows e X11). */
	physicalOrigin: Point;
}

/** Pixels de rolagem do navegador por "clique" de roda, onde só existe clique (X11). */
const WHEEL_STEP_PX = 60;
/** Dois cliques mais perto que isso (tempo e distância) viram clique duplo no Mac. */
const MAC_DOUBLE_CLICK_MS = 500;
const MAC_DOUBLE_CLICK_PT = 4;

export interface Injector {
	/** Movimento para a posição 0–1 na tela controlada. */
	move(x: number, y: number, heldKeys: readonly string[]): void;
	/** O ponto nativo (pixels físicos no Windows e no X11, pontos no Mac) da posição 0–1. */
	pointOf(x: number, y: number): Point;
	/** Leva o cursor do sistema a um ponto nativo qualquer, inclusive de outra tela. */
	moveTo(point: Point, heldKeys: readonly string[]): void;
	button(button: MouseButton, down: boolean, heldKeys: readonly string[]): void;
	wheel(dx: number, dy: number, heldKeys: readonly string[]): void;
	key(code: string, down: boolean, heldKeys: readonly string[]): void;
	close(): void;
}

let koffi: Koffi | null = null;
function loadKoffi(): Koffi {
	return (koffi ??= require('koffi') as Koffi);
}

// ——— Windows ———

interface WindowsApi {
	SendInput: NativeFn;
	GetSystemMetrics: NativeFn;
}
let windowsApi: WindowsApi | null = null;

function loadWindowsApi(): WindowsApi {
	if (windowsApi) return windowsApi;
	if (process.arch !== 'x64' && process.arch !== 'arm64') {
		throw new ControlError('O controle remoto precisa do Windows de 64 bits.');
	}
	const user32 = loadKoffi().load('user32.dll');
	windowsApi = {
		SendInput: user32.func('__stdcall', 'SendInput', 'uint32', ['uint32', 'void *', 'int32']),
		GetSystemMetrics: user32.func('__stdcall', 'GetSystemMetrics', 'int32', ['int32'])
	};
	return windowsApi;
}

const SM_XVIRTUALSCREEN = 76;
const SM_YVIRTUALSCREEN = 77;
const SM_CXVIRTUALSCREEN = 78;
const SM_CYVIRTUALSCREEN = 79;

class WindowsInjector implements Injector {
	private readonly api = loadWindowsApi();
	/** 100 px do navegador = uma volta (120) no Windows. */
	private readonly wheelUnits = new WheelAccumulator(100 / WHEEL_DELTA);
	private warned = false;

	constructor(private readonly screen: ScreenMapping) {}

	private send(inputs: WindowsInput[]): void {
		if (inputs.length === 0) return;
		const sent = this.api.SendInput(inputs.length, encodeInputs(inputs), INPUT_SIZE) as number;
		if (sent !== inputs.length && !this.warned) {
			this.warned = true;
			// Janelas de administrador (UIPI) recusam entrada de apps comuns; não é motivo para parar.
			console.warn('[rawly] controle remoto: o Windows recusou parte da entrada');
		}
	}

	pointOf(x: number, y: number): Point {
		const { bounds, scaleFactor, physicalOrigin } = this.screen;
		return toPhysicalPoint(x, y, physicalOrigin, bounds, scaleFactor);
	}

	move(x: number, y: number): void {
		this.moveTo(this.pointOf(x, y));
	}

	moveTo(point: Point): void {
		const metric = (index: number) => this.api.GetSystemMetrics(index) as number;
		const virtualScreen = {
			x: metric(SM_XVIRTUALSCREEN),
			y: metric(SM_YVIRTUALSCREEN),
			width: metric(SM_CXVIRTUALSCREEN),
			height: metric(SM_CYVIRTUALSCREEN)
		};
		this.send([mouseMoveInput(toVirtualDeskAbsolute(point, virtualScreen))]);
	}

	button(button: MouseButton, down: boolean): void {
		this.send([mouseButtonInput(button, down)]);
	}

	wheel(dx: number, dy: number): void {
		this.send(mouseWheelInputs(this.wheelUnits.push(dx, dy)));
	}

	key(code: string, down: boolean): void {
		const key = windowsKey(code);
		if (key) this.send([keyboardInput(key, down)]);
	}

	close(): void {}
}

// ——— Mac ———

interface MacApi {
	CGEventSourceCreate: NativeFn;
	CGEventCreateMouseEvent: NativeFn;
	CGEventCreateKeyboardEvent: NativeFn;
	CGEventCreateScrollWheelEvent2: NativeFn;
	CGEventSetIntegerValueField: NativeFn;
	CGEventSetFlags: NativeFn;
	CGEventPost: NativeFn;
	CFRelease: NativeFn;
}
let macApi: MacApi | null = null;

function loadMacApi(): MacApi {
	if (macApi) return macApi;
	const ffi = loadKoffi();
	const cg = ffi.load('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics');
	const cf = ffi.load('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation');
	const CGPoint = ffi.struct({ x: 'double', y: 'double' });
	macApi = {
		CGEventSourceCreate: cg.func('CGEventSourceCreate', 'void *', ['int32']),
		CGEventCreateMouseEvent: cg.func('CGEventCreateMouseEvent', 'void *', ['void *', 'uint32', CGPoint, 'uint32']),
		CGEventCreateKeyboardEvent: cg.func('CGEventCreateKeyboardEvent', 'void *', ['void *', 'uint16', 'bool']),
		CGEventCreateScrollWheelEvent2: cg.func('CGEventCreateScrollWheelEvent2', 'void *', [
			'void *',
			'uint32',
			'uint32',
			'int32',
			'int32',
			'int32'
		]),
		CGEventSetIntegerValueField: cg.func('CGEventSetIntegerValueField', 'void', ['void *', 'uint32', 'int64']),
		CGEventSetFlags: cg.func('CGEventSetFlags', 'void', ['void *', 'uint64']),
		CGEventPost: cg.func('CGEventPost', 'void', ['uint32', 'void *']),
		CFRelease: cf.func('CFRelease', 'void', ['void *'])
	};
	return macApi;
}

const kCGEventSourceStateHIDSystemState = 1;
const kCGHIDEventTap = 0;
const kCGScrollEventUnitPixel = 0;
const kCGMouseEventClickState = 1;
const kCGMouseEventButtonNumber = 3;
const MAC_BUTTON_NUMBER: Record<MouseButton, number> = { left: 0, right: 1, middle: 2 };
const MAC_MOUSE_TYPE: Record<MouseButton, { down: number; up: number; drag: number }> = {
	left: { down: 1, up: 2, drag: 6 },
	right: { down: 3, up: 4, drag: 7 },
	middle: { down: 25, up: 26, drag: 27 }
};
const kCGEventMouseMoved = 5;

class MacInjector implements Injector {
	private readonly api = loadMacApi();
	private readonly source: unknown;
	private readonly buttonsDown = new Set<MouseButton>();
	private readonly wheelPixels = new WheelAccumulator(1);
	private position: Point;
	private lastClick: { button: MouseButton; at: number; point: Point; count: number } | null = null;

	constructor(private readonly screen: ScreenMapping) {
		this.source = this.api.CGEventSourceCreate(kCGEventSourceStateHIDSystemState);
		this.position = toDipPoint(0.5, 0.5, screen.bounds);
	}

	private post(event: unknown, heldKeys: readonly string[]): void {
		if (!event) throw new Error('CGEvent nulo');
		try {
			this.api.CGEventSetFlags(event, macModifierFlags(heldKeys));
			this.api.CGEventPost(kCGHIDEventTap, event);
		} finally {
			this.api.CFRelease(event);
		}
	}

	private mouseEvent(type: number, button: MouseButton): unknown {
		const event = this.api.CGEventCreateMouseEvent(this.source, type, this.position, MAC_BUTTON_NUMBER[button]);
		if (event && button === 'middle') {
			this.api.CGEventSetIntegerValueField(event, kCGMouseEventButtonNumber, MAC_BUTTON_NUMBER.middle);
		}
		return event;
	}

	pointOf(x: number, y: number): Point {
		return toDipPoint(x, y, this.screen.bounds);
	}

	move(x: number, y: number, heldKeys: readonly string[] = []): void {
		this.moveTo(this.pointOf(x, y), heldKeys);
	}

	moveTo(point: Point, heldKeys: readonly string[] = []): void {
		this.position = point;
		// Com um botão apertado o Mac espera "arrastar", não "mover".
		const dragging = (['left', 'right', 'middle'] as const).find((button) => this.buttonsDown.has(button));
		const event = dragging
			? this.mouseEvent(MAC_MOUSE_TYPE[dragging].drag, dragging)
			: this.mouseEvent(kCGEventMouseMoved, 'left');
		this.post(event, heldKeys);
	}

	button(button: MouseButton, down: boolean, heldKeys: readonly string[]): void {
		const now = Date.now();
		if (down) {
			const last = this.lastClick;
			const near =
				last?.button === button &&
				now - last.at <= MAC_DOUBLE_CLICK_MS &&
				Math.hypot(last.point.x - this.position.x, last.point.y - this.position.y) <= MAC_DOUBLE_CLICK_PT;
			this.lastClick = { button, at: now, point: this.position, count: near && last ? last.count + 1 : 1 };
			this.buttonsDown.add(button);
		} else {
			this.buttonsDown.delete(button);
		}
		const count = this.lastClick?.button === button ? this.lastClick.count : 1;
		const event = this.mouseEvent(down ? MAC_MOUSE_TYPE[button].down : MAC_MOUSE_TYPE[button].up, button);
		if (event) this.api.CGEventSetIntegerValueField(event, kCGMouseEventClickState, count);
		this.post(event, heldKeys);
	}

	wheel(dx: number, dy: number, heldKeys: readonly string[]): void {
		const pixels = this.wheelPixels.push(dx, dy);
		if (pixels.x === 0 && pixels.y === 0) return;
		// No CoreGraphics o positivo rola para cima/esquerda; no navegador, para baixo/direita.
		const event = this.api.CGEventCreateScrollWheelEvent2(
			this.source,
			kCGScrollEventUnitPixel,
			2,
			-pixels.y,
			-pixels.x,
			0
		);
		this.post(event, heldKeys);
	}

	key(code: string, down: boolean, heldKeys: readonly string[]): void {
		const keycode = macKeycode(code);
		if (keycode === null) return;
		this.post(this.api.CGEventCreateKeyboardEvent(this.source, keycode, down), heldKeys);
	}

	close(): void {
		if (this.source) this.api.CFRelease(this.source);
	}
}

// ——— X11 ———

interface X11Api {
	XOpenDisplay: NativeFn;
	XCloseDisplay: NativeFn;
	XFlush: NativeFn;
	XTestQueryExtension: NativeFn;
	XTestFakeMotionEvent: NativeFn;
	XTestFakeButtonEvent: NativeFn;
	XTestFakeKeyEvent: NativeFn;
}
let x11Api: X11Api | null = null;

function loadX11Api(): X11Api {
	if (x11Api) return x11Api;
	const ffi = loadKoffi();
	const x11 = ffi.load('libX11.so.6');
	const xtst = ffi.load('libXtst.so.6');
	x11Api = {
		XOpenDisplay: x11.func('XOpenDisplay', 'void *', ['str']),
		XCloseDisplay: x11.func('XCloseDisplay', 'int', ['void *']),
		XFlush: x11.func('XFlush', 'int', ['void *']),
		XTestQueryExtension: xtst.func('XTestQueryExtension', 'int', [
			'void *',
			ffi.out(ffi.pointer('int')),
			ffi.out(ffi.pointer('int')),
			ffi.out(ffi.pointer('int')),
			ffi.out(ffi.pointer('int'))
		]),
		XTestFakeMotionEvent: xtst.func('XTestFakeMotionEvent', 'int', ['void *', 'int', 'int', 'int', 'unsigned long']),
		XTestFakeButtonEvent: xtst.func('XTestFakeButtonEvent', 'int', ['void *', 'unsigned int', 'int', 'unsigned long']),
		XTestFakeKeyEvent: xtst.func('XTestFakeKeyEvent', 'int', ['void *', 'unsigned int', 'int', 'unsigned long'])
	};
	return x11Api;
}

/** Abre a conexão com o X e confere a extensão XTEST. */
function openX11Display(api: X11Api): unknown {
	const display = api.XOpenDisplay(null);
	if (!display) throw new ControlError('Não deu para acessar a tela do X11.');
	if (!api.XTestQueryExtension(display, [0], [0], [0], [0])) {
		api.XCloseDisplay(display);
		throw new ControlError('O servidor X deste computador não tem a extensão XTEST.');
	}
	return display;
}

class X11Injector implements Injector {
	private readonly api = loadX11Api();
	private readonly display = openX11Display(this.api);
	private readonly wheelSteps = new WheelAccumulator(WHEEL_STEP_PX);

	constructor(private readonly screen: ScreenMapping) {}

	pointOf(x: number, y: number): Point {
		const { bounds, scaleFactor, physicalOrigin } = this.screen;
		return toPhysicalPoint(x, y, physicalOrigin, bounds, scaleFactor);
	}

	move(x: number, y: number): void {
		this.moveTo(this.pointOf(x, y));
	}

	moveTo(point: Point): void {
		this.api.XTestFakeMotionEvent(this.display, -1, Math.round(point.x), Math.round(point.y), 0);
		this.api.XFlush(this.display);
	}

	button(button: MouseButton, down: boolean): void {
		this.api.XTestFakeButtonEvent(this.display, X11_BUTTON[button], down ? 1 : 0, 0);
		this.api.XFlush(this.display);
	}

	wheel(dx: number, dy: number): void {
		const steps = this.wheelSteps.push(dx, dy);
		const click = (button: number, times: number) => {
			for (let index = 0; index < times; index += 1) {
				this.api.XTestFakeButtonEvent(this.display, button, 1, 0);
				this.api.XTestFakeButtonEvent(this.display, button, 0, 0);
			}
		};
		click(steps.y > 0 ? X11_WHEEL.down : X11_WHEEL.up, Math.abs(steps.y));
		click(steps.x > 0 ? X11_WHEEL.right : X11_WHEEL.left, Math.abs(steps.x));
		this.api.XFlush(this.display);
	}

	key(code: string, down: boolean): void {
		const keycode = x11Keycode(code);
		if (keycode === null) return;
		this.api.XTestFakeKeyEvent(this.display, keycode, down ? 1 : 0, 0);
		this.api.XFlush(this.display);
	}

	close(): void {
		this.api.XCloseDisplay(this.display);
	}
}

// ——— Sessão ———

/** Onde está o cursor do sistema, no mesmo espaço de `Injector.pointOf`; `null` quando não dá para saber. */
export interface SystemCursor {
	read(): Point | null;
}

export interface NativeBackendOptions {
	/** Com ela, os dois cursores ficam independentes; sem ela, o do sistema segue quem controla. */
	cursor?: SystemCursor | null;
	/** Cada posição de quem controla (0–1), para desenhar o cursor laranja. */
	onPointer?: (x: number, y: number) => void;
	/** Quanto esperar parado antes de devolver o cursor (clique duplo e rolagem seguida não pulam). */
	returnDelayMs?: number;
}

/** Distância em que o cursor ainda "está onde o Rawly pôs" (arredondamento do sistema). */
const PLACED_TOLERANCE = 3;
const RETURN_DELAY_MS = 350;

export class NativeBackend implements InputBackend {
	readonly kind = 'native' as const;
	private readonly pressed = new PressedState();
	private readonly cursor: SystemCursor | null;
	private readonly onPointer: (x: number, y: number) => void;
	private readonly returnDelayMs: number;
	/** Onde estava o cursor de quem compartilha antes de o Rawly levá-lo. */
	private home: Point | null = null;
	/** Onde o Rawly deixou o cursor do sistema por último. */
	private placed: Point | null = null;
	private returnTimer: ReturnType<typeof setTimeout> | null = null;
	private closed = false;

	constructor(
		private readonly injector: Injector,
		options: NativeBackendOptions = {}
	) {
		this.cursor = options.cursor ?? null;
		this.onPointer = options.onPointer ?? (() => {});
		this.returnDelayMs = options.returnDelayMs ?? RETURN_DELAY_MS;
	}

	apply(event: RemoteInput): void {
		if (event.type !== 'key') this.onPointer(event.x, event.y);
		if (!this.cursor) {
			this.applyFollowing(event);
			return;
		}
		const held = () => this.pressed.heldKeys();
		switch (event.type) {
			case 'move':
				// Só arrastando o cursor do sistema acompanha; senão, só o laranja se move.
				if (this.pressed.heldButtons().length > 0) this.take(event.x, event.y);
				return;
			case 'button': {
				const down = event.action === 'down';
				if (!down && !this.pressed.heldButtons().includes(event.button)) return;
				if (down) this.park();
				this.take(event.x, event.y);
				if (this.pressed.button(event.button, down)) this.injector.button(event.button, down, held());
				if (!down) this.scheduleReturn();
				return;
			}
			case 'wheel':
				this.park();
				this.take(event.x, event.y);
				this.injector.wheel(event.dx, event.dy, held());
				this.scheduleReturn();
				return;
			case 'key':
				this.applyKey(event.code, event.action === 'down');
				return;
		}
	}

	/** O jeito de antes (e o do Wayland): o cursor do sistema segue quem controla. */
	private applyFollowing(event: RemoteInput): void {
		const held = () => this.pressed.heldKeys();
		switch (event.type) {
			case 'move':
				this.moveTo(event.x, event.y);
				return;
			case 'button': {
				this.moveTo(event.x, event.y);
				const down = event.action === 'down';
				if (this.pressed.button(event.button, down)) this.injector.button(event.button, down, held());
				return;
			}
			case 'wheel':
				this.moveTo(event.x, event.y);
				this.injector.wheel(event.dx, event.dy, held());
				return;
			case 'key':
				this.applyKey(event.code, event.action === 'down');
				return;
		}
	}

	private applyKey(code: string, down: boolean): void {
		if (evdevKey(code) === null) return;
		if (this.pressed.key(code, down)) this.injector.key(code, down, this.pressed.heldKeys());
	}

	private moveTo(x: number, y: number): void {
		// O Mac leva as modificadoras também no movimento (arrastar com ⌥, por exemplo).
		this.injector.move(x, y, this.pressed.heldKeys());
	}

	/** Antes de levar o cursor do sistema: guarda onde a pessoa o deixou (uma vez por "visita"). */
	private park(): void {
		this.cancelReturn();
		if (this.home) {
			// Ainda está onde o Rawly pôs? Então a casa continua valendo; senão, a pessoa mexeu.
			const now = this.readCursor();
			if (!now || !this.placed || distance(now, this.placed) <= PLACED_TOLERANCE) return;
		}
		this.home = this.readCursor();
	}

	private take(x: number, y: number): void {
		const point = this.injector.pointOf(x, y);
		this.injector.moveTo(point, this.pressed.heldKeys());
		this.placed = point;
	}

	private scheduleReturn(): void {
		this.cancelReturn();
		if (this.closed || this.pressed.heldButtons().length > 0) return;
		this.returnTimer = setTimeout(() => {
			this.returnTimer = null;
			this.giveBack();
		}, this.returnDelayMs);
	}

	private cancelReturn(): void {
		if (this.returnTimer) clearTimeout(this.returnTimer);
		this.returnTimer = null;
	}

	/** Devolve o cursor para onde a pessoa tinha deixado, se ela não mexeu nele desde então. */
	private giveBack(): void {
		const home = this.home;
		const placed = this.placed;
		this.home = null;
		this.placed = null;
		if (!home || !placed || this.pressed.heldButtons().length > 0) return;
		const now = this.readCursor();
		if (!now || distance(now, placed) > PLACED_TOLERANCE) return;
		try {
			this.injector.moveTo(home, this.pressed.heldKeys());
		} catch (error) {
			console.warn('[rawly] controle remoto: não deu para devolver o cursor', error);
		}
	}

	private readCursor(): Point | null {
		try {
			const point = this.cursor?.read() ?? null;
			return point && Number.isFinite(point.x) && Number.isFinite(point.y) ? point : null;
		} catch {
			return null;
		}
	}

	async close(): Promise<void> {
		this.cancelReturn();
		const { buttons, keys } = this.pressed.drain();
		try {
			for (const button of buttons) this.injector.button(button, false, keys);
			keys.forEach((code, index) => this.injector.key(code, false, keys.slice(index + 1)));
		} catch (error) {
			console.warn('[rawly] controle remoto: falha ao soltar teclas', error);
		}
		this.giveBack();
		this.closed = true;
		try {
			this.injector.close();
		} catch (error) {
			console.warn('[rawly] controle remoto: falha ao fechar a entrada nativa', error);
		}
	}
}

/** `null` quando dá para injetar entrada neste sistema; senão, o motivo em pt-BR. Não injeta nada. */
export function probeNative(platform: NodeJS.Platform): string | null {
	try {
		if (platform === 'win32') {
			loadWindowsApi();
			return null;
		}
		if (platform === 'darwin') {
			loadMacApi();
			return null;
		}
		if (platform === 'linux') {
			const api = loadX11Api();
			api.XCloseDisplay(openX11Display(api));
			return null;
		}
		return 'O controle remoto não funciona neste sistema.';
	} catch (error) {
		if (error instanceof ControlError) return error.message;
		console.warn('[rawly] controle remoto: entrada nativa indisponível', error);
		return 'O controle remoto não carregou neste computador.';
	}
}

export function openNativeBackend(
	platform: NodeJS.Platform,
	screen: ScreenMapping,
	options: NativeBackendOptions = {}
): NativeBackend {
	try {
		if (platform === 'win32') return new NativeBackend(new WindowsInjector(screen), options);
		if (platform === 'darwin') return new NativeBackend(new MacInjector(screen), options);
		if (platform === 'linux') return new NativeBackend(new X11Injector(screen), options);
	} catch (error) {
		if (error instanceof ControlError) throw error;
		throw new ControlError('O controle remoto não carregou neste computador.', { cause: error });
	}
	throw new ControlError('O controle remoto não funciona neste sistema.');
}
