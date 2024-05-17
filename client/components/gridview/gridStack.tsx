'use client';

import { useEffect, useState } from 'react';
import useResizeObserver from 'use-resize-observer';

function Splitter({ onMove }: { onMove: (position: number) => void }) {
	const startDragging = () => {
		function whileDragging(e: MouseEvent) {
			onMove(e.movementY);
		}
		window.addEventListener('mousemove', whileDragging);
		window.addEventListener(
			'mouseup',
			() => {
				window.removeEventListener('mousemove', whileDragging);
			},
			{ once: true },
		);
	};
	return (
		// eslint-disable-next-line jsx-a11y/no-static-element-interactions
		<div
			className="splitter h-2 cursor-ns-resize bg-zinc-900 hover:bg-zinc-800 select-none"
			onMouseDown={startDragging}
		/>
	);
}

export function GridStack({
	children,
	className = '',
}: {
	children: Array<React.ReactNode>;
	className?: string;
}) {
	const {
		ref,
		height = typeof window !== 'undefined' ? window.innerHeight : 0,
	} = useResizeObserver<HTMLDivElement>();
	const [fractions, setFractions] = useState<
		Array<readonly [string | number, number]>
	>([]);
	useEffect(() => {
		const oldFractions = Object.fromEntries(fractions) as Record<
			string | number,
			number
		>;
		const newFractions = children.map((child, index) => {
			const key = (child as React.ReactElement).key ?? index;
			return [key, oldFractions[key] ?? 1 / children.length] as const;
		});
		const newFractionsSum = newFractions.reduce(
			(acc, [, fraction]) => acc + fraction,
			0,
		);
		newFractions.map(([key, fraction]) => [
			key,
			fraction / newFractionsSum,
		]);
		setFractions(newFractions);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [children.map((c) => (c as React.ReactElement).key).join('-')]);
	const moveSeparator = (index: number, delta: number) => {
		if (delta === 0) return;
		const relativeDelta = delta / height;
		setFractions((oldFractions) => {
			const minFraction = 0.05;
			const newFractions = [...oldFractions];
			const oldSum = newFractions[index][1] + newFractions[index + 1][1];
			let newSize1 = newFractions[index][1] + relativeDelta;
			let newSize2 = newFractions[index + 1][1] - relativeDelta;
			if (oldSum < 2 * minFraction) {
				newSize1 = oldSum / 2;
				newSize2 = oldSum / 2;
			} else if (newSize1 < minFraction) {
				newSize1 = minFraction;
				newSize2 = oldSum - newSize1;
			} else if (newSize2 < minFraction) {
				newSize2 = minFraction;
				newSize1 = oldSum - newSize2;
			}
			newFractions[index] = [newFractions[index][0], newSize1];
			newFractions[index + 1] = [newFractions[index + 1][0], newSize2];
			return newFractions;
		});
	};
	return (
		<div className={`flex flex-col ${className}`} ref={ref}>
			{children.flatMap((child, index) => {
				const key = (child as React.ReactElement).key ?? index;
				const isLastChild = index === children.length - 1;
				const wrappedChild = (
					<div
						style={
							isLastChild || !fractions[index]
								? { flex: '1' }
								: {
										height: `calc(${fractions[index][1] * 100}% - ${0.5 * (1 - 1 / children.length)}rem)`,
									}
						}
						className="overflow-hidden"
					>
						{child}
					</div>
				);
				return isLastChild
					? wrappedChild
					: [
							wrappedChild,
							<Splitter
								key={key}
								onMove={(delta) => moveSeparator(index, delta)}
							/>,
						];
			})}
		</div>
	);
}
