// O processo principal inteiro carrega sem quebrar (a 0.4.0 não abria: um script de página
// sobrescreveu um módulo e o `require` explodiu antes da janela) e o atalho global do microfone.
// O Electron é simulado; roda sobre o `out/` compilado: `npm test`.
const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');

/** Um Electron de mentira que acddeita qualquer chamada: o suficiente para os módulos carregarem. */
function electronStub(overrides = {}) {
	const handler = {
		get(target, prop) {
			if (prop === 'then') return undefined;
			if (prop === Symbol.toPrimitive) return () => '';
			if (prop in overrides) return overrides[prop];
			if (prop === 'getPath' || prop === 'getAppPath') return () => '/tmp/rawly-teste';
			if (prop === 'getVersion') return () => '0.0.0-teste';
			// O app nunca fica "pronto" no teste: só o carregamento dos módulos importa.
			if (prop === 'whenReady') return () => new Promise(() => {});
			return new Proxy(function stub() {}, handler);
		},
		apply() {
			return new Proxy(function stub() {}, handler);
		},
		construct() {
			return new Proxy(function stub() {}, handler);
		}
	};
	return new Proxy(function electron() {}, handler);
}

function withElectron(stub, fn) {
	const original = Module._load;
	Module._load = function load(request, parent, isMain) {
		if (request === 'electron') return stub;
		return original.call(this, request, parent, isMain);
	};
	try {
		return fn();
	} finally {
		Module._load = original;
	}
}

test('o processo principal carrega todos os módulos sem quebrar', () => {
	const out = path.join(__dirname, '..', 'out');
	for (const id of Object.keys(require.cache)) if (id.startsWith(out)) delete require.cache[id];
	withElectron(electronStub(), () => {
		assert.doesNotThrow(() => require(path.join(out, 'main.js')));
	});
	const carregados = Object.keys(require.cache).filter((id) => id.startsWith(out));
	for (const modulo of ['shortcuts.js', 'remote-control/index.js', 'remote-control/cursor-overlay.js']) {
		assert.ok(carregados.includes(path.join(out, modulo)), `${modulo} devia ter carregado`);
	}
});

test('atalho do microfone: só a origem do app, um dono por vez, solta ao sair', () => {
	const handlers = new Map();
	const registrados = new Map();
	const quit = [];
	let recusar = false;
	const ipcMain = { handle: (canal, fn) => handlers.set(canal, fn) };
	const globalShortcut = {
		register: (tecla, fn) => {
			if (recusar) return false;
			registrados.set(tecla, fn);
			return true;
		},
		unregister: (tecla) => registrados.delete(tecla),
		isRegistered: (tecla) => registrados.has(tecla)
	};
	const app = { on: (evento, fn) => evento === 'will-quit' && quit.push(fn) };
	const pagina = (id, url = 'https://rawly-ten.vercel.app/central') => {
		const ouvintes = new Map();
		const enviados = [];
		return {
			url,
			enviados,
			ouvintes,
			sender: {
				id,
				isDestroyed: () => false,
				send: (canal) => enviados.push(canal),
				on: (evento, fn) => ouvintes.set(evento, fn),
				removeListener: (evento) => ouvintes.delete(evento)
			}
		};
	};
	const out = path.join(__dirname, '..', 'out');
	for (const id of Object.keys(require.cache)) if (id.startsWith(out)) delete require.cache[id];
	const { installShortcuts, MUTE_SHORTCUT } = withElectron(electronStub({ ipcMain, globalShortcut, app }), () =>
		require(path.join(out, 'shortcuts.js'))
	);
	installShortcuts({ appUrl: new URL('https://rawly-ten.vercel.app') });
	const setMute = (p, enabled) => handlers.get('shortcut:mute')({ sender: p.sender, senderFrame: { url: p.url } }, enabled);

	const fora = pagina(9, 'https://outro-site.com/');
	assert.equal(setMute(fora, true), false);
	assert.equal(registrados.size, 0);

	const a = pagina(1);
	const b = pagina(2);
	assert.equal(setMute(a, true), true);
	registrados.get(MUTE_SHORTCUT)();
	assert.deepEqual(a.enviados, ['shortcut:mute-pressed']);
	// Outra janela pede: ela fica com o atalho; a primeira soltar não tira da segunda.
	assert.equal(setMute(b, true), true);
	assert.equal(setMute(a, false), false);
	assert.ok(registrados.has(MUTE_SHORTCUT));
	registrados.get(MUTE_SHORTCUT)();
	assert.deepEqual(b.enviados, ['shortcut:mute-pressed']);
	assert.deepEqual(a.enviados, ['shortcut:mute-pressed']);
	// Recarregar a página solta.
	b.ouvintes.get('did-navigate')();
	assert.equal(registrados.size, 0);
	// O sistema recusou: `false`, e a página usa o atalho com a janela em foco.
	recusar = true;
	assert.equal(setMute(a, true), false);
	recusar = false;
	assert.equal(setMute(a, true), true);
	quit.forEach((fn) => fn());
	assert.equal(registrados.size, 0);
});
