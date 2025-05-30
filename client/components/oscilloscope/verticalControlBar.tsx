import {
	Button,
	ButtonGroup,
	Popover,
	PopoverContent,
	PopoverTrigger,
} from '@heroui/react';
import {
	IconChevronRight,
	IconPlayerPlayFilled,
	IconPlayerStopFilled,
} from '@tabler/icons-react';
import { useControl } from '@/lib/controlHub';
import { ChannelButton } from './channelButton';
import { OscilloscopeState } from './utils';
import { StateSlider } from '../stateSlider';

export function VerticalControlBar({
	deviceId,
	children,
	className = '',
}: React.PropsWithChildren<{
	deviceId: string;
	className?: string;
}>) {
	const { isConnected, action, state } =
		useControl<OscilloscopeState>(deviceId);
	const isRunning = state?.running;

	return (
		<div className={`flex flex-col gap-1 items-center p-1 ${className}`}>
			<Button
				className="w-full h-12"
				startContent={
					isRunning ? (
						<IconPlayerStopFilled size="1.4em" />
					) : (
						<IconPlayerPlayFilled size="1.4em" />
					)
				}
				isDisabled={!isConnected}
				onPress={() => action(isRunning ? 'stop' : 'start')}
			>
				{isRunning ? 'Stop' : 'Start'}
			</Button>
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
				<Button className="w-full h-12 flex-1 border-l-8" isDisabled>
					Signal gen
				</Button>
				<Popover placement="right-start">
					<PopoverTrigger>
						<Button isIconOnly className="h-12" isDisabled={!state}>
							<IconChevronRight />
						</Button>
					</PopoverTrigger>
					<PopoverContent
						aria-label="Signal generator settings"
						className="w-[300px]"
					>
						<h2 className="text-xl">Signal Generator Settings</h2>
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
			{children ? <div className="flex-1" /> : null}
			{children}
		</div>
	);
}
