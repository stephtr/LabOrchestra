import { HubConnection, HubConnectionBuilder } from '@microsoft/signalr';
import { MessagePackHubProtocol } from '@microsoft/signalr-protocol-msgpack';
import { getToken, PROTOCOL } from './store';

export type StreamFrame = { sequence: number; meta: Record<string, any>; data: Float32Array };

type Handle = {
	id: string | null;
	device: string;
	stream: string;
	params: Record<string, unknown>;
	latest: StreamFrame | null;
	scheduled: boolean;
	onFrame: (frame: StreamFrame) => void;
	closed: boolean;
};

const handles = new Set<Handle>();
let connection: Promise<HubConnection> | null = null;

function connect(): Promise<HubConnection> {
	if (connection) return connection;
	connection = (async () => {
		const hub = new HubConnectionBuilder()
			.withUrl(`/hub/streaming?client=ui&protocol=${PROTOCOL}`, { accessTokenFactory: getToken })
			.withHubProtocol(new MessagePackHubProtocol())
			.withAutomaticReconnect({ nextRetryDelayInMilliseconds: () => 1000 })
			.build();
		hub.on('frame', (id: string, sequence: number, meta: Record<string, any>, data: Uint8Array) => {
			const handle = [...handles].find((h) => h.id === id);
			if (!handle) return;
			// the bytes of a message are not aligned for a Float32Array: copy them once
			const copy = data.slice();
			handle.latest = { sequence, meta, data: new Float32Array(copy.buffer, 0, Math.floor(copy.byteLength / 4)) };
			// at once: this is how the server learns the round trip time (drawing may take longer)
			void hub.send('received', id, sequence);
			schedule(handle, hub);
		});
		// the server forgets our subscriptions when the connection is lost: subscribe again
		hub.onreconnected(() => void Promise.all([...handles].map((h) => subscribe(hub, h))));
		for (;;) {
			try {
				await hub.start();
				return hub;
			} catch {
				await new Promise((resolve) => setTimeout(resolve, 1000));
			}
		}
	})();
	return connection;
}

/** Draws only the newest frame, when the screen refreshes, and then says so: the frames in between count as done as well. */
function schedule(handle: Handle, hub: HubConnection) {
	if (handle.scheduled) return;
	handle.scheduled = true;
	requestAnimationFrame(() => {
		handle.scheduled = false;
		const frame = handle.latest;
		handle.latest = null;
		if (!frame || handle.closed) return;
		handle.onFrame(frame);
		if (handle.id) void hub.send('ack', handle.id, frame.sequence); // a hidden tab never gets here: no frames are sent to it
	});
}

async function subscribe(hub: HubConnection, handle: Handle) {
	handle.id = null;
	handle.id = await hub.invoke<string>('subscribe', handle.device, handle.stream, handle.params, 8, 30);
}

export type StreamSubscription = { update: (params: Record<string, unknown>) => void; close: () => void };

/** Frames of a stream of a device (see the display stream of the oscilloscope); one frame per screen refresh at most. */
export function subscribeStream(device: string, stream: string, params: Record<string, unknown>, onFrame: (frame: StreamFrame) => void): StreamSubscription {
	const handle: Handle = { id: null, device, stream, params, latest: null, scheduled: false, onFrame, closed: false };
	handles.add(handle);
	void connect().then((hub) => (handle.closed ? undefined : subscribe(hub, handle).catch(() => undefined)));
	return {
		update(next) {
			handle.params = next;
			if (handle.id) void connect().then((hub) => hub.invoke('update', handle.id, next));
		},
		close() {
			handle.closed = true;
			handles.delete(handle);
			const id = handle.id;
			if (id) void connect().then((hub) => hub.invoke('unsubscribe', id)).catch(() => undefined);
		},
	};
}
