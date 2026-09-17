// A licença do controle remoto: assinatura, prazo, repetição e o relógio. Roda sobre o `out/`: `npm test`.
const assert = require('node:assert/strict');
const test = require('node:test');
const { generateKeyPairSync, sign, randomUUID } = require('node:crypto');
const { LeaseClock, leaseKeyFor, MAX_CLOCK_SKEW_MS, publicKeyFromBase64, verifyLease } = require('../../out/remote-control/lease.js');

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const rawPublic = Buffer.from(publicKey.export({ format: 'der', type: 'spki' })).subarray(-32).toString('base64');
const key = publicKeyFromBase64(rawPublic);

function lease({ sid = 's1', n = randomUUID(), iat = Date.now(), ttl = 30_000, signer = privateKey } = {}) {
	const body = `v1.${Buffer.from(JSON.stringify({ sid, n, iat, exp: iat + ttl })).toString('base64url')}`;
	return `${body}.${sign(null, Buffer.from(body), signer).toString('base64url')}`;
}

test('licença assinada vale pelo tempo que dá', () => {
	const now = Date.now();
	const verified = verifyLease(lease({ iat: now }), key, now);
	assert.equal(verified.sessionId, 's1');
	assert.equal(verified.ttlMs, 30_000);
});

test('assinatura de outra chave, formato quebrado ou prazo absurdo: recusa', () => {
	const other = generateKeyPairSync('ed25519').privateKey;
	assert.equal(verifyLease(lease({ signer: other }), key), null);
	assert.equal(verifyLease('v1.abc', key), null);
	assert.equal(verifyLease(lease().replace('v1.', 'v2.'), key), null);
	assert.equal(verifyLease(lease({ ttl: 10 * 60_000 }), key), null);
	assert.equal(verifyLease(lease({ ttl: 0 }), key), null);
	assert.equal(verifyLease(lease(), null), null);
	// Mexer nos dados invalida a assinatura.
	const [v, data, sig] = lease().split('.');
	const forged = Buffer.from(JSON.stringify({ sid: 's1', n: 'x', iat: Date.now(), exp: Date.now() + 100_000 })).toString('base64url');
	assert.equal(verifyLease(`${v}.${forged}.${sig}`, key), null);
	assert.ok(data);
});

test('relógio do computador longe do servidor: recusa a licença velha', () => {
	const now = Date.now();
	assert.equal(verifyLease(lease({ iat: now - MAX_CLOCK_SKEW_MS - 1000 }), key, now), null);
});

test('o prazo só cresce com licença nova da mesma sessão, e repetida não conta', () => {
	const t0 = 1_000_000;
	const first = { sessionId: 's1', nonce: 'a', ttlMs: 30_000 };
	const clock = new LeaseClock(first, t0);
	assert.equal(clock.valid(t0 + 29_000), true);
	assert.equal(clock.valid(t0 + 31_000), false);
	assert.equal(clock.extend({ sessionId: 's1', nonce: 'a', ttlMs: 30_000 }, t0 + 20_000), false);
	assert.equal(clock.extend({ sessionId: 's2', nonce: 'b', ttlMs: 30_000 }, t0 + 20_000), false);
	assert.equal(clock.extend({ sessionId: 's1', nonce: 'b', ttlMs: 30_000 }, t0 + 20_000), true);
	assert.equal(clock.valid(t0 + 49_000), true);
	assert.equal(clock.valid(t0 + 51_000), false);
});

test('a chave é a do ambiente aberto', () => {
	assert.ok(leaseKeyFor(new URL('https://rawly-ten.vercel.app')));
	assert.ok(leaseKeyFor(new URL('http://localhost:3100')));
	assert.equal(leaseKeyFor(new URL('https://outro-site.example')), null);
});
