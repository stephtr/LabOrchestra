import { HubConnection, HubConnectionBuilder } from '@microsoft/signalr';
import { MessagePackHubProtocol } from '@microsoft/signalr-protocol-msgpack';
import { PropsWithChildren, createContext, useContext, useEffect, useMemo, useState } from 'react';

type InternalHub = { isConnected: false, connection: HubConnection | null } | { isConnected: true, connection: HubConnection };

const ConnectionContext = createContext<Record<string, InternalHub>>({});


type ProviderProps = {
    url: string;
    useBinaryProtocol?: boolean;
};
type Prop = ProviderProps & {
    onDataReceived?: Record<string, (...args: any[]) => void>;
};

type SignalRHubResult = {
    isConnected: false;
    invoke: null;
    send: null;
} | {
    isConnected: true;
    invoke: HubConnection['invoke'];
    send: HubConnection['send'];
};

function useSignalRHubConnection({ url, useBinaryProtocol }: ProviderProps, openConnection: boolean = true): InternalHub {
    const [hub, setHub] = useState<InternalHub>({ isConnected: false, connection: null });
    useEffect(() => {
        if (!openConnection) return;

        const connectionBuilder = new HubConnectionBuilder()
            .withUrl(url)
            .withAutomaticReconnect();
        if (useBinaryProtocol) {
            connectionBuilder.withHubProtocol(new MessagePackHubProtocol());
        }
        const connection = connectionBuilder.build();
        connection.onclose(() => setHub({ isConnected: false, connection }));
        connection.onreconnected(() => setHub({ isConnected: true, connection }));
        connection.start()
            .then(() => setHub({ isConnected: true, connection }))
            .catch((e) => {
                if (e.message.includes('The connection was stopped during negotiation')) return;
                console.error(e);
            });
        setHub({ isConnected: false, connection });
        return () => {
            connection.stop();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [url, useBinaryProtocol]);

    return hub;
}

export function SignalRHubProvider({ children, url, useBinaryProtocol }: PropsWithChildren<ProviderProps>) {
    const hub = useSignalRHubConnection({ url, useBinaryProtocol });
    return (
        <ConnectionContext.Provider value={{ [url]: hub }}>
            {children}
        </ConnectionContext.Provider>
    );
}

export function useSignalRHub({ url, useBinaryProtocol, onDataReceived }: Prop): SignalRHubResult {
    const hubFromContext = useContext(ConnectionContext)[url];
    const localHub = useSignalRHubConnection({ url, useBinaryProtocol }, !hubFromContext);
    const { connection, isConnected } = hubFromContext || localHub;

    useEffect(() => {
        if (connection && onDataReceived) {
            Object.entries(onDataReceived).forEach(([methodName, handler]) => {
                connection.on(methodName, handler);
            });
            return () => {
                Object.entries(onDataReceived).forEach(([methodName, handler]) => {
                    connection.off(methodName, handler);
                });
            }
        }
    }, [connection, onDataReceived]);

    const result = useMemo<SignalRHubResult>(() => isConnected ? {
        isConnected: true as const,
        invoke: connection.invoke.bind(connection),
        send: connection.send.bind(connection),
    } : {
        isConnected: false as const,
        invoke: null,
        send: null,
    }, [isConnected, connection]);

    return result;
}
