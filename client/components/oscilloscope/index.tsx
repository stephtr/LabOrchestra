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
} from '@heroui/react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faChevronDown, faGear } from '@/lib/fortawesome/pro-solid-svg-icons';
import { useControl } from '@/lib/controlHub';
import { VerticalControlBar } from './verticalControlBar';
import { OscilloscopeChart } from './oscilloscopeChart';
import { StateSlider } from '../stateSlider';
import {
	OscilloscopeState,
	fftAveragingMarksFor,
	fftAveragingTimeInms,
	fftFrequencies,
	fftLengthValues,
	fftWindowFunctions,
	formatAveragingTime,
	formatFrequency,
	datapointsToSaveOptions,
	formatDatapoints,
} from './utils';

export function Oscilloscope({
	topContent,
	deviceId,
	frequencyOffset = 0,
}: {
	topContent?: React.ReactNode;
	deviceId: string;
	frequencyOffset?: number;
}) {
	const { isConnected, action, state } =
		useControl<OscilloscopeState>(deviceId);
	const selectionChangeHandler = useCallback(
		(mode: Key) => {
			action('setDisplayMode', mode);
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
		<div className="h-full grid grid-cols-[10rem_1fr] grid-rows-[3.5rem_1fr] overflow-hidden">
			<VerticalControlBar deviceId={deviceId} />
			<div className="col-start-2 flex items-center mr-1 gap-2">
				<Tabs
					isDisabled={!isConnected}
					selectedKey={state?.displayMode}
					onSelectionChange={selectionChangeHandler}
				>
					<Tab title="Time trace" key="time" />
					<Tab title="FFT" key="fft" />
				</Tabs>
				{state?.displayMode === 'fft' && (
					<ButtonGroup variant="flat">
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
								className="w-[300px] items-start gap-3 py-2 px-3"
							>
								<h2 className="text-xl">FFT Settings</h2>
								<StateSlider
									label="Frequency"
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
									selectedKeys={
										state ? [state.fftWindowFunction] : []
									}
									onChange={(e) =>
										action(
											'setFFTWindowFunction',
											e.target.value,
										)
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
				<Popover>
					<PopoverTrigger>
						<Button
							isIconOnly
							className="h-12"
							isDisabled={!isConnected}
						>
							<FontAwesomeIcon icon={faGear} />
						</Button>
					</PopoverTrigger>
					<PopoverContent
						aria-label="Oscilloscope settings"
						className="w-[300px] items-start py-2 px-3 gap-2"
					>
						<h2 className="text-xl mb-2">Oscilloscope settings</h2>
						<StateSlider
							state={state}
							action={action}
							variableName="datapointsToSnapshot"
							actionName="setDatapointsToSnapshot"
							values={datapointsToSaveOptions}
							label="Datapoints to save"
							marks={[
								10_000, 100_000, 1_000_000, 10_000_000,
								100_000_000,
							]}
							formatter={formatDatapoints}
						/>
						{state && (
							<p className="italic opacity-50 place-self-center">
								this correspond to{' '}
								{(
									state.datapointsToSnapshot /
									(2 * state.fftFrequency)
								).toLocaleString()}{' '}
								s
							</p>
						)}
					</PopoverContent>
				</Popover>
				{topContent}
			</div>
			<main className="col-start-2 row-start-2 overflow-hidden">
				<OscilloscopeChart
					state={state}
					deviceId={deviceId}
					frequencyOffset={frequencyOffset}
				/>
			</main>
		</div>
	);
}
