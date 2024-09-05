import { useControl } from '@/lib/controlHub';
import { FormattedNumericInput } from './formattedNumberInput';

interface FrequencyGeneratorState {
	channels: { frequency: number; power: number; isOn: boolean }[];
}

export function FrequencyGenerator() {
	const { isConnected, state, action } =
		useControl<FrequencyGeneratorState>('cavity_detuning');
	if (!isConnected || !state) return '–';
	return (
		<FormattedNumericInput
			value={state.channels[0].frequency * 1e-3}
			onChange={(value) => {
				action('set_frequency', 0, value * 1e3);
			}}
			endContent="kHz"
		/>
	);
}
