import { useControl } from '@/lib/controlHub';
import {
	Button,
	Popover,
	PopoverContent,
	PopoverTrigger,
} from '@nextui-org/react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faGear } from '@/lib/fontawesome-regular';
import { FormattedNumericInput } from './formattedNumberInput';

interface StageState {
	channels: {
		type: 'linear' | 'rotation';
		actualPosition: number;
		targetPosition: number;
	}[];
}

export function StageChannel({
	channel: channelIndex,
	offsetVariableName,
	label,
}: {
	channel: number;
	offsetVariableName?: string;
	label?: React.ReactNode;
}) {
	const { isConnected, state, action } = useControl<StageState>('elliptec');
	const { state: constantsState, action: constantsAction } =
		useControl<Record<string, number>>('constants');
	if (
		!isConnected ||
		!state ||
		(offsetVariableName && !constantsState) ||
		!state.channels[channelIndex]
	)
		return '–';

	const offset = offsetVariableName ? constantsState![offsetVariableName] : 0;
	const channel = state.channels[channelIndex];
	const unit = channel.type === 'linear' ? ' mm' : '°';

	const delta = channel.targetPosition - channel.actualPosition;
	const deltaText =
		Math.abs(delta) < 0.1 ? null : (
			<div className="whitespace-nowrap text-xs ml-2 align-middle text-red-500">
				(Δ {delta.toFixed(2)}
				{unit})
			</div>
		);

	const scalingFactor = 10;
	return (
		<FormattedNumericInput
			value={Math.round((channel.targetPosition - offset) * scalingFactor)}
			onChange={(value) => {
				action(
					'set_position',
					channelIndex,
					value / scalingFactor + offset,
				);
			}}
			className="max-w-48"
			label={label}
			endContent={
				<>
					{unit}
					{deltaText}
					{offsetVariableName && (
						<Popover>
							<PopoverTrigger>
								<Button
									isIconOnly
									className="self-center"
									variant="light"
								>
									<FontAwesomeIcon icon={faGear} />
								</Button>
							</PopoverTrigger>
							<PopoverContent aria-label="Input settings">
								<FormattedNumericInput
									label="Offset"
									value={offset * 1e-3}
									onChange={(value) => {
										constantsAction(
											'set',
											offsetVariableName,
											value / scalingFactor,
										);
									}}
									endContent={unit}
								/>
							</PopoverContent>
						</Popover>
					)}
				</>
			}
		/>
	);
}
