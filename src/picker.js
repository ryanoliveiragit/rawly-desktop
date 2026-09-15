// Seletor de tela: recebe as fontes pela ponte `window.picker` e devolve a escolha.
(() => {
	const grid = document.getElementById('grid');
	const share = document.getElementById('share');
	const cancel = document.getElementById('cancel');
	const audioLabel = document.getElementById('audio-label');
	const audioBox = document.getElementById('audio');
	const tabs = Array.from(document.querySelectorAll('.tab'));
	let sources = [];
	let kind = 'screen';
	let selected = null;

	function render() {
		grid.replaceChildren();
		const list = sources.filter((source) => source.kind === kind);
		if (list.length === 0) {
			const empty = document.createElement('div');
			empty.className = 'empty-state';
			empty.textContent = kind === 'screen' ? 'Nenhuma tela encontrada.' : 'Nenhuma janela aberta.';
			grid.append(empty);
			return;
		}
		for (const source of list) {
			const card = document.createElement('button');
			card.type = 'button';
			card.className = 'card';
			card.setAttribute('role', 'option');
			card.setAttribute('aria-pressed', String(selected === source.id));
			card.title = source.name;
			if (source.thumbnail) {
				const img = document.createElement('img');
				img.className = 'thumb';
				img.alt = '';
				img.src = source.thumbnail;
				card.append(img);
			} else {
				const box = document.createElement('div');
				box.className = 'thumb empty';
				box.textContent = 'sem prévia';
				card.append(box);
			}
			const name = document.createElement('div');
			name.className = 'name';
			if (source.appIcon) {
				const icon = document.createElement('img');
				icon.alt = '';
				icon.src = source.appIcon;
				name.append(icon);
			}
			const label = document.createElement('span');
			label.textContent = source.name;
			name.append(label);
			card.append(name);
			card.addEventListener('click', () => select(source.id));
			card.addEventListener('dblclick', () => {
				select(source.id);
				confirm();
			});
			grid.append(card);
		}
	}

	function select(id) {
		selected = id;
		share.disabled = false;
		for (const card of grid.querySelectorAll('.card')) {
			card.setAttribute('aria-pressed', String(card.title === titleOf(id)));
		}
	}

	function titleOf(id) {
		const hit = sources.find((source) => source.id === id);
		return hit ? hit.name : '';
	}

	function confirm() {
		if (!selected) return;
		window.picker.choose(selected, Boolean(audioBox.checked));
	}

	for (const tab of tabs) {
		tab.addEventListener('click', () => {
			kind = tab.dataset.kind;
			for (const other of tabs) other.setAttribute('aria-selected', String(other === tab));
			render();
		});
	}
	share.addEventListener('click', confirm);
	cancel.addEventListener('click', () => window.picker.cancel());
	document.addEventListener('keydown', (event) => {
		if (event.key === 'Escape') window.picker.cancel();
		if (event.key === 'Enter' && selected) confirm();
	});

	window.picker.onSources((payload) => {
		sources = payload.sources;
		audioLabel.dataset.on = String(Boolean(payload.audio));
		// Sem tela nenhuma (raro) cai nas janelas.
		if (!sources.some((source) => source.kind === 'screen') && sources.some((source) => source.kind === 'window')) {
			kind = 'window';
			for (const tab of tabs) tab.setAttribute('aria-selected', String(tab.dataset.kind === kind));
		}
		render();
	});
})();
