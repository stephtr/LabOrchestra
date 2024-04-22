import { Key, useCallback } from 'react';
import {
	Button,
	ButtonGroup,
	Popover,
	PopoverContent,
	PopoverTrigger,
	Tab,
	Tabs,
} from '@nextui-org/react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faChevronDown } from '@/lib/fortawesome/pro-solid-svg-icons';
import { useControl } from '@/lib/controlHub';
import { VerticalControlBar } from './verticalControlBar';
import { OscilloscopeChart } from './oscilloscopeChart';
import { StateSlider } from '../stateSlider';

export interface OscilloscopeState {
	running: boolean;
	timeMode: 'time' | 'fft';
	fftFrequency: number;
	fftLength: number;
	fftAveragingMode: 'prefer-data' | 'prefer-display';
	fftAveragingDurationInMilliseconds: number;
	testSignalFrequency: number;
	channels: Array<{
		channelActive: boolean;
		rangeInMillivolts: number;
	}>;
}

const fftLengthValues = [
	512,
	2 ** 10,
	2 ** 11,
	2 ** 12,
	2 ** 13,
	2 ** 14,
	2 ** 15,
	2 ** 16,
	2 ** 17,
	2 ** 18,
	2 ** 19,
];

const fftAveragingTimeInms = [
	0, 50, 100, 200, 500, 1000, 2000, 5000, 10000, -1,
];
const fftAveragingMarksFor = [0, 100, 1000, 10000, -1];

function formatAveragingTime(ms: number) {
	if (ms === -1) return '∞';
	if (ms === 0) return 'off';
	if (ms < 1000) return `${ms} ms`;
	return `${new Intl.NumberFormat().format(ms / 1000)} s`;
}

function formatFrequency(f: number) {
	const formatter = new Intl.NumberFormat();
	if (f >= 1e9) return `${formatter.format(f / 1e9)} GHz`;
	if (f >= 1e6) return `${formatter.format(f / 1e6)} MHz`;
	if (f >= 1e3) return `${formatter.format(f / 1e3)} kHz`;
	return `${formatter.format(f)} Hz`;
}

const fftFrequencies: number[] = [];
let decade = 1e3;
while (decade < 1e8) {
	fftFrequencies.push(1 * decade, 2 * decade, 5 * decade);
	decade *= 10;
}

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
					<ButtonGroup variant="flat" className="ml-4">
						<Button
							className="w-full h-12"
							onPress={() => action('resetFFTStorage')}
							isDisabled={!state}
						>
							FFT
						</Button>
						<Popover placement="bottom">
							<PopoverTrigger>
								<Button
									isIconOnly
									className="h-12"
									isDisabled={!state}
								>
									<FontAwesomeIcon icon={faChevronDown} />
								</Button>
							</PopoverTrigger>
							<PopoverContent
								aria-label="FFT settings"
								className="w-[300px] items-start"
							>
								<h2 className="text-xl">FFT Settings</h2>
								<StateSlider
									label="Frequency"
									className="mt-2"
									state={state}
									action={action}
									variableName="fftFrequency"
									actionName="setFFTFrequency"
									values={fftFrequencies}
									marks={[1e3, 1e6]}
									formatter={formatFrequency}
								/>
								<StateSlider
									label="Averaging duration"
									className="mt-2"
									state={state}
									action={action}
									variableName="fftAveragingDurationInMilliseconds"
									actionName="setFFTAveragingDuration"
									values={fftAveragingTimeInms}
									marks={fftAveragingMarksFor}
									formatter={formatAveragingTime}
								/>
								<div className="mt-2 mb-1">Averaging mode</div>
								<Tabs
									isDisabled={!isConnected}
									selectedKey={state?.fftAveragingMode}
									onSelectionChange={
										fftAveragingChangeHandler
									}
								>
									<Tab title="Precision" key="prefer-data" />
									<Tab
										title="Prefer display speed"
										key="prefer-display"
									/>
								</Tabs>
								<StateSlider
									label="Bin count"
									className="mt-2"
									state={state}
									action={action}
									variableName="fftLength"
									actionName="setFFTBinCount"
									values={fftLengthValues}
								/>
							</PopoverContent>
						</Popover>
					</ButtonGroup>
				)}
				{topContent}
			</div>
			<main className="col-start-2 row-start-2 overflow-hidden">
				<OscilloscopeChart state={state} />
			</main>
		</div>
	);
}
