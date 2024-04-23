import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
	Button,
	ButtonGroup,
	Popover,
	PopoverContent,
	PopoverTrigger,
} from '@nextui-org/react';
import { useControl } from '@/lib/controlHub';
import {
	faChevronRight,
	faPlay,
	faStop,
} from '@/lib/fortawesome/pro-solid-svg-icons';
import { ChannelButton } from './channelButton';
import { OscilloscopeState } from './utils';
import { StateSlider } from '../stateSlider';

export function VerticalControlBar({ deviceId }: { deviceId: string }) {
	const { isConnected, action, state } =
		useControl<OscilloscopeState>(deviceId);
	const isRunning = state?.running;

	return (
		<div className="p-1">
			<Button
				className="w-full h-12"
				startContent={
					<FontAwesomeIcon icon={isRunning ? faStop : faPlay} />
				}
				isDisabled={!isConnected}
				onClick={() => action(isRunning ? 'stop' : 'start')}
			>
				{isRunning ? 'Stop' : 'Start'}
			</Button>
			<div className="flex flex-col gap-1 items-center">
				<ChannelButton
					label="C1"
					channelIndex={0}
					state={state}
					action={action}
				/>
				<ChannelButton
					label="C2"
					channelIndex={1}
					state={state}
					action={action}
				/>
				<ChannelButton
					label="C3"
					channelIndex={2}
					state={state}
					action={action}
				/>
				<ChannelButton
					label="C4"
					channelIndex={3}
					state={state}
					action={action}
				/>
				<ButtonGroup variant="flat" className="w-full mt-2">
					<Button
						className="w-full h-12 flex-1 border-l-8"
						isDisabled
					>
						Signal gen
					</Button>
					<Popover placement="right-start">
						<PopoverTrigger>
							<Button
								isIconOnly
								className="h-12"
								isDisabled={!state}
							>
								<FontAwesomeIcon icon={faChevronRight} />
							</Button>
						</PopoverTrigger>
						<PopoverContent
							aria-label="Signal generator settings"
							className="w-[300px]"
						>
							<h2 className="text-xl">
								Signal Generator Settings
							</h2>
							<StateSlider
								className="mt-2"
								label="Test frequency"
								state={state}
								action={action}
								variableName="testSignalFrequency"
								actionName="setTestSignalFrequency"
								values={[0.5e6, 1e6, 2e6, 3e6, 4e6]}
								formatter={(v: number) =>
									`${Intl.NumberFormat().format(v / 1e6)} MHz`
								}
							/>
						</PopoverContent>
					</Popover>
				</ButtonGroup>
			</div>
		</div>
	);
}
