// Página offline: volta ao app quando a pessoa pede ou quando a rede volta.
(() => {
	const params = new URLSearchParams(location.search);
	const url = params.get('url') || 'https://rawly-ten.vercel.app';
	const code = params.get('code');
	const codeEl = document.getElementById('code');
	if (code && codeEl) codeEl.textContent = `erro ${code}`;
	const retry = () => location.replace(url);
	document.getElementById('retry').addEventListener('click', retry);
	window.addEventListener('online', retry);
	// Sem evento de rede (VPN, proxy), tenta a cada 30s.
	setInterval(() => {
		if (navigator.onLine) retry();
	}, 30000);
})();
