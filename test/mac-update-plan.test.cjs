// O atualizador próprio do Mac: qual zip, onde está o app, quando não dá para trocar e o script da troca. Roda sobre o `out/`: `npm test`.
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { bundleUpdateBlocker, macBundleOf, macSwapScript, pickMacZip, shellQuote } = require('../out/mac-update-plan.js');

const FILES = [
	{ url: 'Rawly-mac-x64.zip', sha512: 'a' },
	{ url: 'Rawly-mac-arm64.zip', sha512: 'b' },
	{ url: 'Rawly-mac-x64.dmg', sha512: 'c' },
	{ url: 'Rawly-mac-arm64.dmg', sha512: 'd' }
];

test('o zip da arquitetura, nunca o dmg', () => {
	assert.equal(pickMacZip(FILES, 'arm64')?.url, 'Rawly-mac-arm64.zip');
	assert.equal(pickMacZip(FILES, 'x64')?.url, 'Rawly-mac-x64.zip');
	assert.equal(pickMacZip(FILES.filter((f) => f.url.endsWith('.dmg')), 'arm64'), null);
});

test('o pacote .app a partir do executável', () => {
	assert.equal(macBundleOf('/Applications/Rawly.app/Contents/MacOS/Rawly'), '/Applications/Rawly.app');
	assert.equal(macBundleOf('/Users/vf/Aplicativos Meus/Rawly.app/Contents/MacOS/Rawly'), '/Users/vf/Aplicativos Meus/Rawly.app');
	assert.equal(macBundleOf('/opt/Rawly/rawly-desktop'), null);
});

test('aberto do dmg ou translocado não se atualiza', () => {
	assert.match(bundleUpdateBlocker('/Volumes/Rawly 0.4.2/Rawly.app') ?? '', /instalador/);
	assert.match(bundleUpdateBlocker('/private/var/folders/x/AppTranslocation/ABC/d/Rawly.app') ?? '', /fora de Aplicativos/);
	assert.equal(bundleUpdateBlocker('/Applications/Rawly.app'), null);
});

test('aspas do shell seguram espaço, acento e aspas simples', () => {
	const out = execFileSync('/bin/bash', ['-c', `printf %s ${shellQuote("/Users/joão d'arc/Rawly.app")}`]).toString();
	assert.equal(out, "/Users/joão d'arc/Rawly.app");
});

function fakeApp(dir, name, version) {
	const bundle = path.join(dir, name);
	mkdirSync(path.join(bundle, 'Contents', 'MacOS'), { recursive: true });
	writeFileSync(path.join(bundle, 'Contents', 'versao.txt'), version);
	return bundle;
}

function deadPid() {
	const child = spawnSync('/bin/true');
	return child.pid;
}

test('o script espera o app, troca pelo novo e limpa a pasta de trabalho', () => {
	const root = mkdtempSync(path.join(tmpdir(), 'rawly-troca-'));
	try {
		const apps = path.join(root, 'Aplicativos com espaço');
		const work = path.join(root, 'trabalho');
		mkdirSync(apps);
		mkdirSync(work);
		const bundle = fakeApp(apps, 'Rawly.app', '0.4.1');
		const fresh = fakeApp(path.join(work, 'novo'), 'Rawly.app', '0.4.2');
		const script = path.join(root, 'trocar.sh');
		writeFileSync(script, macSwapScript({ pid: deadPid(), bundle, newBundle: fresh, workDir: work, reopen: false }));
		execFileSync('/bin/bash', [script]);
		assert.equal(readFileSync(path.join(bundle, 'Contents', 'versao.txt'), 'utf8'), '0.4.2');
		assert.equal(existsSync(`${bundle}.anterior`), false);
		assert.equal(existsSync(work), false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('sem o app novo, o antigo volta para o lugar', () => {
	const root = mkdtempSync(path.join(tmpdir(), 'rawly-troca-'));
	try {
		const bundle = fakeApp(root, 'Rawly.app', '0.4.1');
		const script = path.join(root, 'trocar.sh');
		writeFileSync(
			script,
			macSwapScript({ pid: deadPid(), bundle, newBundle: path.join(root, 'nao-existe.app'), workDir: path.join(root, 'trabalho'), reopen: false })
		);
		execFileSync('/bin/bash', [script]);
		assert.equal(readFileSync(path.join(bundle, 'Contents', 'versao.txt'), 'utf8'), '0.4.1');
		assert.equal(existsSync(`${bundle}.anterior`), false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
