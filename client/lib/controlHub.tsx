import {
	PropsWithChildren,
	createContext,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useState,
} from 'react';
import { controlHubUrl, pingUrl, streamHubUrl } from './connection';
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
		try {
			// eslint-disable-next-line @typescript-eslint/no-floating-promises
			invoke('getFullState').then((newState: Record<string, any>) => {
				setState(newState);
			});
		} catch (err) {}
	}, [isConnected, invoke]);

	return (
		<StateContext.Provider value={state}>{children}</StateContext.Provider>
	);
}

export function useControl<T = any>(deviceId: string) {
	const { isConnected, invoke } = useSignalRHub({ url: controlHubUrl });
	function action(actionName: string, ...parameters: any[]): Promise<void> {
		if (!invoke) return Promise.resolve();
		if (!invoke) throw Error('Not connected');
		return invoke('action', { deviceId, actionName, parameters });
	}
	return {
		isConnected,
		action,
		state: useContext(StateContext)[deviceId] as T | undefined,
	};
}

export function useStream(deviceId: string, callback: (data: any) => void) {
	const onStream = useCallback(
		// NOTE: payload and deviceId are switched in order to not have a varying byte offset of the payload (and potential 4-byte-alignment issues)
		(data: any, streamDeviceId: string) => {
			if (streamDeviceId === deviceId) {
				callback(data);
			}
		},
		[deviceId, callback],
	);
	const { isConnected, invoke } = useSignalRHub({
		url: streamHubUrl,
		useBinaryProtocol: true,
		onDataReceived: { StreamData: onStream },
	});
	function setCustomization(customization: any) {
		if (!invoke) throw Error('Not connected');
		return invoke('setStreamCustomization', deviceId, customization);
	}
	return { isConnected, setCustomization };
}

export function useChannelControl<TState extends { channels: any[] }>(
	state: TState | undefined,
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

export async function checkAccessToken(accessToken: string) {
	const resp = await fetch(pingUrl, {
		headers: { Authorization: `Bearer ${accessToken}` },
	});
	return resp.status === 200;
}
