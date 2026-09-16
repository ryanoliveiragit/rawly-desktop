// Mapeamento de coordenadas do controle remoto. Roda sobre o `out/` compilado: `npm test`.
const assert = require('node:assert/strict');
const test = require('node:test');
const geometry = require('../../out/remote-control/geometry.js');

const left = { id: 11, bounds: { x: -1920, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 };
const primary = { id: 22, bounds: { x: 0, y: 0, width: 1707, height: 960 }, scaleFactor: 1.5 };
const right = { id: 33, bounds: { x: 1707, y: 0, width: 1280, height: 720 }, scaleFactor: 2 };
const displays = [left, primary, right];

test('id da fonte do desktopCapturer', () => {
	assert.equal(geometry.screenIdFromSourceId('screen:33:0'), '33');
	assert.equal(geometry.screenIdFromSourceId('screen:2'), '2');
	assert.equal(geometry.screenIdFromSourceId('window:1234:0'), null);
	assert.equal(geometry.screenIdFromSourceId(null), null);
	assert.equal(geometry.isWindowSource('window:1234:0'), true);
	assert.equal(geometry.isWindowSource('screen:1:0'), false);
});

test('escolhe a tela pelo display_id, depois pelo id da fonte', () => {
	assert.deepEqual(geometry.pickDisplay(displays, { displayId: '33', sourceId: 'screen:11:0' }, 22), {
		display: right,
		exact: true
	});
	assert.deepEqual(geometry.pickDisplay(displays, { displayId: '', sourceId: 'screen:11:0' }, 22), {
		display: left,
		exact: true
	});
});

test('sem saber qual é: a única tela, ou a principal marcada como palpite', () => {
	assert.deepEqual(geometry.pickDisplay([right], { displayId: null, sourceId: null }, 22), { display: right, exact: true });
	assert.deepEqual(geometry.pickDisplay(displays, { displayId: '99', sourceId: null }, 22), {
		display: primary,
		exact: false
	});
	assert.equal(geometry.pickDisplay([], { displayId: '1', sourceId: null }, 1), null);
});

test('DIP (Mac): cantos e limites', () => {
	assert.deepEqual(geometry.toDipPoint(0, 0, left.bounds), { x: -1920, y: 0 });
	assert.deepEqual(geometry.toDipPoint(0.5, 0.5, left.bounds), { x: -960, y: 540 });
	assert.deepEqual(geometry.toDipPoint(1, 1, left.bounds), { x: -1, y: 1079 });
	assert.deepEqual(geometry.toDipPoint(7, -3, left.bounds), { x: -1, y: 0 });
});

test('pixel físico com escala de 150% e 200%', () => {
	// 1707 × 1,5 = 2560,5 → 2561 px de largura; 960 × 1,5 = 1440.
	assert.deepEqual(geometry.toPhysicalPoint(0, 0, { x: 0, y: 0 }, primary.bounds, 1.5), { x: 0, y: 0 });
	assert.deepEqual(geometry.toPhysicalPoint(0.5, 0.5, { x: 0, y: 0 }, primary.bounds, 1.5), { x: 1280, y: 720 });
	assert.deepEqual(geometry.toPhysicalPoint(1, 1, { x: 0, y: 0 }, primary.bounds, 1.5), { x: 2560, y: 1439 });
	// Tela à direita começando no pixel físico 2561.
	assert.deepEqual(geometry.toPhysicalPoint(0.25, 0.5, { x: 2561, y: 0 }, right.bounds, 2), { x: 2561 + 640, y: 720 });
	// Tela à esquerda (origem negativa).
	assert.deepEqual(geometry.toPhysicalPoint(0.5, 0, { x: -1920, y: 0 }, left.bounds, 1), { x: -960, y: 0 });
});

test('origem física de reserva (X11)', () => {
	assert.deepEqual(geometry.fallbackPhysicalOrigin(right.bounds, 2, { x: 2561, y: 0 }), { x: 2561, y: 0 });
	assert.deepEqual(geometry.fallbackPhysicalOrigin(right.bounds, 2, null), { x: 3414, y: 0 });
	assert.deepEqual(geometry.fallbackPhysicalOrigin(primary.bounds, 0, undefined), { x: 0, y: 0 });
});

test('SendInput: 0–65535 sobre a área de trabalho virtual', () => {
	const virtualScreen = { x: -1920, y: 0, width: 1920 + 2561 + 2560, height: 1440 };
	assert.deepEqual(geometry.toVirtualDeskAbsolute({ x: -1920, y: 0 }, virtualScreen), { x: 0, y: 0 });
	assert.deepEqual(geometry.toVirtualDeskAbsolute({ x: 2561 + 2560 - 1, y: 1439 }, virtualScreen), { x: 65535, y: 65535 });
	const middle = geometry.toVirtualDeskAbsolute({ x: 0, y: 720 }, virtualScreen);
	assert.equal(middle.x, Math.round((1920 * 65535) / (virtualScreen.width - 1)));
	assert.equal(middle.y, Math.round((720 * 65535) / 1439));
	assert.deepEqual(geometry.toVirtualDeskAbsolute({ x: -5000, y: 99999 }, virtualScreen), { x: 0, y: 65535 });
});

test('stream do portal: pixels lógicos dentro do tamanho', () => {
	assert.deepEqual(geometry.toStreamPoint(0.5, 0.25, { width: 1920, height: 1080 }), { x: 960, y: 270 });
	assert.deepEqual(geometry.toStreamPoint(1, 1, { width: 1920, height: 1080 }), { x: 1919, y: 1079 });
	assert.deepEqual(geometry.toStreamPoint(Number.NaN, -1, { width: 1920, height: 1080 }), { x: 0, y: 0 });
});

test('roda: passos inteiros e o resto guardado', () => {
	const wheel = new geometry.WheelAccumulator(60);
	assert.deepEqual(wheel.push(0, 100), { x: 0, y: 1 });
	assert.deepEqual(wheel.push(0, 30), { x: 0, y: 1 }); // 40 + 30 = 70
	assert.deepEqual(wheel.push(-130, -10), { x: -2, y: 0 }); // resto y 0
	assert.deepEqual(wheel.push(0, -60), { x: 0, y: -1 });
	wheel.reset();
	assert.deepEqual(wheel.push(59, 59), { x: 0, y: 0 });
	const windows = new geometry.WheelAccumulator(100 / 120);
	assert.deepEqual(windows.push(0, 100), { x: 0, y: 120 });
});
