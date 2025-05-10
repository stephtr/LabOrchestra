'use client';

import { AccessTokenOverlay } from '@/components/accessTokenOverlay';
import { ChevronDownIcon } from '@/components/chevronDownIcon';
import { FrequencyGenerator } from '@/components/frequencyGenerator';
import { GridStack } from '@/components/gridview/gridStack';
import { Oscilloscope } from '@/components/oscilloscope';
import { Polarimeter } from '@/components/polarimeter';
import { PolarizationLock } from '@/components/polarizationLock';
import { PressureSensor } from '@/components/pressureSensor';
import { StageChannel } from '@/components/stageChannel';
import { StateButton } from '@/components/stateButton';
import { StateInput } from '@/components/stateInput';
import { checkAccessToken, useControl } from '@/lib/controlHub';
import { faCircleDot, faStop, faTrash } from '@/lib/fontawesome-regular';
import { faGear, faSave } from '@/lib/fortawesome/pro-solid-svg-icons';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
	Button,
	ButtonGroup,
	Dropdown,
	DropdownItem,
	DropdownMenu,
	DropdownTrigger,
	Popover,
	PopoverContent,
	PopoverTrigger,
	Spinner,
} from '@heroui/react';
import { useEffect, useState } from 'react';

interface MainState {
	saveDirectory: string;
	filename: string;
	pendingActions: number;
	isRecording: boolean;
	recordingTimeSeconds: number;
	plannedRecordingTimeSeconds: number;
}

const recordingTimes = [60, 150, 300, 600, 1200, 1800];

function formatTime(seconds?: number) {
	if (!seconds) return '0:00';
	return `${Math.floor(seconds / 60)}:${(seconds % 60)
		.toString()
		.padStart(2, '0')}`;
}

export default function Home() {
	const { isConnected, action, state } = useControl<MainState>('main');
	const hasPendingActions = (state?.pendingActions ?? 0) > 0;
	const { state: hasSplitOscilloscope } = useControl('split');

	const remainingRecordingTime =
		state?.plannedRecordingTimeSeconds &&
		state.plannedRecordingTimeSeconds - state.recordingTimeSeconds;

	const [isWrongAccessToken, setIsWrongAccessToken] = useState(false);

	useEffect(() => {
		// eslint-disable-next-line @typescript-eslint/no-floating-promises
		(async () => {
			const accessToken = localStorage.getItem('accessToken');
			if (!(await checkAccessToken(accessToken))) {
				setIsWrongAccessToken(true);
				localStorage.removeItem('accessToken');
			}
		})();
	}, []);

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
						<ButtonGroup className="ml-2">
							<Button
								className="tabular-nums"
								startContent={<FontAwesomeIcon icon={faStop} />}
								onPress={() => action('stopRecording')}
								isDisabled={!isConnected}
							>
								<div>
									{formatTime(state.recordingTimeSeconds)}
								</div>
								{state.plannedRecordingTimeSeconds ? (
									<div className="text-sm text-slate-500">
										–{formatTime(remainingRecordingTime)}
									</div>
								) : null}
							</Button>
							<StateButton
								title="Abort recording"
								color="danger"
								state={state}
								action={action}
								actionName="abortRecording"
							>
								<FontAwesomeIcon icon={faTrash} />
							</StateButton>
						</ButtonGroup>
					) : (
						<ButtonGroup>
							<StateButton
								startContent={<FontAwesomeIcon icon={faSave} />}
								state={state}
								action={action}
								actionName="SaveSnapshot"
								isDisabled={!isConnected}
							>
								Snapshot
							</StateButton>
							<Button
								startContent={
									<FontAwesomeIcon icon={faCircleDot} />
								}
								onPress={() => action('startRecording', 0)}
								isDisabled={!isConnected}
							>
								Record
							</Button>
							<Dropdown
								placement="bottom-end"
								isDisabled={!isConnected}
							>
								<DropdownTrigger>
									<Button isIconOnly>
										<ChevronDownIcon />
									</Button>
								</DropdownTrigger>
								<DropdownMenu
									disallowEmptySelection
									aria-label="Recording timers"
									selectionMode="single"
								>
									{recordingTimes.map((value) => (
										<DropdownItem
											key={value}
											onPress={() =>
												action('startRecording', value)
											}
										>
											Record for {formatTime(value)} min
										</DropdownItem>
									))}
								</DropdownMenu>
							</Dropdown>
						</ButtonGroup>
					)}
					{hasPendingActions && <Spinner size="sm" />}
					<div className="flex-1" />
					{/* <Pressure /> */}
					<Popover>
						<PopoverTrigger>
							<Button
								isIconOnly
								className="h-12 ml-2"
								isDisabled={!isConnected}
							>
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
			{isWrongAccessToken && <AccessTokenOverlay />}
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
