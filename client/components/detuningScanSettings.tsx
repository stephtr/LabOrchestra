import {
	Button,
	Input,
	Modal,
	ModalBody,
	ModalContent,
	ModalFooter,
	ModalHeader,
	Textarea,
} from '@heroui/react';
import React, { useEffect, useState } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faTrashCan } from '@/lib/fontawesome-regular';
import { useControl } from '@/lib/controlHub';
import { FrequencyGenerator } from './frequencyGenerator';

type MeasurementPlan = Array<{ offset: number; duration: number }>;

interface DetuningScanControlState {
	measurementPlan: string;
}

export function useDetuningScanComponent() {
	const { action, state } = useControl<DetuningScanControlState>(
		'detuningScanControl',
	);
	const [isVisible, setIsVisible] = useState(false);
	const [measurementPlan, setMeasurementPlan] = useState<MeasurementPlan>([]);

	const [editingMeasurementPlan, setEditingMeasurementPlan] = useState('');

	useEffect(
		() =>
			setEditingMeasurementPlan(
				JSON.stringify(measurementPlan, null, '\t'),
			),
		[measurementPlan],
	);

	const addMeasurement = (formData: FormData) => {
		setMeasurementPlan((prev) => [
			...prev,
			{
				offset:
					Number.parseFloat(formData.get('offset') as string) * 1e3,
				duration: Number.parseFloat(formData.get('duration') as string),
			},
		]);
	};

	const updateEditingMeasurementPlan = () => {
		try {
			setMeasurementPlan(JSON.parse(editingMeasurementPlan));
		} catch (e) {
			setEditingMeasurementPlan(
				JSON.stringify(measurementPlan, null, '\t'),
			);
		}
	};

	const save = () =>
		action('saveMeasurementPlan', JSON.stringify(measurementPlan));

	const startScan = () => {
		action('startScan', JSON.stringify(measurementPlan));
		setIsVisible(false);
	};

	return {
		invoke: () => {
			if (!state) return;
			try {
				setMeasurementPlan(JSON.parse(state.measurementPlan));
				// eslint-disable-next-line no-empty
			} catch (e) {}
			setIsVisible(true);
		},
		element: (
			<Modal isOpen={isVisible} onClose={() => setIsVisible(false)}>
				<ModalContent>
					<ModalHeader>Detuning Scan Settings</ModalHeader>
					<ModalBody>
						<div className="grid grid-cols-2 items-center">
							Center frequency:
							<FrequencyGenerator />
						</div>
						<hr className="border-zinc-700" />
						<form action={addMeasurement}>
							<div className="grid grid-cols-2 gap-2">
								<span className="text-center">
									Frequency offset
								</span>
								<span className="text-center">Duration</span>
								{measurementPlan.map((measurement, index) => (
									// eslint-disable-next-line react/no-array-index-key
									<React.Fragment key={index}>
										<span className="text-center">
											{measurement.offset * 1e-3} kHz
										</span>
										<div className="grid grid-cols-[2rem_1fr_2rem] items-center justify-between text-center">
											<span />
											{measurement.duration} min
											<Button
												variant="flat"
												onPress={() =>
													setMeasurementPlan((prev) =>
														prev.filter(
															(_, i) =>
																i !== index,
														),
													)
												}
												className="h-8 px-4 min-w-0"
											>
												<FontAwesomeIcon
													icon={faTrashCan}
												/>
											</Button>
										</div>
									</React.Fragment>
								))}
								{measurementPlan.length === 0 && (
									<div className="col-span-2 text-zinc-500 italic text-center mb-1">
										No entries
									</div>
								)}
								<Input
									inputMode="numeric"
									endContent="kHz"
									name="offset"
									isRequired
								/>
								<Input
									inputMode="numeric"
									endContent="min"
									name="duration"
									isRequired
								/>
								<div className="col-span-2 flex flex-row justify-end">
									<Button type="submit" className="col">
										Add measurement
									</Button>
								</div>
							</div>
						</form>
						<hr className="border-zinc-700" />
						<Textarea
							value={editingMeasurementPlan}
							onChange={(e) =>
								setEditingMeasurementPlan(e.target.value)
							}
							onBlur={updateEditingMeasurementPlan}
						/>
					</ModalBody>
					<ModalFooter className="flex flex-row justify-between">
						<Button variant="bordered" onPress={save}>
							Save
						</Button>
						<div className="flex flex-row gap-2">
							<Button onPress={() => setIsVisible(false)}>
								Cancel
							</Button>
							<Button color="primary" onPress={startScan}>
								Start Scan
							</Button>
						</div>
					</ModalFooter>
				</ModalContent>
			</Modal>
		),
	};
}
