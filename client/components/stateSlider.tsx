'use client';

import { Slider } from '@nextui-org/react';
import { useEffect, useState } from 'react';

type Props<T extends string> = {
	state: undefined | (Record<T, number> & Record<string, any>);
	action: (actionName: string, value: number) => void;
	actionName: string;
	variableName: T;
	values: number[];
	className?: string;
	label?: string;
	marks?: number[];
	formatter?: (value: number) => string;
};

export function StateSlider<T extends string>({
	state,
	action,
	actionName,
	variableName,
	values,
	marks,
	formatter = (v) => v.toString(),
	...props
}: Props<T>) {
	const [currentValue, setCurrentValue] = useState(
		state ? values.indexOf(state[variableName]) : 0,
	);
	useEffect(() => {
		if (state) setCurrentValue(values.indexOf(state[variableName]));
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [state?.[variableName], values]);

	const marksFor = marks?.map((v) => {
		const index = values.indexOf(v);
		return { value: index, label: formatter(v) };
	});

	return (
		<Slider
			maxValue={values.length - 1}
			// marks={marks}
			getValue={(i) => formatter(values[i as number])}
			value={currentValue}
			marks={marksFor}
			onChange={(v) => setCurrentValue(v as number)}
			onChangeEnd={(v) => {
				action(actionName, values[v as number]);
				if (state) setCurrentValue(values.indexOf(state[variableName]));
			}}
			// eslint-disable-next-line react/jsx-props-no-spreading
			{...props}
		/>
	);
}
