import { Key, useCallback, useEffect, useState } from 'react';
import {
	Button,
	Popover,
	PopoverContent,
	PopoverTrigger,
	Slider,
	Tab,
	Tabs,
} from '@nextui-org/react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faChevronDown } from '@/lib/fortawesome/pro-solid-svg-icons';
import { useControl } from '@/lib/controlHub';
import { VerticalControlBar } from './verticalControlBar';
import { OscilloscopeChart } from './oscilloscopeChart';

export interface OscilloscopeState {
	running: boolean;
	timeMode: 'time' | 'fft';
	fftLength: number;
	fftAveragingMode: 'prefer-data' | 'prefer-display';
	channels: Array<{
		channelActive: boolean;
		rangeInMillivolts: number;
	}>;
}

const fftLengthValues = [512, 1024, 2048, 4096, 8192, 16384, 32768, 65536];

export function Oscilloscope({ topContent }: { topContent?: React.ReactNode }) {
	const { isConnected, action, state } =
		useControl<OscilloscopeState>('myOsci');
	const selectionChangeHandler = useCallback(
		(mode: Key) => {
			action('setTimeMode', mode);
		},
		[action],
	);
	const fftAveragingChangeHandler = useCallback(
		(mode: Key) => {
			action('setAveragingMode', mode);
		},
		[action],
	);
	const [currentBinCount, setCurrentBinCount] = useState<number>(
		state ? fftLengthValues.indexOf(state.fftLength) : 0,
	);
	useEffect(() => {
		if (state) setCurrentBinCount(fftLengthValues.indexOf(state.fftLength));
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [state?.fftLength]);
	return (
		<div className="h-full grid grid-cols-[10rem,1fr] grid-rows-[3.5rem,1fr]">
			<VerticalControlBar />
			<div className="col-start-2 flex items-center mr-1">
				<Tabs
					isDisabled={!isConnected}
					selectedKey={state?.timeMode}
					onSelectionChange={selectionChangeHandler}
				>
					<Tab title="Time trace" key="time" />
					<Tab title="FFT" key="fft" />
				</Tabs>

				{state?.timeMode === 'fft' && (
					<Popover placement="bottom">
						<PopoverTrigger>
							<Button
								isIconOnly
								className="h-12 w-auto px-4 ml-4"
								isDisabled={!state}
								endContent={
									<FontAwesomeIcon icon={faChevronDown} />
								}
							>
								FFT Settings
							</Button>
						</PopoverTrigger>
						<PopoverContent
							aria-label="FFT settings"
							className="w-[300px] items-start"
						>
							<h2 className="text-xl">FFT Settings</h2>
							<Slider
								label="Averaging duration"
								className="mt-2"
								maxValue={fftLengthValues.length - 1}
								// marks={marks}
								getValue={(i) =>
									fftLengthValues[i as number].toString()
								}
								value={currentBinCount}
								onChange={(v) =>
									setCurrentBinCount(v as number)
								}
								onChangeEnd={(v) => {
									action(
										'setFFTBinCount',
										fftLengthValues[v as number],
									);
									if (state)
										setCurrentBinCount(
											fftLengthValues.indexOf(
												state.fftLength,
											),
										);
								}}
							/>
							<div className="mt-2 mb-1">Averaging mode</div>
							<Tabs
								isDisabled={!isConnected}
								selectedKey={state?.fftAveragingMode}
								onSelectionChange={fftAveragingChangeHandler}
							>
								<Tab title="Prefer data" key="prefer-data" />
								<Tab
									title="Prefer display"
									key="prefer-display"
								/>
							</Tabs>
							<Slider
								label="Bin count"
								className="mt-2"
								maxValue={fftLengthValues.length - 1}
								// marks={marks}
								getValue={(i) =>
									fftLengthValues[i as number].toString()
								}
								value={currentBinCount}
								onChange={(v) =>
									setCurrentBinCount(v as number)
								}
								onChangeEnd={(v) => {
									action(
										'setFFTBinCount',
										fftLengthValues[v as number],
									);
									if (state)
										setCurrentBinCount(
											fftLengthValues.indexOf(
												state.fftLength,
											),
										);
								}}
							/>
						</PopoverContent>
					</Popover>
				)}
				{topContent}
			</div>
			<main className="col-start-2 row-start-2 overflow-hidden">
				<OscilloscopeChart state={state} />
			</main>
		</div>
	);
}
