import { Input, InputProps } from "@heroui/react";
import { useEffect, useState, useRef } from 'react';

function useOnChange(
	handleOnChange: (this: HTMLInputElement, ev: Event) => any,
) {
	const ref = useRef<HTMLInputElement>(null);

	useEffect(() => {
		if (!ref.current) return;
		const elem = ref.current;
		elem.addEventListener('change', handleOnChange);
		return () => elem.removeEventListener('change', handleOnChange);
	}, [handleOnChange, ref]);

	return ref;
}

type Props<TKey extends string> = {
	state: undefined | (Record<TKey, string> & Record<string, any>);
	action: (actionName: string, value: string) => void;
	actionName: string;
	variableName: TKey;
} & InputProps;

export function StateInput<TKey extends string>({
	state,
	action,
	actionName,
	variableName,
	...props
}: Props<TKey>) {
	const [currentValue, setCurrentValue] = useState<string>(
		state?.[variableName] ?? '',
	);
	useEffect(() => {
		if (state) setCurrentValue(state[variableName]);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [state?.[variableName]]);

	const ref = useOnChange((e) => {
		action(actionName, (e.currentTarget as HTMLInputElement).value);
		if (state) setCurrentValue(state[variableName]);
	});

	return (
		<Input
			value={currentValue}
			onChange={(e) => setCurrentValue(e.target.value)}
			ref={ref as React.Ref<HTMLInputElement>}
			// eslint-disable-next-line react/jsx-props-no-spreading
			{...props}
		/>
	);
}
