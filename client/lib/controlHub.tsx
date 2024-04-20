import {
	PropsWithChildren,
	createContext,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useState,
} from 'react';
import { controlHubUrl, streamHubUrl } from './connection';
import { useSignalRHub } from './signalR';

const StateContext = createContext<Record<string, any>>({});

export function ControlStateProvider({ children }: PropsWithChildren) {
	const [state, setState] = useState<Record<string, any>>({});
	const partialStateUpdate = useCallback(
		(partialState: Record<string, any>) =>
			setState((oldState) => {
				const newState = { ...oldState };
				Object.entries(partialState).forEach(
					([deviceId, deviceState]) => {
						newState[deviceId] = {
							...oldState[deviceId],
							...deviceState,
						};
					},
				);
				return newState;
			}),
		[],
	);
	const { isConnected, invoke } = useSignalRHub({
		url: controlHubUrl,
		onDataReceived: { PartialStateUpdate: partialStateUpdate },
	});
	useEffect(() => {
		if (!isConnected) {
			setState({});
			return;
		}
		// eslint-disable-next-line @typescript-eslint/no-floating-promises
		invoke('getFullState').then((newState: Record<string, any>) => {
			setState(newState);
		});
	}, [isConnected, invoke]);

	return (
		<StateContext.Provider value={state}>{children}</StateContext.Provider>
	);
}

export function useControl<T = any>(deviceId: string) {
	const { isConnected, invoke } = useSignalRHub({ url: controlHubUrl });
	function action(actionName: string, ...parameters: any[]): Promise<void> {
		if (!invoke) throw Error('Not connected');
		return invoke('action', { deviceId, actionName, parameters });
	}
	return {
		isConnected,
		action,
		state: useContext(StateContext)[deviceId] as T,
	};
}

export function useStream(deviceId: string, callback: (data: any) => void) {
	const onStream = useCallback(
		(streamDeviceId: string, data: any) => {
			if (streamDeviceId === deviceId) {
				callback(data);
			}
		},
		[deviceId, callback],
	);
	const { isConnected } = useSignalRHub({
		url: streamHubUrl,
		useBinaryProtocol: true,
		onDataReceived: { StreamData: onStream },
	});
	return { isConnected };
}

export function useChannelControl<TState extends { channels: any[] }>(
	state: TState,
	action: (actionName: string, ...args: any[]) => void,
	channelIndex: number,
) {
	return useMemo(
		() =>
			[
				state?.channels[channelIndex] as TState['channels'][number],
				(actionName: string, ...args: any[]) =>
					action(actionName, channelIndex, ...args),
			] as const,
		[state?.channels, action, channelIndex],
	);
}
