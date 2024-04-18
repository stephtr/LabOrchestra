import { PropsWithChildren, createContext, useCallback, useContext, useEffect, useState } from 'react';
import { controlHubUrl, streamHubUrl } from './connection';
import { useSignalRHub } from './signalR';

const StateContext = createContext<Record<string, any>>({});

export function ControlStateProvider({ children }: PropsWithChildren) {
    const [state, setState] = useState<Record<string, any>>({});
    const partialStateUpdate = useCallback((deviceId: string, partialState: any) => {
        setState((state) => ({ ...state, [deviceId]: { ...state[deviceId], ...partialState } }));
    }, []);
    const { isConnected, invoke } = useSignalRHub({ url: controlHubUrl, onDataReceived: { 'PartialStateUpdate': partialStateUpdate } });
    useEffect(() => {
        if (!isConnected) {
            setState({});
            return;
        }
        invoke('getFullState').then((state) => {
            setState(state);
        });
    }, [isConnected, invoke]);

    return (
        <StateContext.Provider value={state}>
            {children}
        </StateContext.Provider>
    );
}

export function useControl<T = any>(deviceId: string) {
    const { isConnected, invoke } = useSignalRHub({ url: controlHubUrl });
    function action(actionName: string, channelId?: string, parameters?: any[]): Promise<void> {
        if (!invoke) throw Error('Not connected');
        return invoke('action', { deviceId, actionName, channelId, parameters });
    }
    return { isConnected, action, state: useContext(StateContext)[deviceId] as T };
}

export function useStream(deviceId: string, callback: (data: any) => void) {
    const onStream = useCallback((streamDeviceId: string, data: any) => {
        if (streamDeviceId === deviceId) {
            callback(data);
        }
    }, [deviceId, callback]);
    const { isConnected } = useSignalRHub({ url: streamHubUrl, useBinaryProtocol: true, onDataReceived: { 'StreamData': onStream } });
    return { isConnected };
}