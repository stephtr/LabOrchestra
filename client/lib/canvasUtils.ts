import { useEffect, useRef } from 'react';

function debounce<Args extends any[]>(
	callback: (...args: Args) => void,
	wait: number,
) {
	let timeoutId: number | null = null;
	return (...args: Args) => {
		window.clearTimeout(timeoutId!);
		timeoutId = window.setTimeout(() => {
			callback(...args);
		}, wait);
	};
}

export function useModernCanvas({
	onInitCtx,
	onFrame,
}: {
	onInitCtx?: (ctx: CanvasRenderingContext2D) => void;
	onFrame?: (ctx: CanvasRenderingContext2D) => void;
} = {}) {
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const ctx2DRef = useRef<CanvasRenderingContext2D | null>(null);

	let multiplier = 1;
	if (typeof window !== 'undefined') {
		multiplier = window.devicePixelRatio;
	}

	useEffect(() => {
		const canvas = canvasRef.current;
		if (!canvas) return;

		const resize = () => {
			const { clientWidth, clientHeight } = canvas;
			const width = Math.floor(clientWidth * multiplier);
			const height = Math.floor(clientHeight * multiplier);
			if (canvas.width !== width || canvas.height !== height) {
				canvas.width = width;
				canvas.height = height;
			}

			const ctx = canvas.getContext('2d');
			ctx2DRef.current = ctx;
			if (ctx && onInitCtx) {
				onInitCtx(ctx);
			}
		};

		canvas.style.width = '100%';
		canvas.style.height = '100%';
		resize();

		const observer = new ResizeObserver(debounce(resize, 100));
		observer.observe(canvas);

		return () => observer.disconnect();
	}, [canvasRef, multiplier, onInitCtx]);

	useEffect(() => {
		let rafId: number;
		const ctx = ctx2DRef.current;
		if (!ctx || !onFrame) return;

		const frame = () => {
			onFrame(ctx);
			rafId = requestAnimationFrame(frame);
		};

		rafId = requestAnimationFrame(frame);
		return () => cancelAnimationFrame(rafId);
	}, [onFrame]);

	return { canvasRef, ctx2DRef };
}
