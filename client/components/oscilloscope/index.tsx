import { Key, useCallback } from 'react';
import {
	Button,
	ButtonGroup,
	Popover,
	PopoverContent,
	PopoverTrigger,
	Select,
	SelectItem,
	Tab,
	Tabs,
} from '@nextui-org/react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faChevronDown } from '@/lib/fortawesome/pro-solid-svg-icons';
import { useControl } from '@/lib/controlHub';
import { VerticalControlBar } from './verticalControlBar';
import { OscilloscopeChart } from './oscilloscopeChart';
import { StateSlider } from '../stateSlider';
import { OscilloscopeState, fftAveragingMarksFor, fftAveragingTimeInms, fftFrequencies, fftLengthValues, fftWindowFunctions, formatAveragingTime, formatFrequency } from './utils';

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
								<Select
									label="Window function"
									labelPlacement="outside"
									className="pt-2"
									selectedKeys={state? [state.fftWindowFunction] : []}
									onChange={(e) =>
										action('setFFTWindowFunction', e.target.value)
									}
								>
									{fftWindowFunctions.map((f) => (
										<SelectItem
											key={f.value}
											value={f.value}
										>
											{f.label}
										</SelectItem>
									))}
								</Select>
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
