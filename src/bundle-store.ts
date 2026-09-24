/**
 * Onde mora o código do app que chegou pela atualização leve, e qual deles
 * abrir (24/09/2026: "preciso que seja mais fácil para todos", "sem precisar
 * reinstalar tudo").
 *
 * O instalador completo pesa entre 90 e 128 MB e, no Linux, pede a senha do
 * computador para trocar o que está em `/opt`. Mas quase toda versão nova
 * muda só o NOSSO código — o Electron, o node-pty e o koffi ficam iguais. Esse
 * código compilado cabe em poucos megabytes, e é isso que o app passa a
 * baixar: um `.asar` com o conteúdo de `out/`, gravado na pasta da pessoa
 * (nada de root), que a próxima abertura carrega no lugar do que veio no
 * pacote. O instalador completo continua existindo para quando o Electron ou
 * um binário nativo mudarem — e aí este módulo recusa o pacote leve sozinho.
 *
 * Este arquivo é carregado ANTES de tudo (`boot.ts`), então ele não importa
 * nada do app e usa só `electron` e o Node.
 */
import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

export interface BundleAtivo {
	versao: string;
	arquivo: string;
	/** Aberturas seguidas sem o app dizer que chegou de pé. */
	tentativas: number;
}

export interface EstadoDosBundles {
	/** O que a próxima abertura deve carregar. */
	ativa: BundleAtivo | null;
	/** Já baixado e conferido, esperando a próxima abertura. */
	proxima: { versao: string; arquivo: string } | null;
}

const VAZIO: EstadoDosBundles = { ativa: null, proxima: null };

/**
 * Duas aberturas que não chegaram ao fim derrubam o pacote leve.
 *
 * É a rede de segurança do mecanismo inteiro: um código que quebra na
 * inicialização deixaria a pessoa com um app que não abre e nenhuma forma de
 * voltar atrás sem reinstalar — exatamente o que isto veio evitar. Duas, e não
 * uma, porque a primeira pode ser um desligamento no meio.
 */
const TENTATIVAS_ATE_DESISTIR = 2;

export function pastaDosBundles(): string {
	return path.join(app.getPath('userData'), 'bundles');
}

const arquivoDoEstado = () => path.join(pastaDosBundles(), 'estado.json');

export function lerEstado(): EstadoDosBundles {
	try {
		const bruto = fs.readFileSync(arquivoDoEstado(), 'utf8');
		return { ...VAZIO, ...(JSON.parse(bruto) as Partial<EstadoDosBundles>) };
	} catch {
		// Primeira vez, arquivo corrompido, disco sem permissão: começa limpo.
		return { ...VAZIO };
	}
}

export function gravarEstado(estado: EstadoDosBundles): void {
	try {
		fs.mkdirSync(pastaDosBundles(), { recursive: true });
		fs.writeFileSync(arquivoDoEstado(), JSON.stringify(estado, null, '\t'));
	} catch (erro) {
		console.warn('[rawly/atualização] não deu para gravar o estado dos pacotes:', erro);
	}
}

function apagar(arquivo: string): void {
	try {
		fs.rmSync(path.join(pastaDosBundles(), arquivo), { force: true });
	} catch {
		// Já não estava lá, ou o disco não deixa: não é motivo para não abrir.
	}
}

/** `1.2.10` é maior que `1.2.9`: a comparação é número a número, não texto. */
export function compararVersao(a: string, b: string): number {
	const partes = (v: string) => v.split('.').map((n) => Number.parseInt(n, 10) || 0);
	const [x, y] = [partes(a), partes(b)];
	for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
		const diferenca = (x[i] ?? 0) - (y[i] ?? 0);
		if (diferenca !== 0) return diferenca;
	}
	return 0;
}

/**
 * O que abrir agora: o caminho do pacote leve, ou `null` para o código que veio
 * no instalador.
 *
 * É aqui que a troca acontece de verdade — baixar é só deixar o arquivo
 * pronto. Promover na abertura, e não na hora do download, é o que faz a
 * atualização não interromper ninguém no meio do trabalho.
 */
export function escolherBundle(): string | null {
	const estado = lerEstado();
	let mudou = false;

	if (estado.proxima) {
		if (estado.ativa) apagar(estado.ativa.arquivo);
		estado.ativa = { ...estado.proxima, tentativas: 0 };
		estado.proxima = null;
		mudou = true;
	}

	const ativa = estado.ativa;
	if (!ativa) {
		if (mudou) gravarEstado(estado);
		return null;
	}

	// Pacote de uma versão que o instalador já alcançou não serve mais.
	if (compararVersao(ativa.versao, app.getVersion()) <= 0) {
		apagar(ativa.arquivo);
		gravarEstado({ ...estado, ativa: null });
		return null;
	}

	const caminho = path.join(pastaDosBundles(), ativa.arquivo);
	if (!fs.existsSync(caminho)) {
		gravarEstado({ ...estado, ativa: null });
		return null;
	}

	if (ativa.tentativas >= TENTATIVAS_ATE_DESISTIR) {
		console.warn(
			`[rawly/atualização] o pacote ${ativa.versao} não abriu ${ativa.tentativas} vezes: voltando ao que veio no instalador.`
		);
		apagar(ativa.arquivo);
		gravarEstado({ ...estado, ativa: null });
		return null;
	}

	// A marca é gravada ANTES de carregar: se o que vem a seguir quebrar, a
	// próxima abertura já encontra a contagem subida.
	gravarEstado({ ...estado, ativa: { ...ativa, tentativas: ativa.tentativas + 1 } });
	return caminho;
}

/** O app chegou de pé com o pacote leve: a contagem de tentativas volta a zero. */
export function bundleAbriuBem(): void {
	const estado = lerEstado();
	if (!estado.ativa || estado.ativa.tentativas === 0) return;
	gravarEstado({ ...estado, ativa: { ...estado.ativa, tentativas: 0 } });
}

/** A versão que está rodando: a do pacote leve, quando há um, senão a do instalador. */
export function versaoEmUso(): string {
	const ativa = lerEstado().ativa;
	return ativa && compararVersao(ativa.versao, app.getVersion()) > 0
		? ativa.versao
		: app.getVersion();
}
