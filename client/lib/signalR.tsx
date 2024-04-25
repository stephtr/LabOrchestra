import { HubConnection, HubConnectionBuilder } from '@microsoft/signalr';
import { MessagePackHubProtocol } from '@microsoft/signalr-protocol-msgpack';
import {
	PropsWithChildren,
	createContext,
	useContext,
	useEffect,
	useMemo,
	useState,
} from 'react';

type InternalHub =
	| { isConnected: false; connection: HubConnection | null }
	| { isConnected: true; connection: HubConnection };

const ConnectionContext = createContext<Record<string, InternalHub>>({});

type ProviderProps = {
	url: string;
	useBinaryProtocol?: boolean;
};
type Prop = ProviderProps & {
	onDataReceived?: Record<string, (...args: any[]) => void>;
};

type SignalRHubResult =
	| {
			isConnected: false;
			invoke: null;
			send: null;
	  }
	| {
			isConnected: true;
			invoke: HubConnection['invoke'];
			send: HubConnection['send'];
	  };

function useSignalRHubConnection(
	{ url, useBinaryProtocol }: ProviderProps,
	openConnection: boolean = true,
): InternalHub {
	const [hub, setHub] = useState<InternalHub>({
		isConnected: false,
		connection: null,
	});
	useEffect(() => {
		if (!openConnection) return;

		const connectionBuilder = new HubConnectionBuilder()
			.withUrl(url)
			.withAutomaticReconnect({
				nextRetryDelayInMilliseconds: () => 1000,
			});
		if (useBinaryProtocol) {
			connectionBuilder.withHubProtocol(new MessagePackHubProtocol());
		}
		const connection = connectionBuilder.build();
		connection.onclose(() => setHub({ isConnected: false, connection }));
		connection.onreconnected(() =>
			setHub({ isConnected: true, connection }),
		);
		connection
			.start()
			.then(() => setHub({ isConnected: true, connection }))
			.catch((e) => {
				if (
					e.message.includes(
						'The connection was stopped during negotiation',
					)
				)
					return;
				// eslint-disable-next-line no-console
				console.error(e);
			});
		setHub({ isConnected: false, connection });
		return () => {
			// eslint-disable-next-line @typescript-eslint/no-floating-promises
			connection.stop();
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [url, useBinaryProtocol]);

	return hub;
}

export function SignalRHubProvider({
	children,
	url,
	useBinaryProtocol,
}: PropsWithChildren<ProviderProps>) {
	const hub = useSignalRHubConnection({ url, useBinaryProtocol });
	const val = useMemo(() => ({ [url]: hub }), [hub, url]);
	return (
		<ConnectionContext.Provider value={val}>
			{children}
		</ConnectionContext.Provider>
	);
}

export function SignalRHubProviderWithTwoUrls({
	children,
	provider1,
	provider2,
}: PropsWithChildren<{ provider1: ProviderProps; provider2: ProviderProps }>) {
	const hub1 = useSignalRHubConnection(provider1);
	const hub2 = useSignalRHubConnection(provider2);
	const val = useMemo(
		() => ({ [provider1.url]: hub1, [provider2.url]: hub2 }),
		[hub1, provider1.url, hub2, provider2.url],
	);
	return (
		<ConnectionContext.Provider value={val}>
			{children}
		</ConnectionContext.Provider>
	);
}

export function useSignalRHub({
	url,
	useBinaryProtocol,
	onDataReceived,
}: Prop): SignalRHubResult {
	const hubFromContext = useContext(ConnectionContext)[url];
	const localHub = useSignalRHubConnection(
		{ url, useBinaryProtocol },
		!hubFromContext,
	);
	const { connection, isConnected } = hubFromContext || localHub;

	useEffect(() => {
		if (connection && onDataReceived) {
			Object.entries(onDataReceived).forEach(([methodName, handler]) => {
				connection.on(methodName, handler);
			});
			return () => {
				Object.entries(onDataReceived).forEach(
					([methodName, handler]) => {
						connection.off(methodName, handler);
					},
				);
			};
		}
	}, [connection, onDataReceived]);

	const result = useMemo<SignalRHubResult>(
		() =>
			isConnected
				? {
						isConnected: true as const,
						invoke: connection.invoke.bind(connection),
						send: connection.send.bind(connection),
					}
				: {
						isConnected: false as const,
						invoke: null,
						send: null,
					},
		[isConnected, connection],
	);

	return result;
}
