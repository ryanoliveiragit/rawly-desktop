// Bytes do INPUT[] do SendInput, conferidos contra o layout que o koffi calcula para as structs
// do Windows de 64 bits (o alinhamento é o mesmo no Linux x64). Roda sobre o `out/`: `npm test`.
const assert = require('node:assert/strict');
const test = require('node:test');
const win = require('../../out/remote-control/windows-input.js');
const { windowsKey } = require('../../out/remote-control/keymap.js');

let koffi = null;
try {
	koffi = require('koffi');
} catch {
	// Sem o binário do koffi nesta máquina: os testes de bytes fixos ainda valem.
}

test('tamanho e posições do INPUT', () => {
	assert.equal(win.INPUT_SIZE, 40);
	const buffer = win.encodeInputs([
		{ kind: 'mouse', dx: -5, dy: 65535, mouseData: -120, flags: win.MOUSEEVENTF.WHEEL },
		{ kind: 'key', vk: 0x13, scan: 0x45, flags: win.KEYEVENTF.KEYUP }
	]);
	assert.equal(buffer.length, 80);
	assert.equal(buffer.readUInt32LE(0), 0); // INPUT_MOUSE
	assert.equal(buffer.readInt32LE(8), -5);
	assert.equal(buffer.readInt32LE(12), 65535);
	assert.equal(buffer.readInt32LE(16), -120);
	assert.equal(buffer.readUInt32LE(20), 0x0800);
	assert.equal(buffer.readUInt32LE(40), 1); // INPUT_KEYBOARD
	assert.equal(buffer.readUInt16LE(48), 0x13);
	assert.equal(buffer.readUInt16LE(50), 0x45);
	assert.equal(buffer.readUInt32LE(52), 0x0002);
});

test('layout igual ao das structs do Windows x64 (koffi)', { skip: !koffi && 'koffi indisponível' }, () => {
	const MOUSEINPUT = koffi.struct({
		dx: 'int32',
		dy: 'int32',
		mouseData: 'uint32',
		dwFlags: 'uint32',
		time: 'uint32',
		dwExtraInfo: 'uint64'
	});
	const KEYBDINPUT = koffi.struct({ wVk: 'uint16', wScan: 'uint16', dwFlags: 'uint32', time: 'uint32', dwExtraInfo: 'uint64' });
	const INPUT = koffi.struct({ type: 'uint32', u: koffi.union({ mi: MOUSEINPUT, ki: KEYBDINPUT }) });
	assert.equal(koffi.sizeof(INPUT), win.INPUT_SIZE);

	const MOUSE = koffi.struct({ type: 'uint32', mi: MOUSEINPUT });
	const KEY = koffi.struct({ type: 'uint32', ki: KEYBDINPUT });

	const mouse = Buffer.alloc(koffi.sizeof(MOUSE));
	koffi.encode(mouse, MOUSE, {
		type: 0,
		mi: { dx: 123, dy: 456, mouseData: 0, dwFlags: 0x8001 | 0x4000, time: 0, dwExtraInfo: 0 }
	});
	const ours = win.encodeInputs([win.mouseMoveInput({ x: 123, y: 456 })]);
	assert.deepEqual(ours.subarray(0, mouse.length), mouse);

	const key = Buffer.alloc(koffi.sizeof(KEY));
	koffi.encode(key, KEY, { type: 1, ki: { wVk: 0, wScan: 0x48, dwFlags: 0x8 | 0x2 | 0x1, time: 0, dwExtraInfo: 0 } });
	const oursKey = win.encodeInputs([win.keyboardInput(windowsKey('ArrowUp'), false)]);
	assert.deepEqual(oursKey.subarray(0, key.length), key);
});

test('mouse: mover absoluto na área virtual, botões e roda', () => {
	assert.deepEqual(win.mouseMoveInput({ x: 10, y: 20 }), {
		kind: 'mouse',
		dx: 10,
		dy: 20,
		mouseData: 0,
		flags: 0x0001 | 0x8000 | 0x4000
	});
	assert.equal(win.mouseButtonInput('left', true).flags, 0x0002);
	assert.equal(win.mouseButtonInput('left', false).flags, 0x0004);
	assert.equal(win.mouseButtonInput('right', true).flags, 0x0008);
	assert.equal(win.mouseButtonInput('middle', false).flags, 0x0040);
	// Navegador: y positivo desce; Windows: roda positiva sobe.
	assert.deepEqual(win.mouseWheelInputs({ x: 0, y: 120 }), [
		{ kind: 'mouse', dx: 0, dy: 0, mouseData: -120, flags: 0x0800 }
	]);
	assert.deepEqual(win.mouseWheelInputs({ x: 60, y: 0 }), [{ kind: 'mouse', dx: 0, dy: 0, mouseData: 60, flags: 0x1000 }]);
	assert.deepEqual(win.mouseWheelInputs({ x: 0, y: 0 }), []);
});

test('teclado: scancode com estendida, VK nas especiais', () => {
	assert.deepEqual(win.keyboardInput(windowsKey('KeyA'), true), { kind: 'key', vk: 0, scan: 0x1e, flags: 0x0008 });
	assert.deepEqual(win.keyboardInput(windowsKey('ControlRight'), false), {
		kind: 'key',
		vk: 0,
		scan: 0x1d,
		flags: 0x0008 | 0x0002 | 0x0001
	});
	assert.deepEqual(win.keyboardInput(windowsKey('PrintScreen'), true), { kind: 'key', vk: 0x2c, scan: 0x37, flags: 0x0001 });
	assert.deepEqual(win.keyboardInput(windowsKey('Pause'), false), { kind: 'key', vk: 0x13, scan: 0x45, flags: 0x0002 });
});
