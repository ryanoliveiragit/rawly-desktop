import type { Session } from 'electron';
import { isAppUrl } from './config';

/**
 * O que a origem do app pode pedir: microfone e câmera (`media`), a tela
 * (`display-capture`), avisos, área de transferência, tela cheia e escolher
 * o alto-falante. Qualquer outra origem (a página offline, iframes de
 * terceiros) e qualquer outra permissão são negadas.
 */
const ALLOWED = new Set([
	'media',
	'display-capture',
	'notifications',
	'clipboard-read',
	'clipboard-sanitized-write',
	'fullscreen',
	'speaker-selection'
]);

export function installPermissionHandlers(session: Session, appUrl: URL): void {
	const allowed = (origin: string, permission: string) =>
		ALLOWED.has(permission) && isAppUrl(origin, appUrl);

	session.setPermissionRequestHandler((contents, permission, callback, details) => {
		const origin = details.requestingUrl || contents.getURL();
		callback(allowed(origin, permission));
	});
	session.setPermissionCheckHandler((_contents, permission, requestingOrigin) =>
		allowed(requestingOrigin, permission)
	);
}
