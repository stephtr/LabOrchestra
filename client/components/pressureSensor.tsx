import { useControl } from '@/lib/controlHub';
import { Modal, ModalBody, ModalContent, ModalHeader } from '@nextui-org/react';
import { useState } from 'react';

interface PressureSensorState {
	channels: Array<{
		pressure: number;
		status: 'ok' | 'underrange' | 'overrange' | 'error';
	}>;
}

const formatter100mbar = new Intl.NumberFormat(undefined, {
	maximumFractionDigits: 0,
});
const formatter10mbar = new Intl.NumberFormat(undefined, {
	minimumFractionDigits: 1,
	maximumFractionDigits: 1,
});
const formatter1mbar = new Intl.NumberFormat(undefined, {
	minimumFractionDigits: 2,
	maximumFractionDigits: 2,
});

export function PressureSensor({
	label,
	channel = 0,
	innerClassName = '',
}: {
	label?: React.ReactNode;
	channel?: number;
	innerClassName?: string;
}) {
	const { state, action } = useControl<PressureSensorState>('pressure');
	const [isShownAsModal, setIsShownAsModal] = useState(false);

	let text: string | React.ReactElement = '-';
	if (state) {
		const pressure = state?.channels[channel].pressure;
		let pressureText = '';
		if (pressure >= 100) {
			pressureText = formatter100mbar.format(pressure);
		} else if (pressure >= 10) {
			pressureText = formatter10mbar.format(pressure);
		} else if (pressure >= 1) {
			pressureText = formatter1mbar.format(pressure);
		} else {
			const [base, exponential] = pressure.toExponential(2).split('e');
			pressureText = formatter1mbar.format(+base) + ' e' + exponential;
		}
		text =
			state.channels[channel].status == 'ok' ? (
				<>
					<span className="tabular-nums">{pressureText}</span> mbar
				</>
			) : (
				state.channels[channel].status
			);
	}

	return (
		<>
			<Modal
				isOpen={isShownAsModal}
				onOpenChange={setIsShownAsModal}
				size="4xl"
			>
				<ModalContent>
					<ModalHeader>{label}</ModalHeader>
					<ModalBody className="text-8xl pt-4 pb-12 text-center">
						<div>{text}</div>
					</ModalBody>
				</ModalContent>
			</Modal>
			<div
				className="bg-slate-800 h-14 rounded-xl px-4 flex flex-col justify-center"
				onDoubleClick={() => setIsShownAsModal(true)}
			>
				{label && <div className="text-slate-500 text-sm">{label}</div>}
				<div className={`text-slate-200 text-xl ${innerClassName}`}>
					{text}
				</div>
			</div>
		</>
	);
}
