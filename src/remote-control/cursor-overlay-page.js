// O cursor laranja: a foto de quem controla (ou as iniciais, sem foto) ao lado da seta.
const face = document.getElementById('face');
window.cursorOverlay.onPerson(({ name, photo }) => {
	face.textContent = '';
	if (photo) {
		const img = document.createElement('img');
		img.alt = '';
		img.src = photo;
		face.appendChild(img);
		return;
	}
	const initials = String(name || '')
		.split(/\s+/)
		.filter(Boolean)
		.slice(0, 2)
		.map((part) => Array.from(part)[0].toUpperCase())
		.join('');
	face.textContent = initials || '?';
});
