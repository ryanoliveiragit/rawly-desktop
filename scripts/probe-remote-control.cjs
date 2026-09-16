// Confere, sem Electron e sem mexer em nada, se este computador consegue receber controle remoto:
// no Wayland lê as propriedades do portal (não abre o pedido do sistema); nos outros carrega a API
// nativa pelo koffi (no X11 também abre e fecha a conexão com o XTEST). Rode depois do `npm run compile`:
//
//   node scripts/probe-remote-control.cjs
//
// A permissão de Acessibilidade do Mac só dá para conferir dentro do app.
const { probeNative } = require('../out/remote-control/native-backend.js');
const { probePortal } = require('../out/remote-control/portal-backend.js');

const wayland =
	process.platform === 'linux' && (process.env.XDG_SESSION_TYPE === 'wayland' || Boolean(process.env.WAYLAND_DISPLAY));

async function main() {
	const backend = wayland ? 'wayland-portal' : 'native';
	const reason = wayland ? await probePortal() : probeNative(process.platform);
	console.log(JSON.stringify({ available: reason === null, platform: process.platform, backend, reason }, null, 2));
	// A conexão do D-Bus fica aberta para o app inteiro; aqui o script termina sozinho.
	process.exit(reason === null ? 0 : 1);
}

void main();
