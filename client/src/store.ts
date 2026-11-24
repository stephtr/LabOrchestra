import { HubConnection, HubConnectionBuilder } from '@microsoft/signalr';
import { MessagePackHubProtocol } from '@microsoft/signalr-protocol-msgpack';
import { useSyncExternalStore } from 'react';

export type Param = { name: string; type: string; default: unknown; required: boolean };
export type ActionSchema = { name: string; doc: string | null; params: Param[] };
export type Schema = {
	id: string;
	class: string;
	doc: string | null;
	config: Param[];
	actions: ActionSchema[];
	persist: string[];
};
export type DeviceInfo = {
	status: string;
	error: string | null;
	schema: Schema | null;
	state: Record<string, unknown> | null;
};
export type ConnectionState = 'login' | 'connecting' | 'connected' | 'reconnecting';
type Store = { connection: ConnectionState; devices: Record<string, DeviceInfo>; loginError: string | null };

const TOKEN_KEY = 'laborchestra.token';
let store: Store = { connection: 'connecting', devices: {}, loginError: null };
const listeners = new Set<() => void>();
let hub: HubConnection | null = null;
let attempt = 0;

function set(change: Partial<Store>) {
	store = { ...store, ...change };
	listeners.forEach((listener) => listener());
}

export function useStore(): Store {
	return useSyncExternalStore(
		(listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		() => store,
	);
}

/** Reads a token from the address (#token=...) once, then connects with the stored token. */
export async function start() {
	const fromUrl = new URLSearchParams(location.hash.slice(1)).get('token');
	if (fromUrl) {
		localStorage.setItem(TOKEN_KEY, fromUrl);
		history.replaceState(null, '', location.pathname + location.search);
	}
	const token = localStorage.getItem(TOKEN_KEY);
	if (token) await connect(token);
	else set({ connection: 'login' });
}

export async function login(token: string) {
	localStorage.setItem(TOKEN_KEY, token.trim());
	set({ loginError: null });
	await connect(token.trim());
}

export function logout() {
	localStorage.removeItem(TOKEN_KEY);
	void hub?.stop();
	hub = null;
	set({ connection: 'login', devices: {} });
}

async function tokenIsValid(token: string): Promise<boolean | null> {
	try {
		const response = await fetch('/hub/control/negotiate?negotiateVersion=1', {
			method: 'POST',
			headers: { Authorization: `Bearer ${token}` },
		});
		if (response.status === 401 || response.status === 403) return false;
		return response.ok ? true : null;
	} catch {
		return null; // server not reachable
	}
}

async function connect(token: string) {
	const mine = ++attempt;
	set({ connection: 'connecting', loginError: null });
	await hub?.stop();
	for (;;) {
		const valid = await tokenIsValid(token);
		if (mine !== attempt) return;
		if (valid === false) {
			localStorage.removeItem(TOKEN_KEY);
			set({ connection: 'login', loginError: 'The token was not accepted.' });
			return;
		}
		if (valid) break;
		await new Promise((resolve) => setTimeout(resolve, 1000));
	}
	const connection = new HubConnectionBuilder()
		.withUrl('/hub/control', { accessTokenFactory: () => token })
		.withHubProtocol(new MessagePackHubProtocol())
		.withAutomaticReconnect({ nextRetryDelayInMilliseconds: () => 1000 })
		.build();
	connection.on('device', (id: string, info: DeviceInfo) =>
		set({ devices: { ...store.devices, [id]: info } }),
	);
	connection.on('device_removed', (id: string) => {
		const { [id]: _removed, ...rest } = store.devices;
		set({ devices: rest });
	});
	connection.onreconnecting(() => set({ connection: 'reconnecting' }));
	// everything may have changed while we were away: fetch it all again
	connection.onreconnected(() => void sync(connection));
	hub = connection;
	for (;;) {
		try {
			await connection.start();
			break;
		} catch {
			if (mine !== attempt) return;
			await new Promise((resolve) => setTimeout(resolve, 1000));
		}
	}
	await sync(connection);
}

async function sync(connection: HubConnection) {
	const devices = await connection.invoke<Record<string, DeviceInfo>>('get_devices');
	set({ connection: 'connected', devices });
}

export class RemoteError extends Error {
	constructor(
		message: string,
		public type?: string,
		public traceback?: string,
	) {
		super(message);
	}
}

function toRemoteError(e: unknown): Error {
	const text = e instanceof Error ? e.message : String(e);
	const start = text.indexOf('{');
	if (start >= 0) {
		try {
			const data = JSON.parse(text.slice(start)) as { type?: string; message?: string; traceback?: string };
			return new RemoteError(data.message ?? text, data.type, data.traceback ?? undefined);
		} catch {
			/* not JSON */
		}
	}
	return new RemoteError(text);
}

export async function callAction(device: string, name: string, args: unknown[]): Promise<unknown> {
	if (!hub) throw new RemoteError('Not connected');
	try {
		return await hub.invoke('action', device, name, args);
	} catch (e) {
		throw toRemoteError(e);
	}
}
