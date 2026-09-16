// Fila de eventos, teclas presas, fontes compartilhadas e o lado nativo com um injetor falso.
// Roda sobre o `out/` compilado: `npm test`.
const assert = require('node:assert/strict');
const test = require('node:test');
const { InputQueue, PressedState } = require('../../out/remote-control/backend.js');
const { NativeBackend } = require('../../out/remote-control/native-backend.js');
const { parsePortalStreams } = require('../../out/remote-control/portal-backend.js');
const { SharedSourceRegistry } = require('../../out/remote-control/shared-sources.js');

const move = (x) => ({ type: 'move', x, y: 0 });
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

test('fila: ordem mantida e movimentos acumulados viram o último', async () => {
	const applied = [];
	let release;
	const gate = new Promise((resolve) => {
		release = resolve;
	});
	const queue = new InputQueue(
		async (event) => {
			applied.push(event);
			if (applied.length === 1) await gate;
		},
		() => assert.fail('não devia dar erro')
	);
	queue.push(move(0.1));
	queue.push(move(0.2));
	queue.push(move(0.3));
	queue.push({ type: 'button', button: 'left', action: 'down', x: 0.3, y: 0 });
	queue.push(move(0.4));
	queue.push(move(0.5));
	assert.equal(queue.size, 3); // o primeiro já saiu; 0.2 virou 0.3; 0.4 virou 0.5
	release();
	await tick();
	assert.deepEqual(
		applied.map((event) => (event.type === 'move' ? event.x : event.type)),
		[0.1, 0.3, 'button', 0.5]
	);
});

test('fila: erro para tudo e avisa uma vez; close espera o que está em curso', async () => {
	const errors = [];
	const applied = [];
	const queue = new InputQueue(
		(event) => {
			applied.push(event);
			if (event.x === 0.2) throw new Error('falhou');
		},
		(error) => errors.push(error.message)
	);
	queue.push(move(0.1));
	queue.push({ type: 'key', code: 'KeyA', key: 'a', action: 'down' });
	queue.push(move(0.2));
	queue.push({ type: 'key', code: 'KeyA', key: 'a', action: 'up' });
	await tick();
	queue.push(move(0.9));
	await tick();
	assert.deepEqual(errors, ['falhou']);
	assert.equal(applied.length, 3);

	let finished = false;
	const slow = new InputQueue(
		() =>
			new Promise((resolve) =>
				setTimeout(() => {
					finished = true;
					resolve();
				}, 20)
			),
		() => {}
	);
	slow.push(move(0.1));
	slow.push({ type: 'key', code: 'KeyB', key: 'b', action: 'down' });
	await slow.close();
	assert.equal(finished, true);
	assert.equal(slow.size, 0);
});

test('teclas presas: soltar o que não foi apertado é descartado; drain solta modificadoras por último', () => {
	const state = new PressedState();
	assert.equal(state.key('KeyA', false), false);
	assert.equal(state.key('ShiftLeft', true), true);
	assert.equal(state.key('KeyA', true), true);
	assert.equal(state.key('KeyA', true), true); // repetição do teclado segue
	assert.equal(state.key('ControlLeft', true), true);
	assert.equal(state.button('left', true), true);
	assert.equal(state.button('right', false), false);
	assert.deepEqual(state.drain(), { buttons: ['left'], keys: ['KeyA', 'ControlLeft', 'ShiftLeft'] });
	assert.deepEqual(state.drain(), { buttons: [], keys: [] });
});

test('nativo: move antes do clique, ignora tecla desconhecida e solta tudo ao fechar', async () => {
	const calls = [];
	const injector = {
		move: (x, y, held) => calls.push(['move', x, y, held.join('+')]),
		button: (button, down, held) => calls.push(['button', button, down, held.join('+')]),
		wheel: (dx, dy) => calls.push(['wheel', dx, dy]),
		key: (code, down, held) => calls.push(['key', code, down, held.join('+')]),
		close: () => calls.push(['close'])
	};
	const backend = new NativeBackend(injector);
	backend.apply({ type: 'key', code: 'ShiftLeft', key: 'Shift', action: 'down' });
	backend.apply({ type: 'button', button: 'left', action: 'down', x: 0.5, y: 0.25 });
	backend.apply({ type: 'button', button: 'right', action: 'up', x: 0.5, y: 0.25 });
	backend.apply({ type: 'wheel', dx: 0, dy: 100, x: 0.1, y: 0.2 });
	backend.apply({ type: 'key', code: 'Unidentified', key: 'x', action: 'down' });
	await backend.close();
	assert.deepEqual(calls, [
		['key', 'ShiftLeft', true, 'ShiftLeft'],
		['move', 0.5, 0.25, 'ShiftLeft'],
		['button', 'left', true, 'ShiftLeft'],
		['move', 0.5, 0.25, 'ShiftLeft'],
		['move', 0.1, 0.2, 'ShiftLeft'],
		['wheel', 0, 100],
		['button', 'left', false, 'ShiftLeft'],
		['key', 'ShiftLeft', false, ''],
		['close']
	]);
});

test('fontes compartilhadas: da mais antiga para a mais nova, sem repetir', () => {
	let now = 1000;
	const registry = new SharedSourceRegistry(3, () => now++);
	registry.record({ id: 'screen:1:0', name: 'Tela 1', display_id: '1' });
	registry.record({ id: 'window:9:0', name: 'Planilha', display_id: '' });
	registry.record({ id: 'screen:2:0', name: 'Tela 2', display_id: '2' });
	registry.record({ id: 'screen:1:0', name: 'Tela 1', display_id: '1' });
	assert.deepEqual(registry.list(), [
		{ sourceId: 'window:9:0', displayId: null, name: 'Planilha', at: 1001 },
		{ sourceId: 'screen:2:0', displayId: '2', name: 'Tela 2', at: 1002 },
		{ sourceId: 'screen:1:0', displayId: '1', name: 'Tela 1', at: 1003 }
	]);
	assert.equal(registry.latestScreen().sourceId, 'screen:1:0');
	registry.record({ id: 'screen:3:0', name: 'Tela 3', display_id: '3' });
	assert.equal(registry.list().length, 3);
	assert.equal(registry.find('window:9:0'), null);
	registry.list()[0].name = 'mexido';
	assert.equal(registry.list()[0].name, 'Tela 2');
	assert.equal(new SharedSourceRegistry().latestScreen(), null);
});

test('portal: primeiro stream com tamanho', () => {
	const variant = (value) => ({ signature: 'x', value });
	assert.deepEqual(
		parsePortalStreams([
			[40, { position: variant([0, 0]) }],
			[41, { size: variant([2560, 1440]), position: variant([0, 0]) }]
		]),
		{ node: 41, size: { width: 2560, height: 1440 } }
	);
	assert.equal(parsePortalStreams([[41, { size: variant([0, 1440]) }]]), null);
	assert.equal(parsePortalStreams('nada'), null);
	assert.equal(parsePortalStreams([]), null);
});
