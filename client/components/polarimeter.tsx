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

export function Polarimeter({
	label,
	children,
}: React.PropsWithChildren<{ label?: string }>) {
	const { state } = useControl<PolarimeterState>('tweezerPolarization');

	const isError = (state?.status ?? 'ok') !== 'ok';

	return (
		<div
			className={`${isError ? 'bg-orange-800' : 'bg-slate-800'} h14 rounded-xl flex items-center`}
		>
			<div className="flex flex-col px-4">
				{label && <div className="text-slate-500 text-sm">{label}</div>}
				<div className="flex gap-2">
					{state ? (
						<>
							{isError ? <span>{state.status}</span> : null}
							<p>
								θ ={' '}
								{polarizationAngleFormatter.format(state.theta * 180 / Math.PI)}
								°
							</p>
							<p>
								Eta ={' '}
								{polarizationAngleFormatter.format(
									state.eta * 180 / Math.PI,
								)}
								°
							</p>
							<p>DOP: {Math.round(state.DOP * 100)}&thinsp;%</p>
							<p>Power: {state.power * 1e6}&thinsp;µW</p>
						</>
					) : (
						'–'
					)}
				</div>
			</div>
			{children}
		</div>
	);
}
