// Tabelas de teclas do controle remoto. Roda sobre o `out/` compilado: `npm test`.
const assert = require('node:assert/strict');
const { existsSync, readFileSync } = require('node:fs');
const test = require('node:test');
const keymap = require('../../out/remote-control/keymap.js');

/** `KeyboardEvent.code` → nome da constante em linux/input-event-codes.h. */
const EVDEV_NAMES = {
	Enter: 'KEY_ENTER',
	Escape: 'KEY_ESC',
	Backspace: 'KEY_BACKSPACE',
	Tab: 'KEY_TAB',
	Space: 'KEY_SPACE',
	Minus: 'KEY_MINUS',
	Equal: 'KEY_EQUAL',
	BracketLeft: 'KEY_LEFTBRACE',
	BracketRight: 'KEY_RIGHTBRACE',
	Backslash: 'KEY_BACKSLASH',
	Semicolon: 'KEY_SEMICOLON',
	Quote: 'KEY_APOSTROPHE',
	Backquote: 'KEY_GRAVE',
	Comma: 'KEY_COMMA',
	Period: 'KEY_DOT',
	Slash: 'KEY_SLASH',
	IntlBackslash: 'KEY_102ND',
	IntlRo: 'KEY_RO',
	IntlYen: 'KEY_YEN',
	CapsLock: 'KEY_CAPSLOCK',
	NumLock: 'KEY_NUMLOCK',
	ScrollLock: 'KEY_SCROLLLOCK',
	PrintScreen: 'KEY_SYSRQ',
	Pause: 'KEY_PAUSE',
	ContextMenu: 'KEY_COMPOSE',
	Insert: 'KEY_INSERT',
	Home: 'KEY_HOME',
	PageUp: 'KEY_PAGEUP',
	Delete: 'KEY_DELETE',
	End: 'KEY_END',
	PageDown: 'KEY_PAGEDOWN',
	ArrowRight: 'KEY_RIGHT',
	ArrowLeft: 'KEY_LEFT',
	ArrowDown: 'KEY_DOWN',
	ArrowUp: 'KEY_UP',
	NumpadDivide: 'KEY_KPSLASH',
	NumpadMultiply: 'KEY_KPASTERISK',
	NumpadSubtract: 'KEY_KPMINUS',
	NumpadAdd: 'KEY_KPPLUS',
	NumpadEnter: 'KEY_KPENTER',
	NumpadDecimal: 'KEY_KPDOT',
	NumpadEqual: 'KEY_KPEQUAL',
	NumpadComma: 'KEY_KPCOMMA',
	ControlLeft: 'KEY_LEFTCTRL',
	ShiftLeft: 'KEY_LEFTSHIFT',
	AltLeft: 'KEY_LEFTALT',
	MetaLeft: 'KEY_LEFTMETA',
	ControlRight: 'KEY_RIGHTCTRL',
	ShiftRight: 'KEY_RIGHTSHIFT',
	AltRight: 'KEY_RIGHTALT',
	MetaRight: 'KEY_RIGHTMETA',
	AudioVolumeMute: 'KEY_MUTE',
	AudioVolumeDown: 'KEY_VOLUMEDOWN',
	AudioVolumeUp: 'KEY_VOLUMEUP',
	MediaTrackNext: 'KEY_NEXTSONG',
	MediaTrackPrevious: 'KEY_PREVIOUSSONG',
	MediaStop: 'KEY_STOPCD',
	MediaPlayPause: 'KEY_PLAYPAUSE'
};
for (const letter of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') EVDEV_NAMES[`Key${letter}`] = `KEY_${letter}`;
for (const digit of '0123456789') {
	EVDEV_NAMES[`Digit${digit}`] = `KEY_${digit}`;
	EVDEV_NAMES[`Numpad${digit}`] = `KEY_KP${digit}`;
}
for (let n = 1; n <= 24; n += 1) EVDEV_NAMES[`F${n}`] = `KEY_F${n}`;

const HEADER = '/usr/include/linux/input-event-codes.h';

test('todo código da tabela tem nome evdev conhecido', () => {
	assert.deepEqual(keymap.knownCodes().filter((code) => !EVDEV_NAMES[code]), []);
});

test('evdev bate com linux/input-event-codes.h', { skip: !existsSync(HEADER) && 'sem o cabeçalho do kernel' }, () => {
	const defines = new Map();
	for (const match of readFileSync(HEADER, 'utf8').matchAll(/^#define\s+((?:KEY|BTN)_\w+)\s+(0x[0-9a-fA-F]+|\d+)/gm)) {
		defines.set(match[1], Number(match[2]));
	}
	for (const code of keymap.knownCodes()) {
		assert.equal(keymap.evdevKey(code), defines.get(EVDEV_NAMES[code]), code);
	}
	assert.equal(keymap.EVDEV_BUTTON.left, defines.get('BTN_LEFT'));
	assert.equal(keymap.EVDEV_BUTTON.right, defines.get('BTN_RIGHT'));
	assert.equal(keymap.EVDEV_BUTTON.middle, defines.get('BTN_MIDDLE'));
});

test('X11 é evdev + 8', () => {
	assert.equal(keymap.x11Keycode('KeyA'), 38);
	assert.equal(keymap.x11Keycode('Escape'), 9);
	assert.equal(keymap.x11Keycode('Semicolon'), 47); // o Ç do ABNT2
	assert.equal(keymap.x11Keycode('Nada'), null);
});

test('Windows: scancodes, estendidas e as que vão por VK', () => {
	assert.deepEqual(keymap.windowsKey('KeyA'), { vk: 0, scan: 0x1e, extended: false });
	assert.deepEqual(keymap.windowsKey('Semicolon'), { vk: 0, scan: 0x27, extended: false });
	assert.deepEqual(keymap.windowsKey('IntlRo'), { vk: 0, scan: 0x73, extended: false }); // o /? do ABNT2
	assert.deepEqual(keymap.windowsKey('ArrowUp'), { vk: 0, scan: 0x48, extended: true });
	assert.deepEqual(keymap.windowsKey('AltRight'), { vk: 0, scan: 0x38, extended: true });
	assert.deepEqual(keymap.windowsKey('MetaLeft'), { vk: 0, scan: 0x5b, extended: true });
	assert.deepEqual(keymap.windowsKey('NumpadEnter'), { vk: 0, scan: 0x1c, extended: true });
	assert.deepEqual(keymap.windowsKey('Pause'), { vk: 0x13, scan: 0x45, extended: false });
	assert.deepEqual(keymap.windowsKey('NumLock'), { vk: 0x90, scan: 0x45, extended: true });
	assert.deepEqual(keymap.windowsKey('PrintScreen'), { vk: 0x2c, scan: 0x37, extended: true });
	assert.equal(keymap.windowsKey('constructor'), null);
});

test('Mac: kVK_* e teclas que o Mac não tem', () => {
	assert.equal(keymap.macKeycode('KeyA'), 0x00);
	assert.equal(keymap.macKeycode('KeyZ'), 0x06);
	assert.equal(keymap.macKeycode('Enter'), 0x24);
	assert.equal(keymap.macKeycode('Backspace'), 0x33);
	assert.equal(keymap.macKeycode('Delete'), 0x75);
	assert.equal(keymap.macKeycode('MetaLeft'), 0x37);
	assert.equal(keymap.macKeycode('IntlBackslash'), 0x0a);
	assert.equal(keymap.macKeycode('PrintScreen'), null);
	assert.equal(keymap.macKeycode('toString'), null);
});

test('Mac: bandeiras das modificadoras apertadas', () => {
	assert.equal(keymap.macModifierFlags([]), 0);
	assert.equal(keymap.macModifierFlags(['ShiftLeft', 'KeyA']), 0x20002);
	assert.equal(keymap.macModifierFlags(['MetaLeft', 'AltRight']), 0x100000 | 0x8 | 0x80000 | 0x40);
	assert.equal(keymap.isModifierCode('ControlRight'), true);
	assert.equal(keymap.isModifierCode('CapsLock'), false);
});
