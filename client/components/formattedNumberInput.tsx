'use client';

import { NumberParser } from '@/lib/numberParser';
import { Input } from '@nextui-org/react';
import { useState, useRef, useEffect, useCallback } from 'react';

// this is a temporary fix as long as the input can't handle non-integer numbers
const numberFormatter = new Intl.NumberFormat(undefined, {
	useGrouping: true,
	maximumFractionDigits: 0, // for now
});

const numberParser = NumberParser(new Intl.NumberFormat(undefined, {
	useGrouping: true,
	maximumFractionDigits: 20, // for now
}));


const findDigitPositionToLeft = (value: string, cursorPos: number): number => {
	for (let i = cursorPos - 1; i >= 0; i--) {
		if (/\d/.test(value[i])) {
			return value.slice(0, i + 1).replace(/[^\d]/g, '').length - 1;
		}
	}
	return -1;
};

const findCursorPositionLeftOfSeparator = (
	value: string,
	digitPos: number,
): number => {
	let count = -1;
	for (let i = 0; i < value.length; i++) {
		if (/\d/.test(value[i])) {
			count++;
		}
		if (count === digitPos) {
			return i + 1;
		}
	}
	return value.length;
};

const findNextCursorPosition = (
	value: string,
	currentPos: number,
	direction: number,
): number => {
	const separatorRegex = /[,.\s]/;
	let newPos = currentPos + direction;

	while (
		newPos >= 0 &&
		newPos < value.length &&
		separatorRegex.test(value[newPos])
	) {
		newPos += direction;
	}

	return Math.max(0, Math.min(newPos, value.length));
};

const findEquivalentCursorPosition = (
	oldValue: string,
	newValue: string,
	oldCursorPos: number,
) => {
	let oldDigitCount = 0;
	let newDigitCount = 0;
	let newCursorPos = 0;

	for (let i = 0; i < oldValue.length; i++) {
		if (i === oldCursorPos) break;
		if (/\d/.test(oldValue[i])) oldDigitCount++;
	}

	for (let i = 0; i < newValue.length; i++) {
		if (/\d/.test(newValue[i])) newDigitCount++;
		if (newDigitCount > oldDigitCount) break;
		newCursorPos = i + 1;
	}

	return newCursorPos;
};

const formatNumber = (num: number): string => {
	return num === 0 ? '0' : numberFormatter.format(num);
};

interface FormattedNumericInputProps {
	value: number;
	onChange: (value: number) => void;
	startContent?: React.ReactNode;
	endContent?: React.ReactNode;
	label?: React.ReactNode;
	className?: string;
}

export function FormattedNumericInput({
	value: externalValue,
	onChange,
	startContent,
	endContent,
	label,
	className,
}: FormattedNumericInputProps) {
	const [displayValue, setDisplayValue] = useState(
		formatNumber(externalValue),
	);
	const [internalValue, setInternalValue] = useState(externalValue);
	const inputRef = useRef<HTMLInputElement>(null);
	const lastInputTimeRef = useRef<number>(Date.now());
	const isFocusedRef = useRef<boolean>(false);

	const updateExternalValue = useCallback(
		(newValue: number) => {
			setInternalValue(newValue);
			onChange(newValue);
		},
		[onChange],
	);

	const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
		const input = e.target.value;
		const parsed = numberParser(input);

		if (!Number.isNaN(parsed) || input === '-') {
			const formatted = formatNumber(parsed);
			setDisplayValue(formatted);
			lastInputTimeRef.current = Date.now();

			const cursorPos = e.target.selectionStart || 0;
			setTimeout(() => {
				const newCursorPos = findEquivalentCursorPosition(
					input,
					formatted,
					cursorPos,
				);
				inputRef.current?.setSelectionRange(newCursorPos, newCursorPos);
			}, 0);
		} else if (input === '') {
			setDisplayValue('');
		}
	};

	const handleBlur = () => {
		if(!isFocusedRef.current) return;
		isFocusedRef.current = false;
		const parsed = numberParser(displayValue);
		if (!Number.isNaN(parsed)) {
			updateExternalValue(parsed);
		}
		setDisplayValue(formatNumber(internalValue));
	};

	const handleFocus = () => {
		isFocusedRef.current = true;
	};

	const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
		if (e.key === 'Enter') {
			const parsed = numberParser(displayValue);
			if (!Number.isNaN(parsed)) {
				updateExternalValue(parsed);
			}
			setDisplayValue(formatNumber(internalValue));
			isFocusedRef.current = false;
			inputRef.current!.blur();
		} else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
			e.preventDefault();
			const cursorPos = inputRef.current?.selectionStart || 0;
			const formattedValue = displayValue;
			const unformattedValue = formattedValue.replace(/[^\d.-]/g, '');

			const digitPos = findDigitPositionToLeft(formattedValue, cursorPos);

			const increment = e.key === 'ArrowUp' ? 1 : -1;
			let newNumber;

			if (digitPos === -1) {
				const multiplier =
					10 ** unformattedValue.replace('-', '').length;
				const currentNumber = numberParser(formattedValue);
				newNumber = (currentNumber || 0) + increment * multiplier;
			} else {
				const multiplier =
					10 **
					(unformattedValue.replace('-', '').length - digitPos - 1);
				const currentNumber = numberParser(formattedValue);
				newNumber = currentNumber + increment * multiplier;
			}

			const newValue = formatNumber(newNumber);
			setDisplayValue(newValue);
			updateExternalValue(newNumber);

			setTimeout(() => {
				const newCursorPos = findCursorPositionLeftOfSeparator(
					newValue,
					digitPos,
				);
				inputRef.current?.setSelectionRange(newCursorPos, newCursorPos);
			}, 0);
		} else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
			const cursorPos = inputRef.current?.selectionStart || 0;
			const direction = e.key === 'ArrowLeft' ? -1 : 1;
			const newPos = findNextCursorPosition(
				displayValue,
				cursorPos,
				direction,
			);

			if (newPos !== cursorPos) {
				e.preventDefault();
				inputRef.current?.setSelectionRange(newPos, newPos);
			}
		}
	};

	useEffect(() => {
		const now = Date.now();
		if (!isFocusedRef.current || now - lastInputTimeRef.current > 5000) {
			setDisplayValue(formatNumber(externalValue));
			setInternalValue(externalValue);
		}
	}, [externalValue]);

	return (
		<Input
			ref={inputRef}
			type="text"
			className={className}
			value={displayValue}
			onChange={handleChange}
			onKeyDown={handleKeyDown}
			onBlur={handleBlur}
			onFocus={handleFocus}
			startContent={startContent}
			endContent={endContent}
			label={label}
		/>
	);
}
