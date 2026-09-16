// A faixa do controle remoto: nome de quem controla e o atalho vêm na query; "Parar" avisa a casca.
const params = new URLSearchParams(location.search);
// Sem janela transparente (Linux), a faixa ocupa a janela inteira, sem cantos arredondados.
if (params.get('solid') === '1') document.documentElement.classList.add('solid');
document.getElementById('name').textContent = params.get('name') || 'Alguém';

const shortcut = params.get('shortcut');
const hint = document.getElementById('shortcut');
if (shortcut) {
	hint.textContent = shortcut;
	hint.title = `Atalho para parar: ${shortcut}`;
} else {
	hint.hidden = true;
}

document.getElementById('stop').addEventListener('click', () => window.controlOverlay.stop());
