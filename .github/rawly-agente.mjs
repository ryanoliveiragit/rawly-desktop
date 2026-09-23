// Instalado pelo Rawly (rawlyapp.com.br). O agente que lê o chamado e escreve
// a proposta. Roda no seu CI, com a sua chave — o Rawly não vê o seu código.
//
// Especialista do projeto inteiro (23/09/2026: "quero que ele funcione como um
// especialista geral do projeto, ele ler tudo"). Antes o agente só via os
// arquivos que o chamado citava; sem essa lista, trabalhava às cegas. Agora
// ele começa sempre pelo guia do projeto (AGENTS.md) e pelo mapa de todos os
// arquivos, e tem ferramentas para listar, ler, buscar e escrever — lê o que
// precisar, quantas vezes precisar, antes de mexer em qualquer coisa.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, appendFileSync } from 'node:fs';
import { dirname, resolve, relative, isAbsolute, sep } from 'node:path';

const repo = resolve(process.env.RAWLY_REPO ?? process.cwd());
const tarefa = (process.env.RAWLY_TAREFA ?? '').trim();
const contexto = (process.env.RAWLY_CONTEXTO ?? '').trim();
const chamado = (process.env.RAWLY_CHAMADO ?? '').trim();
const verificar = (process.env.RAWLY_VERIFICAR ?? '').trim();
const pedidos = (process.env.RAWLY_ARQUIVOS ?? '')
	.split(',')
	.map((p) => p.trim())
	.filter(Boolean);

if (!tarefa) {
	console.error('Sem tarefa: nada a fazer.');
	process.exit(1);
}

/** O que cabe numa leitura, para a conta não explodir nem o contexto estourar. */
const MAX_BYTES_ARQUIVO = 200_000;
const MAX_RESULTADOS_BUSCA = 200;
/** Voltas do agente (cada uma é um pedido à IA). Um teto, não uma meta. */
const MAX_VOLTAS = Number(process.env.RAWLY_MAX_VOLTAS ?? 80);

/** Caminho vindo da IA é entrada não confiável: nada fora do repositório, nada dentro do .git. */
function dentro(caminho) {
	const alvo = resolve(repo, String(caminho ?? '.'));
	const rel = relative(repo, alvo);
	if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) return null;
	if (rel === '.git' || rel.startsWith('.git' + sep)) return null;
	return alvo;
}

function git(args) {
	const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
	return r.status === 0 || r.status === 1 ? r.stdout : '';
}

/** Todos os arquivos versionados, mais os novos que o agente já criou. */
function arquivosDoRepo() {
	return git(['ls-files', '--cached', '--others', '--exclude-standard']).split('\n').filter(Boolean);
}

function lerTexto(caminho) {
	const alvo = dentro(caminho);
	if (!alvo || !existsSync(alvo) || !statSync(alvo).isFile()) return null;
	try {
		return readFileSync(alvo, 'utf8');
	} catch {
		return null;
	}
}

// ——— As ferramentas do agente ———

const ferramentas = {
	listar: {
		descricao:
			'Lista os arquivos do repositório (versionados e os que você já criou) sob uma pasta. Sem pasta, lista tudo.',
		esquema: { pasta: { type: 'string', description: 'Pasta relativa à raiz, ex. "src/remote-control". Opcional.' } },
		obrigatorios: [],
		rodar({ pasta }) {
			const prefixo = pasta && pasta !== '.' ? String(pasta).replace(/\/+$/, '') + '/' : '';
			const todos = arquivosDoRepo().filter((a) => a.startsWith(prefixo));
			return todos.length ? todos.join('\n') : `Nenhum arquivo em "${pasta}".`;
		}
	},
	ler: {
		descricao:
			'Lê um arquivo do repositório, com números de linha. Para arquivos grandes, peça um trecho com linha_inicial e linha_final.',
		esquema: {
			caminho: { type: 'string', description: 'Caminho relativo à raiz do repositório.' },
			linha_inicial: { type: 'integer', description: 'Primeira linha (1 = começo). Opcional.' },
			linha_final: { type: 'integer', description: 'Última linha, inclusive. Opcional.' }
		},
		obrigatorios: ['caminho'],
		rodar({ caminho, linha_inicial, linha_final }) {
			const texto = lerTexto(caminho);
			if (texto === null) throw new Error(`Arquivo não encontrado ou fora do repositório: ${caminho}`);
			const linhas = texto.split('\n');
			const de = Math.max(1, Number(linha_inicial) || 1);
			const ate = Math.min(linhas.length, Number(linha_final) || linhas.length);
			let saida = '';
			for (let i = de; i <= ate; i++) {
				saida += `${i}\t${linhas[i - 1]}\n`;
				if (saida.length > MAX_BYTES_ARQUIVO) {
					return saida + `… (cortado na linha ${i} de ${linhas.length}; leia o resto com linha_inicial=${i + 1})`;
				}
			}
			return saida || '(arquivo vazio)';
		}
	},
	buscar: {
		descricao:
			'Procura um texto ou expressão regular (sintaxe estendida do git grep) em todo o repositório e devolve arquivo:linha:trecho.',
		esquema: {
			padrao: { type: 'string', description: 'O texto ou a regex, ex. "ipcMain.handle\\(\'repo:".' },
			pasta: { type: 'string', description: 'Limita a busca a uma pasta. Opcional.' }
		},
		obrigatorios: ['padrao'],
		rodar({ padrao, pasta }) {
			const args = ['grep', '-n', '-I', '-E', '--untracked', '-e', String(padrao)];
			if (pasta) {
				if (!dentro(pasta)) throw new Error(`Pasta fora do repositório: ${pasta}`);
				args.push('--', String(pasta));
			}
			const linhas = git(args).split('\n').filter(Boolean);
			if (!linhas.length) return 'Nada encontrado.';
			const cortado = linhas.length > MAX_RESULTADOS_BUSCA;
			return (
				linhas.slice(0, MAX_RESULTADOS_BUSCA).map((l) => l.slice(0, 400)).join('\n') +
				(cortado ? `\n… (${linhas.length - MAX_RESULTADOS_BUSCA} resultados a mais; refine o padrão)` : '')
			);
		}
	},
	escrever: {
		descricao:
			'Cria ou substitui um arquivo com o conteúdo INTEIRO dado. Leia o arquivo antes de substituí-lo, para não perder o que já existe.',
		esquema: {
			caminho: { type: 'string', description: 'Caminho relativo à raiz do repositório.' },
			conteudo: { type: 'string', description: 'O conteúdo completo do arquivo, do começo ao fim.' }
		},
		obrigatorios: ['caminho', 'conteudo'],
		rodar({ caminho, conteudo }) {
			const alvo = dentro(caminho);
			if (!alvo) throw new Error(`Caminho fora do repositório (ou dentro do .git), recusado: ${caminho}`);
			if (relative(repo, alvo).split(sep)[0] === 'node_modules') throw new Error('Não se escreve em node_modules.');
			mkdirSync(dirname(alvo), { recursive: true });
			writeFileSync(alvo, conteudo.endsWith('\n') ? conteudo : conteudo + '\n');
			alterados.add(relative(repo, alvo));
			console.log(`escrito: ${relative(repo, alvo)}`);
			return `Gravado: ${relative(repo, alvo)} (${conteudo.length} caracteres).`;
		}
	}
};

// Com um comando de verificação no chamado, o agente pode rodá-lo e corrigir o
// que falhar antes de entregar. Roda sem as chaves de IA no ambiente.
if (verificar) {
	ferramentas.verificar = {
		descricao: `Roda a verificação do projeto (\`${verificar}\`) e devolve o resultado. Use depois de escrever, para conferir o que mudou.`,
		esquema: {},
		obrigatorios: [],
		rodar() {
			const env = { ...process.env };
			for (const chave of ['ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GH_TOKEN', 'GITHUB_TOKEN']) {
				delete env[chave];
			}
			const r = spawnSync('bash', ['-lc', verificar], {
				cwd: repo,
				env,
				encoding: 'utf8',
				timeout: 10 * 60_000,
				maxBuffer: 32 * 1024 * 1024
			});
			const saida = `${r.stdout ?? ''}${r.stderr ?? ''}`;
			return `Saiu com ${r.status ?? 'sinal ' + r.signal}.\n${saida.slice(-30_000)}`;
		}
	};
}

const alterados = new Set();

/** O modelo às vezes devolve entrada cortada; confere antes de rodar. */
function entradaValida(nome, entrada) {
	const f = ferramentas[nome];
	if (!f || typeof entrada !== 'object' || entrada === null) return false;
	for (const campo of f.obrigatorios) {
		if (typeof entrada[campo] !== 'string') return false;
	}
	return true;
}

// ——— O que o agente sabe antes de começar ———

const guia = lerTexto('AGENTS.md') ?? lerTexto('CLAUDE.md') ?? lerTexto('README.md') ?? '';
const mapa = arquivosDoRepo().join('\n');

const INSTRUCOES = [
	'Você é o especialista deste repositório: conhece o projeto inteiro e trabalha nele como um programador sênior da casa.',
	'Você recebe um chamado. Pode ser um pedido de alteração ou uma pergunta sobre o projeto.',
	'',
	'Como trabalhar:',
	'- Antes de afirmar qualquer coisa ou mudar qualquer arquivo, leia o código que importa. Use `buscar` para achar onde algo acontece e `ler` para ver o arquivo; siga as chamadas até entender o fluxo. Nunca invente o conteúdo de um arquivo que você não leu.',
	'- Faça a alteração pedida seguindo o estilo do código que já existe: mesma linguagem, mesmas convenções, mesmo jeito de comentar. O guia do projeto abaixo descreve as regras.',
	'- Mude o mínimo necessário. Não refatore o que não foi pedido, não reformate arquivos inteiros, não troque dependência.',
	'- Para mudar um arquivo, use `escrever` com o conteúdo INTEIRO dele, depois de lê-lo.',
	'- Se a ferramenta `verificar` existir, rode-a depois de escrever e corrija o que falhar.',
	'- Se o chamado for uma pergunta, responda sem mudar arquivo nenhum.',
	'- Se faltar informação para fazer com segurança, não invente: não escreva nada e explique o que falta.',
	'',
	'Ao terminar, sua última mensagem (sem chamar ferramentas) é o resumo para quem revisar o pull request: o que você mudou e por quê, em poucas linhas — ou, se era uma pergunta, a resposta.',
	'',
	'# Guia do projeto',
	'',
	guia || '(o repositório não tem AGENTS.md nem README.md)',
	'',
	'# Todos os arquivos do repositório',
	'',
	mapa
].join('\n');

const anexos = [];
for (const caminho of pedidos) {
	const texto = lerTexto(caminho);
	if (texto !== null) anexos.push(`\n--- ${caminho} ---\n${texto.slice(0, MAX_BYTES_ARQUIVO)}`);
}

const pedido = [
	chamado ? `Chamado: ${chamado}` : '',
	`Tarefa: ${tarefa}`,
	contexto ? `\nContexto do chamado:\n${contexto}` : '',
	anexos.length ? '\nArquivos que o chamado cita (leia outros à vontade):' : '',
	...anexos
]
	.filter(Boolean)
	.join('\n');

// ——— Claude: o agente com ferramentas ———

/** Claude, pelo SDK oficial. É o caminho preferido quando há ANTHROPIC_API_KEY. */
async function comClaude() {
	const { default: Anthropic } = await import('@anthropic-ai/sdk');
	const client = new Anthropic();
	const tools = Object.entries(ferramentas).map(([name, f]) => ({
		name,
		description: f.descricao,
		// Arquivos inteiros vêm como entrada de `escrever`: chegam aos poucos em vez de num bloco só.
		eager_input_streaming: true,
		input_schema: { type: 'object', properties: f.esquema, required: f.obrigatorios }
	}));
	const messages = [{ role: 'user', content: pedido }];
	let tentativasJson = 0;

	for (let volta = 1; volta <= MAX_VOLTAS; volta++) {
		const stream = client.beta.messages.stream({
			model: process.env.RAWLY_MODELO ?? 'claude-opus-5',
			max_tokens: 64000,
			thinking: { type: 'adaptive' },
			output_config: { effort: 'high' },
			// Se a IA recusar por engano, o pedido segue num modelo reserva em vez de parar.
			betas: ['server-side-fallback-2026-07-01'],
			fallbacks: 'default',
			// O guia e o mapa se repetem em toda volta: em cache, custam uma fração.
			cache_control: { type: 'ephemeral' },
			system: INSTRUCOES,
			tools,
			messages
		});

		let resposta;
		try {
			resposta = await stream.finalMessage();
			tentativasJson = 0;
		} catch (erro) {
			// Só a entrada de ferramenta ilegível é refeita; erro da API sobe.
			if (erro instanceof Anthropic.APIError || tentativasJson++ >= 2) throw erro;
			console.error('Entrada de ferramenta ilegível; refazendo a volta.');
			continue;
		}

		const texto = resposta.content
			.filter((b) => b.type === 'text')
			.map((b) => b.text)
			.join('');

		if (resposta.stop_reason === 'refusal') {
			return `O agente recusou o pedido${resposta.stop_details?.explanation ? `: ${resposta.stop_details.explanation}` : '.'}`;
		}
		if (resposta.stop_reason === 'pause_turn') {
			messages.push({ role: 'assistant', content: resposta.content });
			continue;
		}

		const usos = resposta.content.filter((b) => b.type === 'tool_use');
		if (usos.length === 0) return texto;
		if (resposta.stop_reason === 'max_tokens') {
			throw new Error('A resposta foi cortada no meio de uma ferramenta (max_tokens). Nada foi executado dessa volta.');
		}

		messages.push({ role: 'assistant', content: resposta.content });
		const resultados = [];
		for (const uso of usos) {
			if (!entradaValida(uso.name, uso.input)) {
				resultados.push({
					type: 'tool_result',
					tool_use_id: uso.id,
					is_error: true,
					content: `Entrada inválida para "${uso.name}": ${JSON.stringify(uso.input).slice(0, 500)}`
				});
				continue;
			}
			try {
				console.log(`[${volta}] ${uso.name} ${uso.input.caminho ?? uso.input.padrao ?? uso.input.pasta ?? ''}`);
				resultados.push({ type: 'tool_result', tool_use_id: uso.id, content: ferramentas[uso.name].rodar(uso.input) });
			} catch (erro) {
				resultados.push({ type: 'tool_result', tool_use_id: uso.id, is_error: true, content: String(erro?.message ?? erro) });
			}
		}
		messages.push({ role: 'user', content: resultados });
	}
	return `O agente parou no limite de ${MAX_VOLTAS} voltas sem concluir. O que foi escrito até aqui está no pull request.`;
}

// ——— Gemini: um pedido só, com o guia e o mapa ———

/** Separa os blocos que o Gemini devolve. */
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

/** Gemini, por HTTP: não há SDK instalado aqui, e é um pedido só (sem ferramentas). */
async function comGemini() {
	const chave = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
	const modelo = process.env.RAWLY_MODELO ?? 'gemini-3.6-flash';
	const formato = [
		'',
		'Aqui você não tem ferramentas: trabalhe com o guia, o mapa e os arquivos anexados.',
		'Responda SÓ com os arquivos alterados ou criados, cada um assim:',
		'<<<ARQUIVO caminho/do/arquivo>>>',
		'o conteúdo INTEIRO do arquivo, do começo ao fim',
		'<<<FIM>>>',
		'Depois, uma última seção:',
		'<<<RESUMO>>>',
		'o que você mudou e por quê (ou a resposta, se for pergunta)',
		'<<<FIM>>>'
	].join('\n');
	const resposta = await fetch(
		`https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent?key=${chave}`,
		{
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				systemInstruction: { parts: [{ text: INSTRUCOES + '\n' + formato }] },
				contents: [{ role: 'user', parts: [{ text: pedido }] }],
				generationConfig: { maxOutputTokens: 32000 }
			})
		}
	);
	if (!resposta.ok) {
		throw new Error(`O Gemini recusou (HTTP ${resposta.status}): ${(await resposta.text()).slice(0, 300)}`);
	}
	const dados = await resposta.json();
	const { arquivos, resumo } = blocos((dados.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join(''));
	for (const arquivo of arquivos) {
		try {
			ferramentas.escrever.rodar(arquivo);
		} catch (erro) {
			console.error(String(erro?.message ?? erro));
		}
	}
	return resumo;
}

const resumo = process.env.ANTHROPIC_API_KEY
	? await comClaude()
	: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY
		? await comGemini()
		: (() => {
				console.error(
					'Falta a chave de IA. Guarde ANTHROPIC_API_KEY ou GEMINI_API_KEY em Settings › Secrets and variables › Actions.'
				);
				process.exit(1);
			})();

writeFileSync('resumo.md', [resumo?.trim() || 'Proposta do agente do Rawly.', '', `_Chamado: ${chamado || '—'}_`].join('\n'));

// A resposta aparece na página da execução — é onde fica quando não há PR (uma pergunta, por exemplo).
if (process.env.GITHUB_STEP_SUMMARY) {
	appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Agente do Rawly\n\n${resumo?.trim() || '(sem resumo)'}\n`);
}

console.log(alterados.size ? `${alterados.size} arquivo(s) alterado(s).` : 'O agente não propôs alteração nenhuma.');
console.log(resumo?.trim() || '(sem resumo)');
