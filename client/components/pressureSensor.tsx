import { useControl } from '@/lib/controlHub';

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
	maximumFractionDigits: 1,
});
const formatter1mbar = new Intl.NumberFormat(undefined, {
	maximumFractionDigits: 2,
});

export function PressureSensor({
	label,
	channel = 0,
}: {
	label?: React.ReactNode;
	channel?: number;
}) {
	const { isConnected, state, action } =
		useControl<PressureSensorState>('pressure');

	let text = '-';
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
			state.channels[channel].status == 'ok'
				? `${pressureText} mbar`
				: state.channels[channel].status;
	}

	return (
		<div className="bg-slate-800 h-14 rounded-xl px-4 flex flex-col justify-center">
			{label && <div className="text-slate-500 text-sm">{label}</div>}
			<div className="text-slate-200 text-xl">{text}</div>
		</div>
	);
}
