'use client';

import { FrequencyGenerator } from '@/components/frequencyGenerator';
import { GridStack } from '@/components/gridview/gridStack';
import { Oscilloscope } from '@/components/oscilloscope';
import { Polarimeter } from '@/components/polarimeter';
import { PolarizationLock } from '@/components/polarizationLock';
import { PressureSensor } from '@/components/pressureSensor';
import { StageChannel } from '@/components/stageChannel';
import { StateButton } from '@/components/stateButton';
import { StateInput } from '@/components/stateInput';
import { useControl } from '@/lib/controlHub';
import { faCircleDot, faStop } from '@/lib/fontawesome-regular';
import { faGear, faSave } from '@/lib/fortawesome/pro-solid-svg-icons';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
	Button,
	ButtonGroup,
	Popover,
	PopoverContent,
	PopoverTrigger,
	Spinner,
} from '@heroui/react';

interface MainState {
	saveDirectory: string;
	filename: string;
	pendingActions: number;
	isRecording: boolean;
	recordingTimeSeconds: number;
}

export default function Home() {
	const { isConnected, action, state } = useControl<MainState>('main');
	const hasPendingActions = (state?.pendingActions ?? 0) > 0;
	const { state: hasSplitOscilloscope } = useControl('split');

	const oscilloscope1 = (
		<Oscilloscope
			deviceId="het"
			frequencyOffset={5e6 - 1.86e3}
			topContent={
				<>
					<div className="flex-1" />
					<StateInput
						className="max-w-sm"
						placeholder="Filename"
						isDisabled={!isConnected}
						state={state}
						action={action}
						actionName="setFilename"
						variableName="filename"
					/>
					{state?.isRecording ? (
						<Button
							className="ml-2 tabular-nums"
							startContent={<FontAwesomeIcon icon={faStop} />}
							onClick={() => action('stopRecording')}
							isDisabled={!isConnected}
						>
							{Math.floor(state.recordingTimeSeconds / 60)}:
							{(state.recordingTimeSeconds % 60)
								.toString()
								.padStart(2, '0')}
						</Button>
					) : (
						<ButtonGroup>
							<Button
								startContent={
									<FontAwesomeIcon icon={faCircleDot} />
								}
								onClick={() => action('startRecording')}
								isDisabled={!isConnected}
							>
								Record
							</Button>
							<StateButton
								startContent={<FontAwesomeIcon icon={faSave} />}
								state={state}
								action={action}
								actionName="SaveSnapshot"
								isDisabled={!isConnected}
							>
								Snapshot
							</StateButton>
						</ButtonGroup>
					)}
					{hasPendingActions && <Spinner size="sm" />}
					<div className="flex-1" />
					{/* <Pressure /> */}
					<Popover>
						<PopoverTrigger>
							<Button isIconOnly className="h-12 ml-2">
								<FontAwesomeIcon icon={faGear} />
							</Button>
						</PopoverTrigger>
						<PopoverContent
							aria-label="General settings"
							className="w-[300px] items-start gap-3 py-2 px-3"
						>
							<h2 className="text-xl">General Settings</h2>
							<StateInput
								label="Save directory"
								labelPlacement="outside"
								className="pt-2"
								placeholder=" "
								isDisabled={!isConnected}
								state={state}
								action={action}
								actionName="setSaveDirectory"
								variableName="saveDirectory"
							/>
						</PopoverContent>
					</Popover>
				</>
			}
		/>
	);

	const oscilloscope2 = hasSplitOscilloscope ? (
		<Oscilloscope deviceId="split" />
	) : null;

	return (
		<div className="h-full grid grid-rows-[1fr_5em]">
			{oscilloscope2 ? (
				<GridStack className="overflow-hidden">
					{oscilloscope1}
					{oscilloscope2}
				</GridStack>
			) : (
				oscilloscope1
			)}

			<div className="flex gap-2 items-center mx-2">
				<FrequencyGenerator />
				<StageChannel
					channel={0}
					label="Tweezer QWP angle"
					offsetVariableName="tweezerQWPOffset"
				/>
				<StageChannel
					channel={1}
					label="Tweezer HWP angle"
					offsetVariableName="tweezerHWPOffset"
				/>
				<StageChannel channel={2} label="Detection HWP angle" />
				<StageChannel channel={3} label="Detection QWP angle" />
				<div className="flex-1" />
				<PressureSensor
					label="Vorvakuum"
					channel={0}
					innerClassName="text-slate-400"
				/>
				<PressureSensor label="Kammer" channel={1} />
			</div>
			<div className="flex gap-2 items-center mx-2 mb-2">
				<Polarimeter label="Tweezer">
					<PolarizationLock />
				</Polarimeter>
			</div>
		</div>
	);
}
