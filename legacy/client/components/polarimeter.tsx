import { useControl } from '@/lib/controlHub';

interface PolarimeterState {
	status: string;
	theta: number;
	eta: number;
	DOP: number;
	power: number;
}

const polarizationAngleFormatter = new Intl.NumberFormat(undefined, {
	minimumFractionDigits: 2,
	maximumFractionDigits: 2,
});

const powerFormatter = new Intl.NumberFormat(undefined, {
	maximumFractionDigits: 0,
});

export function Polarimeter({
	label,
	children,
}: React.PropsWithChildren<{ label?: string }>) {
	const { state } = useControl<PolarimeterState>('tweezerPolarization');

	const isError = (state?.status ?? 'ok') !== 'ok';

	return (
		<div
			className={`${isError ? 'bg-orange-800' : 'bg-slate-800'} h14 rounded-xl grid grid-rows-2 gap-x-4 grid-flow-col items-center tabular-nums pl-2 ${children ? '' : 'pr-2'}`}
		>
			<span className="text-slate-500 text-sm">{label}</span>
			<div className="flex gap-2">
				{state && (
					<>
						{isError ? <span>{state.status}</span> : null}
						<span>
							η ={' '}
							{polarizationAngleFormatter.format(
								(state.eta * 180) / Math.PI,
							)}
							°
						</span>
						<span>
							θ ={' '}
							{polarizationAngleFormatter.format(
								(state.theta * 180) / Math.PI,
							)}
							°
						</span>
					</>
				)}
			</div>
			{state && (
				<>
					<span className="text-slate-500 text-sm">DOP</span>
					<span>{Math.round(state.DOP * 100)}&thinsp;%</span>
				</>
			)}
			{state && (
				<>
					<span className="text-slate-500 text-sm">Power</span>
					<span>
						{powerFormatter.format(state.power * 1e6)}
						&thinsp;µW
					</span>
				</>
			)}
			<div className="row-span-2">{children}</div>
		</div>
	);
}
