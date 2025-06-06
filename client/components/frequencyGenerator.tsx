import { useControl } from '@/lib/controlHub';
import { Button, Popover, PopoverContent, PopoverTrigger } from '@heroui/react';
import { IconSettings } from '@tabler/icons-react';
import { FormattedNumericInput } from './formattedNumberInput';

interface FrequencyGeneratorState {
	channels: { frequency: number; power: number; isOn: boolean }[];
}

interface ConstantsState {
	cavityDetuningGeneratorOffset: number;
}

export function FrequencyGenerator() {
	const { isConnected, state, action } =
		useControl<FrequencyGeneratorState>('cavity_detuning');
	const { state: constantsState, action: constantsAction } =
		useControl<ConstantsState>('constants');
	if (!isConnected || !state || !constantsState) return '–';

	const offset = constantsState.cavityDetuningGeneratorOffset;
	return (
		<FormattedNumericInput
			value={(state.channels[0].frequency - offset) * 1e-3}
			onChange={(value) => {
				action('set_frequency', 0, value * 1e3 + offset);
			}}
			className="max-w-48"
			label="Cavity detuning (EOM)"
			endContent={
				<>
					kHz
					<Popover>
						<PopoverTrigger>
							<Button
								isIconOnly
								className="self-center"
								variant="light"
							>
								<IconSettings size="1.4em" />
							</Button>
						</PopoverTrigger>
						<PopoverContent aria-label="Input settings">
							<FormattedNumericInput
								label="Cavity detuning EOM offset"
								value={offset * 1e-3}
								onChange={(value) => {
									constantsAction(
										'set',
										'cavityDetuningGeneratorOffset',
										value * 1e3,
									);
								}}
								endContent="kHz"
							/>
						</PopoverContent>
					</Popover>
				</>
			}
		/>
	);
}
