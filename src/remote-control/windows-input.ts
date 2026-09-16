/**
 * Os bytes do `INPUT[]` que o `SendInput` do Windows recebe, montados à mão num Buffer (e não
 * pelo koffi) para o layout ficar à vista e testado. Windows de 64 bits (x64 e arm64):
 *
 *   INPUT (40 bytes): DWORD type @0, união @8
 *   MOUSEINPUT:       LONG dx @8, LONG dy @12, DWORD mouseData @16, DWORD dwFlags @20,
 *                     DWORD time @24, ULONG_PTR dwExtraInfo @32
 *   KEYBDINPUT:       WORD wVk @8, WORD wScan @10, DWORD dwFlags @12, DWORD time @16,
 *                     ULONG_PTR dwExtraInfo @24
 *
 * Sem Electron: roda nos testes com `node --test`.
 */
import type { MouseButton } from './protocol';
import type { WindowsKey } from './keymap';

export const INPUT_SIZE = 40;
const INPUT_MOUSE = 0;
const INPUT_KEYBOARD = 1;

export const MOUSEEVENTF = {
	MOVE: 0x0001,
	LEFTDOWN: 0x0002,
	LEFTUP: 0x0004,
	RIGHTDOWN: 0x0008,
	RIGHTUP: 0x0010,
	MIDDLEDOWN: 0x0020,
	MIDDLEUP: 0x0040,
	WHEEL: 0x0800,
	HWHEEL: 0x1000,
	VIRTUALDESK: 0x4000,
	ABSOLUTE: 0x8000
} as const;

export const KEYEVENTF = {
	EXTENDEDKEY: 0x0001,
	KEYUP: 0x0002,
	SCANCODE: 0x0008
} as const;

/** Uma "volta" da roda no Windows. */
export const WHEEL_DELTA = 120;

export type WindowsInput =
	| { kind: 'mouse'; dx: number; dy: number; mouseData: number; flags: number }
	| { kind: 'key'; vk: number; scan: number; flags: number };

export function encodeInputs(inputs: readonly WindowsInput[]): Buffer {
	const buffer = Buffer.alloc(INPUT_SIZE * inputs.length);
	inputs.forEach((input, index) => {
		const base = index * INPUT_SIZE;
		if (input.kind === 'mouse') {
			buffer.writeUInt32LE(INPUT_MOUSE, base);
			buffer.writeInt32LE(input.dx | 0, base + 8);
			buffer.writeInt32LE(input.dy | 0, base + 12);
			// DWORD, mas a roda usa o valor com sinal (negativo = para baixo).
			buffer.writeInt32LE(input.mouseData | 0, base + 16);
			buffer.writeUInt32LE(input.flags >>> 0, base + 20);
		} else {
			buffer.writeUInt32LE(INPUT_KEYBOARD, base);
			buffer.writeUInt16LE(input.vk & 0xffff, base + 8);
			buffer.writeUInt16LE(input.scan & 0xffff, base + 10);
			buffer.writeUInt32LE(input.flags >>> 0, base + 12);
		}
	});
	return buffer;
}

/** Move para um ponto absoluto (0–65535 sobre a área de trabalho virtual). */
export function mouseMoveInput(absolute: { x: number; y: number }): WindowsInput {
	return {
		kind: 'mouse',
		dx: absolute.x,
		dy: absolute.y,
		mouseData: 0,
		flags: MOUSEEVENTF.MOVE | MOUSEEVENTF.ABSOLUTE | MOUSEEVENTF.VIRTUALDESK
	};
}

export function mouseButtonInput(button: MouseButton, down: boolean): WindowsInput {
	const flags =
		button === 'left'
			? down
				? MOUSEEVENTF.LEFTDOWN
				: MOUSEEVENTF.LEFTUP
			: button === 'right'
				? down
					? MOUSEEVENTF.RIGHTDOWN
					: MOUSEEVENTF.RIGHTUP
				: down
					? MOUSEEVENTF.MIDDLEDOWN
					: MOUSEEVENTF.MIDDLEUP;
	return { kind: 'mouse', dx: 0, dy: 0, mouseData: 0, flags };
}

/**
 * Rolagem em unidades do Windows (120 = uma volta). O sinal vem do navegador (positivo = para
 * baixo/direita); no Windows a roda vertical positiva sobe, a horizontal positiva vai à direita.
 */
export function mouseWheelInputs(units: { x: number; y: number }): WindowsInput[] {
	const inputs: WindowsInput[] = [];
	if (units.y !== 0) inputs.push({ kind: 'mouse', dx: 0, dy: 0, mouseData: -units.y, flags: MOUSEEVENTF.WHEEL });
	if (units.x !== 0) inputs.push({ kind: 'mouse', dx: 0, dy: 0, mouseData: units.x, flags: MOUSEEVENTF.HWHEEL });
	return inputs;
}

/** Tecla pelo scancode (posição física), ou pela VK nas poucas que só existem assim. */
export function keyboardInput(key: WindowsKey, down: boolean): WindowsInput {
	const up = down ? 0 : KEYEVENTF.KEYUP;
	const extended = key.extended ? KEYEVENTF.EXTENDEDKEY : 0;
	if (key.vk) return { kind: 'key', vk: key.vk, scan: key.scan, flags: up | extended };
	return { kind: 'key', vk: 0, scan: key.scan, flags: KEYEVENTF.SCANCODE | up | extended };
}
