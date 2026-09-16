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

/** Um sistema de mentira: o cursor do sistema, o injetor (pontos = fração × 1000) e o que foi chamado. */
function fakeSystem(start = { x: 50, y: 60 }) {
	const calls = [];
	const system = { cursor: { ...start } };
	const injector = {
		pointOf: (x, y) => ({ x: x * 1000, y: y * 1000 }),
		moveTo: (point) => {
			system.cursor = { ...point };
			calls.push(['moveTo', point.x, point.y]);
		},
		move: () => assert.fail('com a leitura do cursor, o movimento não segue quem controla'),
		button: (button, down) => calls.push(['button', button, down]),
		wheel: (dx, dy) => calls.push(['wheel', dx, dy]),
		key: (code, down) => calls.push(['key', code, down]),
		close: () => calls.push(['close'])
	};
	const pointer = [];
	const backend = new NativeBackend(injector, {
		cursor: { read: () => ({ ...system.cursor }) },
		onPointer: (x, y) => pointer.push([x, y]),
		returnDelayMs: 15
	});
	return { calls, system, backend, pointer };
}
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('dois cursores: mover só desenha o laranja; o clique leva o do sistema e devolve depois', async () => {
	const { calls, system, backend, pointer } = fakeSystem();
	backend.apply({ type: 'move', x: 0.2, y: 0.3 });
	assert.deepEqual(calls, []);
	assert.deepEqual(pointer, [[0.2, 0.3]]);
	backend.apply({ type: 'button', button: 'left', action: 'down', x: 0.5, y: 0.5 });
	backend.apply({ type: 'move', x: 0.6, y: 0.6 }); // arrastando: o do sistema acompanha
	backend.apply({ type: 'button', button: 'left', action: 'up', x: 0.6, y: 0.6 });
	assert.deepEqual(calls, [
		['moveTo', 500, 500],
		['button', 'left', true],
		['moveTo', 600, 600],
		['moveTo', 600, 600],
		['button', 'left', false]
	]);
	await wait(40);
	assert.deepEqual(calls.at(-1), ['moveTo', 50, 60]);
	assert.deepEqual(system.cursor, { x: 50, y: 60 });
	assert.equal(pointer.length, 4);
});

test('dois cursores: clique duplo não devolve no meio, e quem mexeu no mouse fica com ele', async () => {
	const { calls, system, backend } = fakeSystem();
	const click = (x) => {
		backend.apply({ type: 'button', button: 'left', action: 'down', x, y: 0.1 });
		backend.apply({ type: 'button', button: 'left', action: 'up', x, y: 0.1 });
	};
	click(0.4);
	click(0.4);
	await wait(40);
	assert.deepEqual(
		calls.filter((call) => call[0] === 'moveTo'),
		[
			['moveTo', 400, 100],
			['moveTo', 400, 100],
			['moveTo', 400, 100],
			['moveTo', 400, 100],
			['moveTo', 50, 60]
		]
	);
	// Agora a pessoa mexe no próprio mouse logo depois do clique remoto: nada volta.
	click(0.9);
	system.cursor = { x: 700, y: 20 };
	await wait(40);
	assert.deepEqual(system.cursor, { x: 700, y: 20 });
	// E o próximo clique guarda a casa nova.
	backend.apply({ type: 'wheel', dx: 0, dy: 120, x: 0.3, y: 0.3 });
	await wait(40);
	assert.deepEqual(calls.slice(-3), [
		['moveTo', 300, 300],
		['wheel', 0, 120],
		['moveTo', 700, 20]
	]);
});

test('dois cursores: parar solta o botão e devolve o cursor na hora', async () => {
	const { calls, system, backend } = fakeSystem({ x: 5, y: 5 });
	backend.apply({ type: 'button', button: 'right', action: 'down', x: 0.2, y: 0.2 });
	backend.apply({ type: 'button', button: 'left', action: 'up', x: 0.2, y: 0.2 }); // nunca apertado: descartado
	await backend.close();
	assert.deepEqual(calls, [
		['moveTo', 200, 200],
		['button', 'right', true],
		['button', 'right', false],
		['moveTo', 5, 5],
		['close']
	]);
	assert.deepEqual(system.cursor, { x: 5, y: 5 });
	await wait(30);
	assert.equal(calls.length, 5);
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
