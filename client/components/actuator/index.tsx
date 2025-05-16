import { useControl } from '@/lib/controlHub';
import { faGear, faXmark } from '@/lib/fontawesome-regular';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faStop } from '@/lib/fortawesome/pro-solid-svg-icons';
import {
	Button,
	Popover,
	PopoverContent,
	PopoverTrigger,
	Select,
	SelectItem,
} from '@heroui/react';
import React from 'react';
import { FormattedNumericInput } from '../formattedNumberInput';

type ActuatorMode = 'closed-loop' | 'open-loop' | 'scan';

interface ActuatorState {
	channels: Array<{
		type: 'linear' | 'rotation';
		targetPosition: number;
		actualPosition: number;
		mode: ActuatorMode;
		supportedModes: ActuatorMode[];
		velocity?: number;
	}>;
}

const umFormatter = new Intl.NumberFormat(undefined, {
	minimumFractionDigits: 3,
	maximumFractionDigits: 3,
});

function formatPosition(position: number) {
	return `${umFormatter.format(position)} µm`;
}

function getUnitForMode(mode: ActuatorMode) {
	switch (mode) {
		case 'closed-loop':
			return ' nm';
		case 'open-loop':
			return ' steps';
		case 'scan':
			return ' mV';
		default:
			return '';
	}
}

export function ActuatorButton() {
	const { state, action } = useControl<ActuatorState>('smaract');
	const [isExtended, setIsExtended] = React.useState(false);
	const scalingFactor = 1000;
	return (
		<Popover
			backdrop="transparent"
			placement="right-end"
			showArrow
			shouldCloseOnBlur={false}
			shouldCloseOnInteractOutside={() => false}
			shouldCloseOnScroll={false}
			isOpen={isExtended}
			onOpenChange={(open) => setIsExtended(open)}
		>
			<PopoverTrigger>
				<Button
					variant="flat"
					className="w-full min-h-12 h-auto leading-none px-2 py-1 grid grid-cols-[1.5em_1fr] tabular-nums justify-items-end"
				>
					{state &&
						state.channels.map((channel, index) => (
							// eslint-disable-next-line react/no-array-index-key
							<React.Fragment key={index}>
								<span>{index}:</span>
								<span>
									{formatPosition(channel.actualPosition)}
								</span>
							</React.Fragment>
						))}
				</Button>
			</PopoverTrigger>
			<PopoverContent className="grid gap-2 py-2">
				<div className="flex items-center justify-between font-bold">
					<span />
					Actuator Control
					<Button
						onPress={() => setIsExtended(false)}
						variant="light"
						className="px-2 py-2 min-w-0 h-auto"
					>
						<FontAwesomeIcon icon={faXmark} />
					</Button>
				</div>
				{state &&
					state.channels.map((channel, index) => (
						<FormattedNumericInput
							// eslint-disable-next-line react/no-array-index-key
							key={index}
							value={Math.round(
								channel.targetPosition * scalingFactor,
							)}
							label={`Channel ${index}`}
							onChange={(value) =>
								action(
									'set_position',
									index,
									value / scalingFactor,
									channel.mode,
								)
							}
							className="max-w-48"
							endContent={
								<>
									{getUnitForMode(channel.mode)}
									<Popover backdrop="opaque">
										<PopoverTrigger>
											<Button
												isIconOnly
												className="self-center"
												variant="light"
											>
												<FontAwesomeIcon
													icon={faGear}
												/>
											</Button>
										</PopoverTrigger>
										<PopoverContent
											aria-label="Channel settings"
											className="grid gap-2 py-2"
										>
											<div className="font-bold">
												Channel {index} settings
											</div>
											{channel.supportedModes.length >
												0 && (
												<Select
													label="Move mode"
													selectedKeys={
														new Set([channel.mode])
													}
													onSelectionChange={(
														selectedKeys,
													) =>
														action(
															'set_mode',
															index,
															Array.from(
																selectedKeys,
															)[0],
														)
													}
												>
													{channel.supportedModes.map(
														(mode) => (
															<SelectItem
																key={mode}
															>
																{mode.replaceAll(
																	'-',
																	' ',
																)}
															</SelectItem>
														),
													)}
												</Select>
											)}
											{channel.velocity !== undefined && (
												<FormattedNumericInput
													label="Velocity"
													value={
														channel.velocity *
														scalingFactor
													}
													onChange={(val) =>
														action(
															'set_velocity',
															index,
															val / scalingFactor,
															channel.mode,
														)
													}
													endContent={`${getUnitForMode(
														channel.mode,
													)}/s`}
													className="max-w-48"
												/>
											)}
										</PopoverContent>
									</Popover>
								</>
							}
						/>
					))}
				<Button
					color="danger"
					variant="flat"
					startContent={<FontAwesomeIcon icon={faStop} />}
					onPress={() => action('stop')}
				>
					Stop movement
				</Button>
			</PopoverContent>
		</Popover>
	);
}
