// Instalado pelo Rawly (rawlyapp.com.br). O agente que lê o chamado e escreve
// a proposta. Roda no seu CI, com a sua chave — o Rawly não vê o seu código.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';

const repo = process.env.RAWLY_REPO ?? process.cwd();
const tarefa = (process.env.RAWLY_TAREFA ?? '').trim();
const contexto = (process.env.RAWLY_CONTEXTO ?? '').trim();
const chamado = (process.env.RAWLY_CHAMADO ?? '').trim();
const pedidos = (process.env.RAWLY_ARQUIVOS ?? '')
	.split(',')
	.map((p) => p.trim())
	.filter(Boolean);

if (!tarefa) {
	console.error('Sem tarefa: nada a fazer.');
	process.exit(1);
}

/** O que cabe no pedido, para a conta não explodir nem o contexto estourar. */
const MAX_BYTES_ARQUIVO = 120_000;
const MAX_BYTES_TOTAL = 400_000;

/** Lê um arquivo do repositório, sem sair dele. */
function ler(caminho) {
	const alvo = resolve(repo, caminho);
	if (!alvo.startsWith(resolve(repo))) return null;
	if (!existsSync(alvo)) return null;
	try {
		const texto = readFileSync(alvo, 'utf8');
		return texto.length > MAX_BYTES_ARQUIVO ? texto.slice(0, MAX_BYTES_ARQUIVO) + '\n… (cortado)' : texto;
	} catch {
		return null;
	}
}

let usados = 0;
const anexos = [];
for (const caminho of pedidos) {
	const texto = ler(caminho);
	if (texto === null) continue;
	if (usados + texto.length > MAX_BYTES_TOTAL) break;
	usados += texto.length;
	anexos.push({ caminho, texto });
}

const INSTRUCOES = [
	'Você é um programador trabalhando neste repositório.',
	'Faça a alteração pedida, seguindo o estilo do código que já existe: mesma linguagem, mesmas convenções, mesmo jeito de comentar.',
	'Mude o mínimo necessário. Não refatore o que não foi pedido, não formate o arquivo inteiro, não troque dependência.',
	'',
	'Responda SÓ com os arquivos alterados ou criados, cada um assim:',
	'<<<ARQUIVO caminho/do/arquivo>>>',
	'o conteúdo INTEIRO do arquivo, do começo ao fim',
	'<<<FIM>>>',
	'',
	'Depois dos arquivos, escreva uma última seção:',
	'<<<RESUMO>>>',
	'o que você mudou e por quê, em poucas linhas, para quem for revisar o pull request',
	'<<<FIM>>>',
	'',
	'Se faltar informação para fazer com segurança, não invente: devolva só o RESUMO explicando o que falta.'
].join('\n');

const partes = [
	chamado ? `Chamado: ${chamado}` : '',
	`Tarefa: ${tarefa}`,
	contexto ? `\nContexto do chamado:\n${contexto}` : '',
	anexos.length ? '\nArquivos do repositório:' : '\nNenhum arquivo foi indicado: procure pelos nomes citados na tarefa.',
	...anexos.map((a) => `\n--- ${a.caminho} ---\n${a.texto}`)
].filter(Boolean);

const prompt = partes.join('\n');

/** Claude, pelo SDK oficial. É o caminho preferido quando há ANTHROPIC_API_KEY. */
async function comClaude() {
	const { default: Anthropic } = await import('@anthropic-ai/sdk');
	const client = new Anthropic();
	const stream = client.messages.stream({
		model: process.env.RAWLY_MODELO ?? 'claude-opus-5',
		max_tokens: 32000,
		system: INSTRUCOES,
		messages: [{ role: 'user', content: prompt }]
	});
	const resposta = await stream.finalMessage();
	return resposta.content
		.filter((bloco) => bloco.type === 'text')
		.map((bloco) => bloco.text)
		.join('');
}

/** Gemini, por HTTP: não há SDK instalado aqui, e é um pedido só. */
async function comGemini() {
	const chave = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
	const modelo = process.env.RAWLY_MODELO ?? 'gemini-3.6-flash';
	const resposta = await fetch(
		`https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent?key=${chave}`,
		{
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				systemInstruction: { parts: [{ text: INSTRUCOES }] },
				contents: [{ role: 'user', parts: [{ text: prompt }] }],
				generationConfig: { maxOutputTokens: 32000 }
			})
		}
	);
	if (!resposta.ok) {
		throw new Error(`O Gemini recusou (HTTP ${resposta.status}): ${(await resposta.text()).slice(0, 300)}`);
	}
	const dados = await resposta.json();
	return (dados.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('');
}

const saida = process.env.ANTHROPIC_API_KEY
	? await comClaude()
	: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY
		? await comGemini()
		: (() => {
				console.error(
					'Falta a chave de IA. Guarde ANTHROPIC_API_KEY ou GEMINI_API_KEY em Settings › Secrets and variables › Actions.'
				);
				process.exit(1);
			})();

/** Separa os blocos que o modelo devolveu. */
function blocos(texto) {
	const saida = { arquivos: [], resumo: '' };
	const regex = /<<<(ARQUIVO ([^>]+)|RESUMO)>>>\n([\s\S]*?)\n?<<<FIM>>>/g;
	let m;
	while ((m = regex.exec(texto)) !== null) {
		if (m[1] === 'RESUMO') saida.resumo = m[3].trim();
		else saida.arquivos.push({ caminho: m[2].trim(), conteudo: m[3] });
	}
	return saida;
}

const { arquivos, resumo } = blocos(saida);
writeFileSync('resumo.md', [resumo || 'Proposta do agente do Rawly.', '', `_Chamado: ${chamado || '—'}_`].join('\n'));

if (arquivos.length === 0) {
	console.log('O agente não propôs alteração nenhuma. Resumo:');
	console.log(resumo || '(sem resumo)');
	process.exit(0);
}

for (const arquivo of arquivos) {
	const alvo = resolve(repo, arquivo.caminho);
	if (!alvo.startsWith(resolve(repo))) {
		console.error(`Caminho fora do repositório, ignorado: ${arquivo.caminho}`);
		continue;
	}
	mkdirSync(dirname(alvo), { recursive: true });
	writeFileSync(alvo, arquivo.conteudo.endsWith('\n') ? arquivo.conteudo : arquivo.conteudo + '\n');
	console.log(`escrito: ${relative(repo, alvo)}`);
}
console.log(`${arquivos.length} arquivo(s) alterado(s).`);
