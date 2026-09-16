// Validação do que o site manda à ponte do controle remoto. Roda sobre o `out/` compilado: `npm test`.
const assert = require('node:assert/strict');
const test = require('node:test');
const { controllerLabel, parseRemoteInput, parseStartOptions } = require('../../out/remote-control/protocol.js');

test('eventos válidos passam, com coordenadas presas entre 0 e 1', () => {
	assert.deepEqual(parseRemoteInput({ type: 'move', x: 0.25, y: 1.5 }), { type: 'move', x: 0.25, y: 1 });
	assert.deepEqual(parseRemoteInput({ type: 'button', button: 'right', action: 'down', x: -1, y: 0.5, extra: 1 }), {
		type: 'button',
		button: 'right',
		action: 'down',
		x: 0,
		y: 0.5
	});
	assert.deepEqual(parseRemoteInput({ type: 'wheel', dx: 0, dy: 99999, x: 0.5, y: 0.5 }), {
		type: 'wheel',
		dx: 0,
		dy: 4000,
		x: 0.5,
		y: 0.5
	});
	assert.deepEqual(parseRemoteInput({ type: 'key', code: 'Semicolon', key: 'ç', action: 'up' }), {
		type: 'key',
		code: 'Semicolon',
		key: 'ç',
		action: 'up'
	});
});

test('lixo é descartado', () => {
	for (const value of [
		null,
		'move',
		[],
		{ type: 'move', x: '0.5', y: 0.5 },
		{ type: 'move', x: Number.NaN, y: 0.5 },
		{ type: 'move', x: Infinity, y: 0.5 },
		{ type: 'button', button: 'back', action: 'down', x: 0, y: 0 },
		{ type: 'button', button: 'left', action: 'click', x: 0, y: 0 },
		{ type: 'wheel', dx: 1, x: 0, y: 0 },
		{ type: 'key', code: 'Key A', key: 'a', action: 'down' },
		{ type: 'key', code: '', key: 'a', action: 'down' },
		{ type: 'key', code: 'x'.repeat(33), key: 'a', action: 'down' },
		{ type: 'key', code: 'KeyA', key: 'a' },
		{ type: 'exec', command: 'rm -rf /' }
	]) {
		assert.equal(parseRemoteInput(value), null, JSON.stringify(value));
	}
});

test('nome de quem controla: uma linha, curto, com reserva', () => {
	assert.equal(controllerLabel('  Ana\nPaula‮  '), 'Ana Paula');
	assert.equal(controllerLabel(''), 'Alguém');
	assert.equal(controllerLabel(42), 'Alguém');
	assert.equal(Array.from(controllerLabel('😀'.repeat(100))).length, 60);
});

test('opções de start', () => {
	assert.deepEqual(parseStartOptions({ controllerName: 'Bia', sourceId: 'screen:1:0' }), {
		controllerName: 'Bia',
		sourceId: 'screen:1:0'
	});
	assert.deepEqual(parseStartOptions({ controllerName: 'Bia', sourceId: 7 }), { controllerName: 'Bia', sourceId: null });
	assert.deepEqual(parseStartOptions(undefined), { controllerName: 'Alguém', sourceId: null });
});
