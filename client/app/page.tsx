'use client';

import { useEffect, useState } from 'react';
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
import { AccessTokenOverlay } from '@/components/accessTokenOverlay';
import { ChevronDownIcon } from '@/components/chevronDownIcon';
import { StateButton } from '@/components/stateButton';
import { StateInput } from '@/components/stateInput';
import { checkAccessToken, useControl } from '@/lib/controlHub';
import {
	IconDeviceFloppy,
	IconPlayerRecord,
	IconPlayerStop,
	IconSettingsFilled,
	IconStopwatch,
	IconTrash,
} from '@tabler/icons-react';
import { Camera } from '@/components/camera';

interface MainState {
	saveDirectory: string;
	filename: string;
	pendingActions: number;
	isRecording: boolean;
	recordingTimeSeconds: number;
	plannedRecordingTimeSeconds: number;
	remainingAdditionalRecordings: number;
}

const recordingTimes = [30, 60, 150, 300, 600, 1200, 1800];

function formatTime(seconds?: number) {
	if (!seconds) return '0:00';
	return `${Math.floor(seconds / 60)}:${(seconds % 60)
		.toString()
		.padStart(2, '0')}`;
}

export default function Home() {
	const { isConnected, action, state } = useControl<MainState>('main');
	const hasPendingActions = (state?.pendingActions ?? 0) > 0;

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

	return (
		<div className="h-full grid grid-rows-[3.5rem_1fr_5em]">
			{isWrongAccessToken && <AccessTokenOverlay />}

			<div className="flex flex-row items-center gap-2">
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
							startContent={<IconPlayerStop />}
							onPress={() => action('stopRecording')}
							isDisabled={!isConnected}
						>
							<div>{formatTime(state.recordingTimeSeconds)}</div>
							{state.plannedRecordingTimeSeconds > 0 && (
								<div className="text-sm text-slate-500">
									–{formatTime(remainingRecordingTime)}
								</div>
							)}
							{state.remainingAdditionalRecordings > 0 && (
								<div className="text-sm text-slate-500">
									+{state.remainingAdditionalRecordings}
								</div>
							)}
						</Button>
						<StateButton
							title="Abort recording"
							color="danger"
							state={state}
							action={action}
							actionName="abortRecording"
						>
							<IconTrash />
						</StateButton>
					</ButtonGroup>
				) : (
					<ButtonGroup>
						<StateButton
							startContent={<IconDeviceFloppy size="1.6em" />}
							state={state}
							action={action}
							actionName="SaveSnapshot"
							isDisabled={!isConnected}
						>
							Snapshot
						</StateButton>
						<Button
							startContent={<IconPlayerRecord size="1.6em" />}
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
								<>
									{recordingTimes.map((value) => (
										<DropdownItem
											key={value}
											onPress={() =>
												action('startRecording', value)
											}
											startContent={<IconStopwatch />}
										>
											Record for {formatTime(value)} min
										</DropdownItem>
									))}
								</>
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
							<IconSettingsFilled size="1.4em" />
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
			</div>

			<div>
				<Camera deviceId="camera" />
			</div>

			<div className="flex gap-2 items-center mx-2">Footer</div>
		</div>
	);
}
