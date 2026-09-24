import { app, Menu, type MenuItemConstructorOptions } from 'electron';

/**
 * Menu mínimo em pt-BR. O site já tem os próprios atalhos (⌘K, ⌘,); aqui só o
 * que é da casca: sobre, recarregar, sair, edição, zoom e tela cheia. As
 * ferramentas de desenvolvimento entram só com `--dev`.
 */
export function buildMenu(opts: {
	dev: boolean;
	reload: () => void;
	about: () => void;
	/** Procura atualização na hora e responde — mesmo quando não há novidade. */
	procurarAtualizacao: () => void;
}): Menu {
	const mac = process.platform === 'darwin';
	const appMenu: MenuItemConstructorOptions = {
		label: 'Rawly',
		submenu: [
			{ label: 'Sobre o Rawly', click: opts.about },
			// Sem este item, a atualização era invisível: quem desconfiasse de
			// estar atrasado não tinha o que fazer além de baixar o instalador.
			{ label: 'Procurar atualizações…', click: opts.procurarAtualizacao },
			{ type: 'separator' },
			{ label: 'Recarregar', accelerator: 'CmdOrCtrl+R', click: opts.reload },
			{ type: 'separator' },
			...(mac
				? ([
						{ label: 'Ocultar o Rawly', role: 'hide' },
						{ label: 'Ocultar os outros', role: 'hideOthers' },
						{ label: 'Mostrar tudo', role: 'unhide' },
						{ type: 'separator' }
					] as MenuItemConstructorOptions[])
				: []),
			{ label: 'Sair', role: 'quit', accelerator: mac ? 'Cmd+Q' : 'Ctrl+Q' }
		]
	};
	const edit: MenuItemConstructorOptions = {
		label: 'Editar',
		submenu: [
			{ label: 'Desfazer', role: 'undo' },
			{ label: 'Refazer', role: 'redo' },
			{ type: 'separator' },
			{ label: 'Recortar', role: 'cut' },
			{ label: 'Copiar', role: 'copy' },
			{ label: 'Colar', role: 'paste' },
			{ label: 'Selecionar tudo', role: 'selectAll' }
		]
	};
	const view: MenuItemConstructorOptions = {
		label: 'Exibir',
		submenu: [
			{ label: 'Aumentar', role: 'zoomIn' },
			{ label: 'Diminuir', role: 'zoomOut' },
			{ label: 'Tamanho padrão', role: 'resetZoom' },
			{ type: 'separator' },
			{ label: 'Tela cheia', role: 'togglefullscreen' },
			...(opts.dev
				? ([
						{ type: 'separator' },
						{ label: 'Ferramentas de desenvolvimento', role: 'toggleDevTools' }
					] as MenuItemConstructorOptions[])
				: [])
		]
	};
	const window: MenuItemConstructorOptions = {
		label: 'Janela',
		submenu: [
			{ label: 'Minimizar', role: 'minimize' },
			{ label: 'Zoom', role: 'zoom' },
			...(mac
				? ([
						{ type: 'separator' },
						{ label: 'Trazer tudo para a frente', role: 'front' }
					] as MenuItemConstructorOptions[])
				: ([{ label: 'Fechar', role: 'close' }] as MenuItemConstructorOptions[]))
		]
	};
	return Menu.buildFromTemplate([appMenu, edit, view, window]);
}

export function aboutPanel(appUrl: URL, versao = app.getVersion()): void {
	app.setAboutPanelOptions({
		applicationName: 'Rawly',
		// A versão em uso pode vir do pacote leve, e não do instalador: é ela que
		// a pessoa precisa ver quando for contar o que está rodando.
		applicationVersion: versao,
		version: `Electron ${process.versions.electron}`,
		copyright: `© ${new Date().getFullYear()} Nevus Digital`,
		website: appUrl.origin
	});
}
