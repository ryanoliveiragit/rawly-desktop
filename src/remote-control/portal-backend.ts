/**
 * Linux com Wayland: nenhum app injeta entrada direto no compositor. O caminho oficial é o
 * portal `org.freedesktop.portal.RemoteDesktop` (xdg-desktop-portal), por D-Bus:
 *
 *   CreateSession → SelectDevices (teclado + mouse) → ScreenCast.SelectSources (uma tela) →
 *   Start (o GNOME mostra o próprio pedido: qual tela e "permitir controle remoto")
 *
 * O ScreenCast na mesma sessão dá o stream da tela escolhida, e com ele as coordenadas
 * absolutas (`NotifyPointerMotionAbsolute`). As teclas vão pelo código evdev (posição física).
 * Parar fecha a sessão (`Session.Close`); o sistema também pode fechá-la (o indicador do GNOME),
 * e aí o sinal `Closed` encerra o controle.
 *
 * O `@particle/dbus-next` é JS puro e só carrega quando o Wayland pede.
 */
import type * as DBusModule from '@particle/dbus-next';
import { ControlError, PressedState, type InputBackend } from './backend';
import { toStreamPoint, WheelAccumulator, type Size } from './geometry';
import { EVDEV_BUTTON, evdevKey } from './keymap';
import type { RemoteInput } from './protocol';

type DBus = typeof DBusModule;
type MessageBus = DBusModule.MessageBus;
type Variant = DBusModule.Variant;
type VariantMap = Record<string, Variant | undefined>;

const PORTAL = 'org.freedesktop.portal.Desktop';
const PORTAL_PATH = '/org/freedesktop/portal/desktop';
const REMOTE_DESKTOP = 'org.freedesktop.portal.RemoteDesktop';
const SCREEN_CAST = 'org.freedesktop.portal.ScreenCast';
const REQUEST = 'org.freedesktop.portal.Request';
const SESSION = 'org.freedesktop.portal.Session';
const PROPERTIES = 'org.freedesktop.DBus.Properties';

const DEVICE_KEYBOARD = 1;
const DEVICE_POINTER = 2;
const SOURCE_MONITOR = 1;
/** A pessoa pode demorar no pedido do sistema, mas não para sempre. */
const RESPONSE_TIMEOUT_MS = 3 * 60_000;
const CONNECT_TIMEOUT_MS = 5_000;
/** Pixels de rolagem do navegador por passo de roda (`NotifyPointerAxisDiscrete`). */
const WHEEL_STEP_PX = 60;

const UNAVAILABLE = 'Este Linux não tem o portal de controle remoto (xdg-desktop-portal).';

let dbus: DBus | null = null;
function loadDBus(): DBus {
	return (dbus ??= require('@particle/dbus-next') as DBus);
}

let busPromise: Promise<MessageBus> | null = null;

/** Uma conexão com o barramento da sessão para o app inteiro, refeita se cair. */
function sessionBus(): Promise<MessageBus> {
	if (busPromise) return busPromise;
	const attempt = new Promise<MessageBus>((resolve, reject) => {
		let bus: MessageBus;
		try {
			bus = loadDBus().sessionBus();
		} catch (error) {
			reject(error);
			return;
		}
		const timer = setTimeout(() => {
			reject(new Error('D-Bus não respondeu'));
			bus.disconnect();
		}, CONNECT_TIMEOUT_MS);
		bus.on('connect', () => {
			clearTimeout(timer);
			resolve(bus);
		});
		// Sem ouvinte de "error" o EventEmitter derrubaria o processo principal.
		bus.on('error', (error) => {
			clearTimeout(timer);
			console.warn('[rawly] controle remoto: D-Bus', error);
			if (busPromise === attempt) busPromise = null;
			reject(error);
		});
	});
	busPromise = attempt;
	attempt.catch(() => {
		if (busPromise === attempt) busPromise = null;
	});
	return attempt;
}

function uniqueName(bus: MessageBus): string {
	return (bus as unknown as { name: string | null }).name ?? '';
}

async function call(
	bus: MessageBus,
	iface: string,
	member: string,
	signature: string,
	body: unknown[],
	path = PORTAL_PATH
): Promise<unknown[]> {
	const { Message } = loadDBus();
	const reply = await bus.call(new Message({ destination: PORTAL, path, interface: iface, member, signature, body }));
	return reply?.body ?? [];
}

async function busCall(bus: MessageBus, member: 'AddMatch' | 'RemoveMatch', rule: string): Promise<void> {
	const { Message } = loadDBus();
	await bus.call(
		new Message({
			destination: 'org.freedesktop.DBus',
			path: '/org/freedesktop/DBus',
			interface: 'org.freedesktop.DBus',
			member,
			signature: 's',
			body: [rule]
		})
	);
}

/** Ouve um sinal num caminho; só volta depois que o barramento aceitou a regra. */
async function subscribe(
	bus: MessageBus,
	path: string,
	iface: string,
	member: string,
	onSignal: (body: unknown[]) => void
): Promise<() => void> {
	const { MessageType } = loadDBus();
	const rule = `type='signal',interface='${iface}',member='${member}',path='${path}'`;
	const listener = (message: DBusModule.Message) => {
		if (message.type !== MessageType.SIGNAL) return;
		if (message.path === path && message.interface === iface && message.member === member) onSignal(message.body);
	};
	bus.on('message', listener);
	try {
		await busCall(bus, 'AddMatch', rule);
	} catch (error) {
		bus.removeListener('message', listener);
		throw error;
	}
	return () => {
		bus.removeListener('message', listener);
		busCall(bus, 'RemoveMatch', rule).catch(() => {});
	};
}

let tokenCount = 0;
function token(): string {
	tokenCount += 1;
	return `rawly_${process.pid}_${tokenCount}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Chamada de portal que responde depois, pelo sinal `Request.Response` (o padrão dos pedidos
 * que podem abrir diálogo). O caminho do pedido é previsível pelo `handle_token`: assina antes
 * de chamar, para não perder uma resposta rápida.
 */
async function portalRequest(
	bus: MessageBus,
	iface: string,
	member: string,
	signature: string,
	args: unknown[],
	options: VariantMap
): Promise<VariantMap> {
	const { Variant } = loadDBus();
	const handleToken = token();
	const sender = uniqueName(bus).replace(/^:/, '').replace(/\./g, '_');
	const expected = `${PORTAL_PATH}/request/${sender}/${handleToken}`;
	let settle: (body: unknown[]) => void = () => {};
	const response = new Promise<unknown[]>((resolve) => {
		settle = resolve;
	});
	const unsubscribe = await subscribe(bus, expected, REQUEST, 'Response', (body) => settle(body));
	let unsubscribeOther: (() => void) | null = null;
	let timer: NodeJS.Timeout | undefined;
	let handle = expected;
	try {
		const [returned] = await call(bus, iface, member, signature, [
			...args,
			{ ...options, handle_token: new Variant('s', handleToken) }
		]);
		// Portais antigos ignoram o token e devolvem outro caminho.
		if (typeof returned === 'string' && returned !== expected) {
			handle = returned;
			unsubscribeOther = await subscribe(bus, returned, REQUEST, 'Response', (body) => settle(body));
		}
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new ControlError('O pedido do sistema ficou sem resposta.')), RESPONSE_TIMEOUT_MS);
		});
		const [code, results] = await Promise.race([response, timeout]);
		if (code === 1) throw new ControlError('O pedido do sistema para controlar a tela foi recusado.');
		if (code !== 0) throw new ControlError('O sistema não liberou o controle da tela.');
		return (results ?? {}) as VariantMap;
	} catch (error) {
		if (error instanceof ControlError && timer !== undefined) {
			call(bus, REQUEST, 'Close', '', [], handle).catch(() => {});
		}
		throw error;
	} finally {
		clearTimeout(timer);
		unsubscribe();
		unsubscribeOther?.();
	}
}

async function readProperty(bus: MessageBus, iface: string, name: string): Promise<unknown> {
	const [value] = await call(bus, PROPERTIES, 'Get', 'ss', [iface, name]);
	return (value as Variant | undefined)?.value;
}

function closeSession(bus: MessageBus, session: string): Promise<void> {
	return call(bus, SESSION, 'Close', '', [], session).then(
		() => {},
		() => {}
	);
}

/** O primeiro stream com tamanho do resultado de `Start` (`a(ua{sv})`). */
export function parsePortalStreams(value: unknown): { node: number; size: Size } | null {
	if (!Array.isArray(value)) return null;
	for (const entry of value) {
		if (!Array.isArray(entry)) continue;
		const [node, properties] = entry as [unknown, Record<string, { value?: unknown } | undefined> | undefined];
		const size = properties?.size?.value;
		if (typeof node !== 'number' || !Array.isArray(size)) continue;
		const [width, height] = size as unknown[];
		if (typeof width === 'number' && typeof height === 'number' && width > 0 && height > 0) {
			return { node, size: { width, height } };
		}
	}
	return null;
}

/** `null` quando o portal existe e libera mouse e tela; senão, o motivo em pt-BR. Não abre pedido. */
export async function probePortal(): Promise<string | null> {
	let bus: MessageBus;
	try {
		bus = await sessionBus();
	} catch {
		return 'Não deu para falar com o sistema (D-Bus).';
	}
	try {
		const devices = Number(await readProperty(bus, REMOTE_DESKTOP, 'AvailableDeviceTypes'));
		if ((devices & DEVICE_POINTER) === 0) return 'O portal deste Linux não libera o mouse para controle remoto.';
		const sources = Number(await readProperty(bus, SCREEN_CAST, 'AvailableSourceTypes'));
		if ((sources & SOURCE_MONITOR) === 0) return 'O portal deste Linux não libera a tela para controle remoto.';
		return null;
	} catch (error) {
		console.warn('[rawly] controle remoto: portal indisponível', error);
		return UNAVAILABLE;
	}
}

export class PortalBackend implements InputBackend {
	readonly kind = 'wayland-portal' as const;
	private readonly pressed = new PressedState();
	private readonly wheel = new WheelAccumulator(WHEEL_STEP_PX);
	private closed = false;

	private constructor(
		private readonly bus: MessageBus,
		private readonly session: string,
		private readonly stream: number,
		private readonly size: Size,
		private readonly keyboard: boolean,
		private readonly unsubscribeClosed: () => void
	) {}

	/** Abre a sessão; o GNOME pergunta à pessoa antes de voltar. `onClosed`: o sistema encerrou. */
	static async open(onClosed: () => void): Promise<PortalBackend> {
		const { Variant } = loadDBus();
		let bus: MessageBus;
		try {
			bus = await sessionBus();
		} catch (error) {
			throw new ControlError('Não deu para falar com o sistema (D-Bus).', { cause: error });
		}
		let version = 1;
		try {
			version = Number(await readProperty(bus, REMOTE_DESKTOP, 'version')) || 1;
		} catch (error) {
			throw new ControlError(UNAVAILABLE, { cause: error });
		}

		const created = await portalRequest(bus, REMOTE_DESKTOP, 'CreateSession', 'a{sv}', [], {
			session_handle_token: new Variant('s', token())
		});
		const session = String(created.session_handle?.value ?? '');
		if (!session) throw new ControlError('O sistema não abriu a sessão de controle remoto.');

		let backend: PortalBackend | null = null;
		const unsubscribeClosed = await subscribe(bus, session, SESSION, 'Closed', () => {
			if (backend && !backend.closed) onClosed();
		});
		try {
			await portalRequest(bus, REMOTE_DESKTOP, 'SelectDevices', 'oa{sv}', [session], {
				types: new Variant('u', DEVICE_KEYBOARD | DEVICE_POINTER),
				// Nada de lembrar a permissão: o pedido volta a cada sessão, como a pessoa quer.
				...(version >= 2 ? { persist_mode: new Variant('u', 0) } : {})
			});
			await portalRequest(bus, SCREEN_CAST, 'SelectSources', 'oa{sv}', [session], {
				types: new Variant('u', SOURCE_MONITOR),
				multiple: new Variant('b', false)
			});
			const started = await portalRequest(bus, REMOTE_DESKTOP, 'Start', 'osa{sv}', [session, ''], {});
			const devices = Number(started.devices?.value ?? 0);
			if ((devices & DEVICE_POINTER) === 0) {
				throw new ControlError('O mouse não foi liberado no pedido do sistema.');
			}
			const stream = parsePortalStreams(started.streams?.value);
			if (!stream) throw new ControlError('O sistema não informou qual tela liberou.');
			backend = new PortalBackend(
				bus,
				session,
				stream.node,
				stream.size,
				(devices & DEVICE_KEYBOARD) !== 0,
				unsubscribeClosed
			);
			return backend;
		} catch (error) {
			unsubscribeClosed();
			await closeSession(bus, session);
			throw error;
		}
	}

	private notify(member: string, signature: string, args: unknown[]): Promise<unknown[]> {
		return call(this.bus, REMOTE_DESKTOP, member, `oa{sv}${signature}`, [this.session, {}, ...args]);
	}

	private async moveTo(x: number, y: number): Promise<void> {
		const point = toStreamPoint(x, y, this.size);
		await this.notify('NotifyPointerMotionAbsolute', 'udd', [this.stream, point.x, point.y]);
	}

	async apply(event: RemoteInput): Promise<void> {
		if (this.closed) return;
		switch (event.type) {
			case 'move':
				await this.moveTo(event.x, event.y);
				return;
			case 'button': {
				await this.moveTo(event.x, event.y);
				const down = event.action === 'down';
				if (!this.pressed.button(event.button, down)) return;
				await this.notify('NotifyPointerButton', 'iu', [EVDEV_BUTTON[event.button], down ? 1 : 0]);
				return;
			}
			case 'wheel': {
				await this.moveTo(event.x, event.y);
				const steps = this.wheel.push(event.dx, event.dy);
				// Eixo 0 é o vertical, 1 o horizontal; positivo desce / vai para a direita, como no navegador.
				if (steps.y !== 0) await this.notify('NotifyPointerAxisDiscrete', 'ui', [0, steps.y]);
				if (steps.x !== 0) await this.notify('NotifyPointerAxisDiscrete', 'ui', [1, steps.x]);
				return;
			}
			case 'key': {
				const keycode = evdevKey(event.code);
				if (!this.keyboard || keycode === null) return;
				const down = event.action === 'down';
				if (!this.pressed.key(event.code, down)) return;
				await this.notify('NotifyKeyboardKeycode', 'iu', [keycode, down ? 1 : 0]);
				return;
			}
		}
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		const { buttons, keys } = this.pressed.drain();
		for (const button of buttons) {
			await this.notify('NotifyPointerButton', 'iu', [EVDEV_BUTTON[button], 0]).catch(() => {});
		}
		for (const code of keys) {
			const keycode = evdevKey(code);
			if (keycode !== null) await this.notify('NotifyKeyboardKeycode', 'iu', [keycode, 0]).catch(() => {});
		}
		this.unsubscribeClosed();
		await closeSession(this.bus, this.session);
	}
}
