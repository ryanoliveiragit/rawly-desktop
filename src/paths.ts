import { app } from 'electron';
import path from 'node:path';

/**
 * Arquivos que a casca carrega em tempo de execução (ícone do Linux, selos do
 * Windows). Empacotado, moram em `resources/` (`extraResources` do
 * electron-builder); em desenvolvimento, em `desktop/build/`.
 */
export function resourcePath(relative: string): string {
	return app.isPackaged
		? path.join(process.resourcesPath, relative)
		: path.join(__dirname, '..', 'build', relative);
}

/** Arquivos compilados junto com o código (`out/`). */
export function outPath(relative: string): string {
	return path.join(__dirname, relative);
}
