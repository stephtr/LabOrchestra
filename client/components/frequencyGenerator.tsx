import { useControl } from '@/lib/controlHub';

interface FrequencyGeneratorState {
	channels: { frequency: number; power: number; isOn: boolean }[];
}

const frequencyFormatter = Intl.NumberFormat();

export function FrequencyGenerator() {
	const { isConnected, state, action } =
		useControl<FrequencyGeneratorState>('cavity_detuning');
	if (!isConnected || !state) return '–';
	return (
		frequencyFormatter.format(state.channels[0].frequency * 1e-3) + ' kHz'
	);
}
