// A troca de código da atualização leve: qual pacote abrir, quando promover o
// que foi baixado e quando desistir de um que não abre. É a parte que, errada,
// deixa a pessoa com um app que não liga — por isso cada caminho tem teste.
// O Electron é simulado; roda sobre o `out/` compilado: `npm test`.
const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } = require('node:fs');
const Module = require('node:module');
const { tmpdir } = require('node:os');
const path = require('node:path');
const test = require('node:test');

const OUT = path.join(__dirname, '..', 'out');

/** Carrega o `bundle-store` com um Electron de mentira apontando para uma pasta descartável. */
function comLoja(versaoDoInstalador, fn) {
	const userData = mkdtempSync(path.join(tmpdir(), 'rawly-bundles-'));
	const electron = {
		app: {
			getPath: () => userData,
			getVersion: () => versaoDoInstalador,
			isPackaged: true
		}
	};
	const original = Module._load;
	Module._load = function load(request, parent, isMain) {
		if (request === 'electron') return electron;
		return original.call(this, request, parent, isMain);
	};
	for (const id of Object.keys(require.cache)) if (id.startsWith(OUT)) delete require.cache[id];
	try {
		const loja = require(path.join(OUT, 'bundle-store.js'));
		const bundles = path.join(userData, 'bundles');
		return fn(loja, {
			bundles,
			/** Finge um pacote baixado com aquele nome. */
			criar(arquivo) {
				mkdirSync(bundles, { recursive: true });
				writeFileSync(path.join(bundles, arquivo), 'pacote');
			},
			estado: () => JSON.parse(readFileSync(path.join(bundles, 'estado.json'), 'utf8'))
		});
	} finally {
		Module._load = original;
		rmSync(userData, { recursive: true, force: true });
	}
}

test('sem nada baixado, abre o que veio no instalador', () => {
	comLoja('0.7.7', (loja) => {
		assert.equal(loja.escolherBundle(), null);
		assert.equal(loja.versaoEmUso(), '0.7.7');
	});
});

test('o que foi baixado só entra na abertura seguinte, e vira o ativo', () => {
	comLoja('0.7.7', (loja, ajuda) => {
		ajuda.criar('Rawly-bundle-0.7.8.asar');
		loja.gravarEstado({ ativa: null, proxima: { versao: '0.7.8', arquivo: 'Rawly-bundle-0.7.8.asar' } });

		const escolhido = loja.escolherBundle();
		assert.equal(escolhido, path.join(ajuda.bundles, 'Rawly-bundle-0.7.8.asar'));
		assert.equal(loja.versaoEmUso(), '0.7.8');
		const estado = ajuda.estado();
		assert.equal(estado.proxima, null);
		assert.equal(estado.ativa.versao, '0.7.8');
		// A marca sobe ANTES de carregar: é ela que denuncia um pacote que quebra.
		assert.equal(estado.ativa.tentativas, 1);
	});
});

test('abrir bem zera a contagem; duas aberturas sem chegar ao fim derrubam o pacote', () => {
	comLoja('0.7.7', (loja, ajuda) => {
		ajuda.criar('Rawly-bundle-0.7.8.asar');
		loja.gravarEstado({ ativa: null, proxima: { versao: '0.7.8', arquivo: 'Rawly-bundle-0.7.8.asar' } });

		loja.escolherBundle();
		loja.bundleAbriuBem();
		assert.equal(ajuda.estado().ativa.tentativas, 0);

		// Duas aberturas seguidas sem `bundleAbriuBem`.
		assert.ok(loja.escolherBundle());
		assert.ok(loja.escolherBundle());
		assert.equal(loja.escolherBundle(), null, 'na terceira o pacote já foi descartado');
		assert.equal(ajuda.estado().ativa, null);
		assert.equal(
			existsSync(path.join(ajuda.bundles, 'Rawly-bundle-0.7.8.asar')),
			false,
			'o arquivo ruim é apagado'
		);
		assert.equal(loja.versaoEmUso(), '0.7.7');
	});
});

test('instalador que alcançou o pacote o aposenta', () => {
	comLoja('0.8.0', (loja, ajuda) => {
		ajuda.criar('Rawly-bundle-0.7.9.asar');
		loja.gravarEstado({
			ativa: { versao: '0.7.9', arquivo: 'Rawly-bundle-0.7.9.asar', tentativas: 0 },
			proxima: null
		});
		assert.equal(loja.escolherBundle(), null);
		assert.equal(loja.versaoEmUso(), '0.8.0');
	});
});

test('pacote anotado mas com o arquivo sumido não trava a abertura', () => {
	comLoja('0.7.7', (loja) => {
		loja.gravarEstado({
			ativa: { versao: '0.7.8', arquivo: 'Rawly-bundle-0.7.8.asar', tentativas: 0 },
			proxima: null
		});
		assert.equal(loja.escolherBundle(), null);
	});
});

test('a comparação de versão é por número, não por texto', () => {
	comLoja('0.7.7', (loja) => {
		assert.ok(loja.compararVersao('0.7.10', '0.7.9') > 0);
		assert.ok(loja.compararVersao('1.0.0', '0.9.9') > 0);
		assert.equal(loja.compararVersao('0.7.7', '0.7.7'), 0);
	});
});
