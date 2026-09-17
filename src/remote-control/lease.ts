/**
 * A licença do controle remoto (pedido em 17/09/2026: "5 minutos diários, sem burlar").
 * O servidor desconta o tempo do plano e assina `v1.<dados>.<assinatura>` (Ed25519, base64url);
 * esta casca só injeta mouse e teclado enquanto uma licença válida vale. Recarregar a página,
 * mexer no site ou ficar sem internet não estende nada: sem renovar, a sessão para.
 *
 * O formato mora também em `src/lib/central/remote-control-lease.ts` (o site). As chaves
 * públicas são as de cada ambiente, derivadas do segredo do servidor
 * (`src/lib/server/central/remote-control-lease-key.ts`); `GET /api/desktop/licenca` mostra a
 * de um ambiente. Sem Electron: roda nos testes com `node --test`.
 */
import { createPublicKey, verify, type KeyObject } from 'node:crypto';

/** Produção (rawly-ten.vercel.app). */
const PRODUCTION_KEY = 'oohEf34qsWLwYQvXfEGJIA70TZBh5VTOZumdg1ADAWI=';
/** Desenvolvimento (localhost e 127.0.0.1, Doppler `dev`). */
const DEVELOPMENT_KEY = 'qpgQ9sg6eNO215KzhO6GDiY5cJZ+OGa/akp24nHf2VU=';

/** A licença mais longa que se aceita (o servidor dá 30 s). */
export const MAX_LEASE_MS = 120_000;
/** Relógio do computador diferente do servidor além disto: recusa (licença velha repetida). */
export const MAX_CLOCK_SKEW_MS = 10 * 60_000;
const MAX_TOKEN_CHARS = 1_000;

/** O cabeçalho DER SPKI de uma chave pública Ed25519 crua de 32 bytes. */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export interface VerifiedLease {
	sessionId: string;
	nonce: string;
	/** Quanto a licença vale a partir de agora, pelo relógio deste computador (ms). */
	ttlMs: number;
}

export function publicKeyFromBase64(raw: string): KeyObject {
	return createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(raw, 'base64')]), format: 'der', type: 'spki' });
}

/** A chave do ambiente que a casca abriu: produção, ou a de desenvolvimento só no próprio computador. */
export function leaseKeyFor(appUrl: URL): KeyObject | null {
	if (appUrl.origin === 'https://rawly-ten.vercel.app') return publicKeyFromBase64(PRODUCTION_KEY);
	if (appUrl.hostname === 'localhost' || appUrl.hostname === '127.0.0.1') return publicKeyFromBase64(DEVELOPMENT_KEY);
	return null;
}

/**
 * Confere a assinatura e o prazo. `now` é o relógio deste computador: o prazo vale pelo tempo
 * que a licença dá (`exp - iat`), e um relógio muito longe do servidor recusa.
 */
export function verifyLease(token: unknown, key: KeyObject | null, now = Date.now()): VerifiedLease | null {
	if (!key || typeof token !== 'string' || token.length > MAX_TOKEN_CHARS) return null;
	const parts = token.split('.');
	if (parts.length !== 3 || parts[0] !== 'v1' || !parts[1] || !parts[2]) return null;
	let valid = false;
	try {
		valid = verify(null, Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], 'base64url'));
	} catch {
		return null;
	}
	if (!valid) return null;
	let payload: unknown;
	try {
		payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
	} catch {
		return null;
	}
	if (typeof payload !== 'object' || payload === null) return null;
	const { sid, n, iat, exp } = payload as Record<string, unknown>;
	if (typeof sid !== 'string' || typeof n !== 'string' || typeof iat !== 'number' || typeof exp !== 'number') return null;
	const ttlMs = exp - iat;
	if (!Number.isFinite(ttlMs) || ttlMs <= 0 || ttlMs > MAX_LEASE_MS) return null;
	if (Math.abs(now - iat) > MAX_CLOCK_SKEW_MS) return null;
	return { sessionId: sid, nonce: n, ttlMs };
}

/**
 * O prazo de uma sessão: começa com a primeira licença e só cresce com licenças novas da mesma
 * sessão. Licença repetida (o mesmo `n`) não conta.
 */
export class LeaseClock {
	readonly sessionId: string;
	#deadline: number;
	readonly #seen = new Set<string>();

	constructor(first: VerifiedLease, now = Date.now()) {
		this.sessionId = first.sessionId;
		this.#seen.add(first.nonce);
		this.#deadline = now + first.ttlMs;
	}

	/** Estende com uma licença renovada; `false` se não é desta sessão ou já foi usada. */
	extend(lease: VerifiedLease, now = Date.now()): boolean {
		if (lease.sessionId !== this.sessionId || this.#seen.has(lease.nonce)) return false;
		this.#seen.add(lease.nonce);
		this.#deadline = Math.max(this.#deadline, now + lease.ttlMs);
		return true;
	}

	valid(now = Date.now()): boolean {
		return now <= this.#deadline;
	}

	get deadline(): number {
		return this.#deadline;
	}
}
