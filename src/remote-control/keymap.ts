/**
 * `KeyboardEvent.code` (a posição física da tecla em quem controla) → o código da mesma tecla
 * em cada sistema. A tecla vai pela posição, não pelo caractere: com os dois no mesmo layout
 * (o ABNT2 de sempre), Ç, acentos e atalhos saem iguais; com layouts diferentes vale o layout
 * de quem compartilha, como no RDP.
 *
 * A tabela sai do `ui/events/keycodes/dom/dom_code_data.inc` do Chromium, o mesmo lugar de
 * onde o navegador tira o `code`. Colunas: evdev (Linux; no X11 o keycode é evdev + 8),
 * scancode do Windows (conjunto 1; 0xe0xx = tecla estendida) e keycode virtual do Mac
 * (`kVK_*`; `null` quando o Mac não tem a tecla).
 */

type Row = readonly [evdev: number, win: number, mac: number | null];

const TABLE: Readonly<Record<string, Row>> = {
	KeyA: [30, 0x1e, 0x00],
	KeyB: [48, 0x30, 0x0b],
	KeyC: [46, 0x2e, 0x08],
	KeyD: [32, 0x20, 0x02],
	KeyE: [18, 0x12, 0x0e],
	KeyF: [33, 0x21, 0x03],
	KeyG: [34, 0x22, 0x05],
	KeyH: [35, 0x23, 0x04],
	KeyI: [23, 0x17, 0x22],
	KeyJ: [36, 0x24, 0x26],
	KeyK: [37, 0x25, 0x28],
	KeyL: [38, 0x26, 0x25],
	KeyM: [50, 0x32, 0x2e],
	KeyN: [49, 0x31, 0x2d],
	KeyO: [24, 0x18, 0x1f],
	KeyP: [25, 0x19, 0x23],
	KeyQ: [16, 0x10, 0x0c],
	KeyR: [19, 0x13, 0x0f],
	KeyS: [31, 0x1f, 0x01],
	KeyT: [20, 0x14, 0x11],
	KeyU: [22, 0x16, 0x20],
	KeyV: [47, 0x2f, 0x09],
	KeyW: [17, 0x11, 0x0d],
	KeyX: [45, 0x2d, 0x07],
	KeyY: [21, 0x15, 0x10],
	KeyZ: [44, 0x2c, 0x06],
	Digit1: [2, 0x02, 0x12],
	Digit2: [3, 0x03, 0x13],
	Digit3: [4, 0x04, 0x14],
	Digit4: [5, 0x05, 0x15],
	Digit5: [6, 0x06, 0x17],
	Digit6: [7, 0x07, 0x16],
	Digit7: [8, 0x08, 0x1a],
	Digit8: [9, 0x09, 0x1c],
	Digit9: [10, 0x0a, 0x19],
	Digit0: [11, 0x0b, 0x1d],
	Enter: [28, 0x1c, 0x24],
	Escape: [1, 0x01, 0x35],
	Backspace: [14, 0x0e, 0x33],
	Tab: [15, 0x0f, 0x30],
	Space: [57, 0x39, 0x31],
	Minus: [12, 0x0c, 0x1b],
	Equal: [13, 0x0d, 0x18],
	BracketLeft: [26, 0x1a, 0x21],
	BracketRight: [27, 0x1b, 0x1e],
	Backslash: [43, 0x2b, 0x2a],
	Semicolon: [39, 0x27, 0x29],
	Quote: [40, 0x28, 0x27],
	Backquote: [41, 0x29, 0x32],
	Comma: [51, 0x33, 0x2b],
	Period: [52, 0x34, 0x2f],
	Slash: [53, 0x35, 0x2c],
	IntlBackslash: [86, 0x56, 0x0a],
	IntlRo: [89, 0x73, 0x5e],
	IntlYen: [124, 0x7d, 0x5d],
	CapsLock: [58, 0x3a, 0x39],
	NumLock: [69, 0xe045, 0x47],
	ScrollLock: [70, 0x46, null],
	PrintScreen: [99, 0xe037, null],
	Pause: [119, 0x45, null],
	ContextMenu: [127, 0xe05d, 0x6e],
	F1: [59, 0x3b, 0x7a],
	F2: [60, 0x3c, 0x78],
	F3: [61, 0x3d, 0x63],
	F4: [62, 0x3e, 0x76],
	F5: [63, 0x3f, 0x60],
	F6: [64, 0x40, 0x61],
	F7: [65, 0x41, 0x62],
	F8: [66, 0x42, 0x64],
	F9: [67, 0x43, 0x65],
	F10: [68, 0x44, 0x6d],
	F11: [87, 0x57, 0x67],
	F12: [88, 0x58, 0x6f],
	F13: [183, 0x64, 0x69],
	F14: [184, 0x65, 0x6b],
	F15: [185, 0x66, 0x71],
	F16: [186, 0x67, 0x6a],
	F17: [187, 0x68, 0x40],
	F18: [188, 0x69, 0x4f],
	F19: [189, 0x6a, 0x50],
	F20: [190, 0x6b, 0x5a],
	F21: [191, 0x6c, null],
	F22: [192, 0x6d, null],
	F23: [193, 0x6e, null],
	F24: [194, 0x76, null],
	Insert: [110, 0xe052, 0x72],
	Home: [102, 0xe047, 0x73],
	PageUp: [104, 0xe049, 0x74],
	Delete: [111, 0xe053, 0x75],
	End: [107, 0xe04f, 0x77],
	PageDown: [109, 0xe051, 0x79],
	ArrowRight: [106, 0xe04d, 0x7c],
	ArrowLeft: [105, 0xe04b, 0x7b],
	ArrowDown: [108, 0xe050, 0x7d],
	ArrowUp: [103, 0xe048, 0x7e],
	NumpadDivide: [98, 0xe035, 0x4b],
	NumpadMultiply: [55, 0x37, 0x43],
	NumpadSubtract: [74, 0x4a, 0x4e],
	NumpadAdd: [78, 0x4e, 0x45],
	NumpadEnter: [96, 0xe01c, 0x4c],
	NumpadDecimal: [83, 0x53, 0x41],
	NumpadEqual: [117, 0x59, 0x51],
	NumpadComma: [121, 0x7e, 0x5f],
	Numpad0: [82, 0x52, 0x52],
	Numpad1: [79, 0x4f, 0x53],
	Numpad2: [80, 0x50, 0x54],
	Numpad3: [81, 0x51, 0x55],
	Numpad4: [75, 0x4b, 0x56],
	Numpad5: [76, 0x4c, 0x57],
	Numpad6: [77, 0x4d, 0x58],
	Numpad7: [71, 0x47, 0x59],
	Numpad8: [72, 0x48, 0x5b],
	Numpad9: [73, 0x49, 0x5c],
	ControlLeft: [29, 0x1d, 0x3b],
	ShiftLeft: [42, 0x2a, 0x38],
	AltLeft: [56, 0x38, 0x3a],
	MetaLeft: [125, 0xe05b, 0x37],
	ControlRight: [97, 0xe01d, 0x3e],
	ShiftRight: [54, 0x36, 0x3c],
	AltRight: [100, 0xe038, 0x3d],
	MetaRight: [126, 0xe05c, 0x36],
	AudioVolumeMute: [113, 0xe020, 0x4a],
	AudioVolumeDown: [114, 0xe02e, 0x49],
	AudioVolumeUp: [115, 0xe030, 0x48],
	MediaTrackNext: [163, 0xe019, null],
	MediaTrackPrevious: [165, 0xe010, null],
	MediaStop: [166, 0xe024, null],
	MediaPlayPause: [164, 0xe022, null]
};

/**
 * No Windows estas vão pela tecla virtual (VK), não pelo scancode: o Pause e o NumLock dividem
 * o scancode 0x45, o PrintScreen é uma sequência, e as de mídia só existem como VK.
 */
const WINDOWS_VK: Readonly<Record<string, number>> = {
	NumLock: 0x90,
	Pause: 0x13,
	PrintScreen: 0x2c,
	AudioVolumeMute: 0xad,
	AudioVolumeDown: 0xae,
	AudioVolumeUp: 0xaf,
	MediaTrackNext: 0xb0,
	MediaTrackPrevious: 0xb1,
	MediaStop: 0xb2,
	MediaPlayPause: 0xb3
};

function row(code: string): Row | null {
	return Object.prototype.hasOwnProperty.call(TABLE, code) ? (TABLE[code] ?? null) : null;
}

/** Os códigos que a tabela conhece (para testes e diagnóstico). */
export function knownCodes(): string[] {
	return Object.keys(TABLE);
}

/** Código evdev da tecla (Linux: portal do Wayland). */
export function evdevKey(code: string): number | null {
	return row(code)?.[0] ?? null;
}

/** Keycode do X11 (servidores com o mapa evdev, que é o padrão desde sempre): evdev + 8. */
export function x11Keycode(code: string): number | null {
	const evdev = evdevKey(code);
	return evdev === null ? null : evdev + 8;
}

/** Keycode virtual do Mac (`kVK_*`). */
export function macKeycode(code: string): number | null {
	return row(code)?.[2] ?? null;
}

export interface WindowsKey {
	/** Tecla virtual; 0 quando vai pelo scancode. */
	vk: number;
	/** Scancode sem o prefixo 0xe0. */
	scan: number;
	extended: boolean;
}

export function windowsKey(code: string): WindowsKey | null {
	const found = row(code);
	if (!found) return null;
	const scan = found[1];
	const extended = scan > 0xff;
	const vk = Object.prototype.hasOwnProperty.call(WINDOWS_VK, code) ? (WINDOWS_VK[code] ?? 0) : 0;
	return { vk, scan: scan & 0xff, extended };
}

/** Botões do mouse no evdev (`BTN_LEFT`, `BTN_RIGHT`, `BTN_MIDDLE`). */
export const EVDEV_BUTTON = { left: 0x110, right: 0x111, middle: 0x112 } as const;

/** Botões do X11: 1 esquerdo, 2 do meio, 3 direito; 4/5 rolam para cima/baixo, 6/7 para os lados. */
export const X11_BUTTON = { left: 1, middle: 2, right: 3 } as const;
export const X11_WHEEL = { up: 4, down: 5, left: 6, right: 7 } as const;

/**
 * `CGEventFlags` do Mac para as teclas modificadoras apertadas: o bit geral de cada uma e o
 * bit do lado (NX_DEVICE*KEYMASK), que alguns apps leem.
 */
const MAC_MODIFIER_FLAGS: Readonly<Record<string, number>> = {
	ShiftLeft: 0x20000 | 0x2,
	ShiftRight: 0x20000 | 0x4,
	ControlLeft: 0x40000 | 0x1,
	ControlRight: 0x40000 | 0x2000,
	AltLeft: 0x80000 | 0x20,
	AltRight: 0x80000 | 0x40,
	MetaLeft: 0x100000 | 0x8,
	MetaRight: 0x100000 | 0x10
};

export function isModifierCode(code: string): boolean {
	return Object.prototype.hasOwnProperty.call(MAC_MODIFIER_FLAGS, code);
}

export function macModifierFlags(pressedCodes: Iterable<string>): number {
	let flags = 0;
	for (const code of pressedCodes) {
		if (isModifierCode(code)) flags |= MAC_MODIFIER_FLAGS[code] ?? 0;
	}
	return flags;
}
