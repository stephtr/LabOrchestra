import { Switch } from '@heroui/react';
import { useControl } from '@/lib/controlHub';
import { StageState } from './stageChannel';

export function SliderSwitch({
	label,
	channel: channelIndex,
}: {
	channel: number;
	label?: React.ReactNode;
}) {
	const { isConnected, state, action } = useControl<StageState>('elliptec');
	if (!isConnected || !state || !state.channels[channelIndex]) return '–';
	console.log('SliderSwitch', state.channels[channelIndex].targetPosition);
	return (
		<Switch
			isSelected={state.channels[channelIndex].targetPosition < 2}
			onValueChange={(active) =>
				action('set_position', channelIndex, active ? 1 : 2)
			}
		>
			{label}
		</Switch>
	);
}
