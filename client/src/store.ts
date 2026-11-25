import { HubConnection, HubConnectionBuilder, HubConnectionState } from '@microsoft/signalr';
import { MessagePackHubProtocol } from '@microsoft/signalr-protocol-msgpack';
import { useSyncExternalStore } from 'react';
import { applyPatch, Patch } from './patch';

/** The wire protocol this client speaks; the server refuses a version it does not understand. */
export const PROTOCOL = 1;

export type Param = { name: string; type: string; default: unknown; required: boolean };
export type ActionSchema = { name: string; doc: string | null; params: Param[] };
export type Schema = {
	id: string;
	class: string;
	doc: string | null;
	config: Param[];
	actions: ActionSchema[];
	persist: string[];
	/** The profiles the device conforms to, and the units of its state fields by path ("channels.*.pressure": "mbar"). */
	/** `at`: the state key under which the profile's fields live (a device that is two things at once, e.g. oscilloscope + generator). */
	profiles?: { name: string; version: number; at?: string }[];
	units?: Record<string, string>;
	streams?: string[];
	/** A built-in widget of the client for this device (e.g. "oscilloscope"); without one the generated card is used. */
	widget?: string | null;
};
export type DeviceInfo = {
	status: string;
	error: string | null;
	schema: Schema | null;
	state: Record<string, unknown> | null;
	revision: number;
	/** The device file changed after the device started. */
	changed?: boolean;
	/** Counts every change on the server; a snapshot that is older than what we have is ignored. */
	version?: number;
};
export type ConnectionState = 'login' | 'connecting' | 'connected' | 'reconnecting';
export type LogEntry = {
	seq: number;
	time: string;
	level: string;
	source: string;
	logger: string;
	message: string;
	traceback: string | null;
};
/** The recording in progress (active: false when none). */
export type RecordingStatus = { active: boolean; name?: string; start_time?: string; elapsed_s?: number; events?: number };
export type ServerInfo = { workspace: string; devices_file: boolean; version: string };
type Store = {
	info: ServerInfo | null;
	connection: ConnectionState;
	devices: Record<string, DeviceInfo>;
	logs: Record<string, LogEntry[]>;
	/** The views of the dashboard by id, as the JSON text the server stores. */
	views: Record<string, string>;
	recording: RecordingStatus;
	loginError: string | null;
};

const TOKEN_KEY = 'laborchestra.token';
export const getToken = () => localStorage.getItem(TOKEN_KEY) ?? '';
let store: Store = { info: null, connection: 'connecting', devices: {}, logs: {}, views: {}, recording: { active: false }, loginError: null };
const subscribedLogs = new Set<string>();
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
		.withUrl(`/hub/control?client=ui&protocol=${PROTOCOL}`, { accessTokenFactory: () => token })
		.withHubProtocol(new MessagePackHubProtocol())
		.withAutomaticReconnect({ nextRetryDelayInMilliseconds: () => 1000 })
		.build();
	connection.on('device', (id: string, info: DeviceInfo) => set({ devices: take(store.devices, id, info) }));
	connection.on('device_patch', (id: string, revision: number, patch: Patch, version?: number) => {
		const info = store.devices[id];
		if (info?.state && info.revision + 1 === revision) {
			try {
				set({ devices: { ...store.devices, [id]: { ...info, state: applyPatch(info.state, patch), revision, version: version ?? info.version } } });
				return;
			} catch {
				/* does not fit: fetch the whole device */
			}
		}
		void resyncDevice(connection, id); // a patch was missed
	});
	connection.on('device_removed', (id: string) => {
		const { [id]: _removed, ...rest } = store.devices;
		set({ devices: rest });
	});
	connection.on('recording', (recording: RecordingStatus) => set({ recording }));
	connection.on('views', (views: Record<string, string>) => set({ views }));
	connection.on('log', (entry: LogEntry) => {
		if (!subscribedLogs.has(entry.source)) return;
		set({ logs: { ...store.logs, [entry.source]: mergeLogs(store.logs[entry.source] ?? [], [entry]) } });
	});
	connection.onreconnecting(() => set({ connection: 'reconnecting' }));
	// everything may have changed while we were away: fetch it all again
	connection.onreconnected(() => void syncUntilItWorks(connection));
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

/** Right after a reconnect the server may not be ready for the call yet: try again until it works or the connection is gone. */
async function syncUntilItWorks(connection: HubConnection) {
	while (connection.state === HubConnectionState.Connected) {
		try {
			await sync(connection);
			return;
		} catch {
			await new Promise((resolve) => setTimeout(resolve, 1000));
		}
	}
}

async function sync(connection: HubConnection) {
	const fetched = await connection.invoke<Record<string, DeviceInfo>>('get_devices');
	let devices: Record<string, DeviceInfo> = {};
	for (const [id, info] of Object.entries(fetched)) devices = take(devices, id, info);
	for (const [id, known] of Object.entries(store.devices)) if (id in fetched) devices = take(devices, id, known); // events that came while we asked
	const [info, views, recording] = await Promise.all([
		connection.invoke<ServerInfo>('get_info'),
		connection.invoke<Record<string, string>>('get_views'),
		connection.invoke<RecordingStatus>('get_recording'),
	]);
	set({ connection: 'connected', devices, info, views, recording });
	await Promise.all([...subscribedLogs].map((source) => loadLogs(connection, source)));
}

/** Adds a snapshot of a device unless we already have a newer one. */
function take(devices: Record<string, DeviceInfo>, id: string, info: DeviceInfo): Record<string, DeviceInfo> {
	const known = devices[id];
	if (known && (known.version ?? -1) > (info.version ?? -1)) return devices;
	return { ...devices, [id]: info };
}

const resyncing = new Set<string>();

async function resyncDevice(connection: HubConnection, id: string) {
	if (resyncing.has(id)) return;
	resyncing.add(id);
	try {
		const info = await connection.invoke<DeviceInfo>('get_device', id);
		set({ devices: take(store.devices, id, info) });
	} finally {
		resyncing.delete(id);
	}
}

function mergeLogs(a: LogEntry[], b: LogEntry[]): LogEntry[] {
	const bySeq = new Map([...a, ...b].map((e) => [e.seq, e]));
	return [...bySeq.values()].sort((x, y) => x.seq - y.seq).slice(-500);
}

async function loadLogs(connection: HubConnection, source: string) {
	await connection.invoke('subscribe_logs', source);
	const entries = await connection.invoke<LogEntry[]>('get_logs', source, null, 0, 200);
	set({ logs: { ...store.logs, [source]: mergeLogs(store.logs[source] ?? [], entries) } });
}

/** Follow the log of "server" or "device:<id>" (live, with the latest entries first loaded). */
export async function subscribeLogs(source: string) {
	subscribedLogs.add(source);
	if (hub && store.connection === 'connected') await loadLogs(hub, source);
}

export function unsubscribeLogs(source: string) {
	subscribedLogs.delete(source);
	if (hub && store.connection === 'connected') void hub.invoke('unsubscribe_logs', source);
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

/** Calls a method of the server; errors become RemoteError with the type and message of the cause. */
export async function invokeHub<T = unknown>(method: string, ...args: unknown[]): Promise<T> {
	if (!hub) throw new RemoteError('Not connected');
	try {
		return await hub.invoke<T>(method, ...args);
	} catch (e) {
		throw toRemoteError(e);
	}
}

export const callAction = (device: string, name: string, args: unknown[]) => invokeHub('action', device, name, args);

export const saveView = (id: string, view: unknown) => invokeHub('save_view', id, JSON.stringify(view));
export const deleteView = (id: string) => invokeHub('delete_view', id);
