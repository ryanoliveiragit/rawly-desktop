// Sobe os instaladores de `dist/` — e o pacote leve de `dist/bundle/` — para o
// R2, em `downloads/desktop/<nome>`, de onde o site os serve
// (`/downloads/desktop/<nome>`) e o atualizador lê.
//
//   doppler run -p rawly -c prd -- npm run upload:r2
//   npm run upload:r2 -- --only Rawly-linux-x86_64.AppImage,latest-linux.yml
//   npm run upload:r2 -- --dry-run
//
// Só sobe o que o site aceita servir (a mesma lista de `src/lib/app/downloads.ts`
// na raiz do repositório): qualquer outro arquivo em `dist/` é ignorado. Os
// pacotes sobem antes dos `latest*.yml`, para o atualizador nunca ver um yml
// apontando para um arquivo que ainda não chegou. No fim, um HEAD confere o
// tamanho de cada objeto. Nada aqui imprime segredo.
import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

const DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
// O pacote leve (`npm run bundle`) sai numa pasta à parte, para não se misturar
// com os instaladores; no R2 os dois moram no mesmo prefixo.
const BUNDLE_DIR = path.join(DIST, 'bundle');
const PREFIX = 'downloads/desktop/';
const BUNDLE_MANIFEST = 'bundle-latest.json';

const INSTALLERS = [
	'Rawly-mac-arm64.dmg',
	'Rawly-mac-x64.dmg',
	'Rawly-Setup-x64.exe',
	'Rawly-linux-x86_64.AppImage',
	'Rawly-linux-amd64.deb',
	'Rawly-linux-x86_64.rpm'
];
const UPDATER_PACKAGES = ['Rawly-mac-arm64.zip', 'Rawly-mac-x64.zip'];
const MANIFESTS = ['latest.yml', 'latest-mac.yml', 'latest-linux.yml'];
const PACKAGES = [...INSTALLERS, ...UPDATER_PACKAGES];
const ALLOWED = [...PACKAGES, ...PACKAGES.map((f) => `${f}.blockmap`), ...MANIFESTS];

function env(name) {
	const value = process.env[name];
	if (!value) {
		console.error(`Falta ${name} no ambiente (rode com \`doppler run -p rawly -c prd --\`).`);
		process.exit(1);
	}
	return value;
}

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const onlyArg = args.find((a) => a.startsWith('--only='))?.slice('--only='.length);
const only = onlyArg ? new Set(onlyArg.split(',').map((s) => s.trim()).filter(Boolean)) : null;

const present = new Set(await readdir(DIST).catch(() => []));
const noBundle = new Set(await readdir(BUNDLE_DIR).catch(() => []));
const pacoteLeve = [...noBundle].filter((n) => /^Rawly-bundle-\d+\.\d+\.\d+\.asar$/.test(n));
// Ordem: pacotes e blockmaps primeiro, manifestos por último — e o
// `bundle-latest.json` depois do `.asar` que ele aponta, pela mesma razão.
const queue = [
	...pacoteLeve,
	...ALLOWED.filter((name) => present.has(name)),
	...(noBundle.has(BUNDLE_MANIFEST) ? [BUNDLE_MANIFEST] : [])
].filter((name) => !only || only.has(name));
if (queue.length === 0) {
	console.error(`Nada para subir em ${DIST}: nenhum arquivo da lista está lá.`);
	process.exit(1);
}
if (only) {
	for (const name of only) {
		if (!present.has(name) && !noBundle.has(name)) console.warn(`aviso: ${name} não está em dist/`);
	}
}

/** O pacote leve mora em `dist/bundle/`; o resto, direto em `dist/`. */
const pastaDe = (name) => (noBundle.has(name) && !present.has(name) ? BUNDLE_DIR : DIST);

const isManifest = (name) => name.endsWith('.yml') || name === BUNDLE_MANIFEST;
const contentTypeOf = (name) =>
	name === BUNDLE_MANIFEST
		? 'application/json; charset=utf-8'
		: isManifest(name)
			? 'text/yaml; charset=utf-8'
			: 'application/octet-stream';
const cacheControlOf = (name) =>
	// O pacote leve leva a versão no nome: aquele arquivo nunca muda, então pode
	// ficar guardado o dia inteiro.
	isManifest(name) ? 'no-cache' : name.endsWith('.asar') ? 'public, max-age=86400' : 'public, max-age=300';
const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

console.log(`${dryRun ? '[simulação] ' : ''}${queue.length} arquivo(s) → r2:${PREFIX}`);
for (const name of queue) {
	const { size } = await stat(path.join(pastaDe(name), name));
	console.log(`  ${name} (${mb(size)})`);
}
if (dryRun) process.exit(0);

const accountId = env('R2_ACCOUNT_ID');
const bucket = env('R2_BUCKET');
const client = new S3Client({
	region: 'auto',
	endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
	credentials: { accessKeyId: env('R2_ACCESS_KEY_ID'), secretAccessKey: env('R2_SECRET_ACCESS_KEY') },
	// O R2 não aceita os checksums que o SDK passou a mandar por padrão.
	requestChecksumCalculation: 'WHEN_REQUIRED',
	responseChecksumValidation: 'WHEN_REQUIRED'
});

let failed = 0;
for (const name of queue) {
	const file = path.join(pastaDe(name), name);
	const { size } = await stat(file);
	const key = `${PREFIX}${name}`;
	process.stdout.write(`↑ ${name} … `);
	try {
		await client.send(
			new PutObjectCommand({
				Bucket: bucket,
				Key: key,
				Body: createReadStream(file),
				ContentLength: size,
				ContentType: contentTypeOf(name),
				CacheControl: cacheControlOf(name)
			})
		);
		const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
		if (head.ContentLength !== size) {
			throw new Error(`tamanho no R2 (${head.ContentLength}) difere do local (${size})`);
		}
		console.log(`ok (${mb(size)})`);
	} catch (error) {
		failed += 1;
		console.log(`FALHOU: ${error instanceof Error ? error.message : String(error)}`);
	}
}

if (failed > 0) {
	console.error(`${failed} arquivo(s) não subiram.`);
	process.exit(1);
}
console.log('Pronto: confira https://rawly-ten.vercel.app/baixar (a versão pode levar até 5 min para aparecer).');
