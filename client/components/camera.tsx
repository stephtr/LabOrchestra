import { useControl, useStream } from '@/lib/controlHub';
import { useCallback, useRef } from 'react';
import { IconPlayerPlay, IconPlayerStop } from '@tabler/icons-react';
import { useModernCanvas } from '@/lib/canvasUtils';
import { StateButton } from './stateButton';

type CameraStreamData = {
	Image: Uint8ClampedArray;
	ImageWidth: number;
	ImageHeight: number;
	ImageChannels: number;
};

type CameraState = {
	running: boolean;
};

export function Camera({ deviceId }: { deviceId: string }) {
	const { state, action } = useControl<CameraState>(deviceId);

	const imageDataRef = useRef<ImageData | null>(null);
	const currentImageBitmapRef = useRef<ImageBitmap | null>(null);

	const { canvasRef } = useModernCanvas({
		onInitCtx: useCallback((ctx: CanvasRenderingContext2D) => {
			ctx.imageSmoothingEnabled = false;
		}, []),
		onFrame: useCallback((ctx: CanvasRenderingContext2D) => {
			const img = currentImageBitmapRef.current;
			if (!img) return;

			const { width: cW, height: cH } = ctx.canvas;
			const imgW = img.width;
			const imgH = img.height;

			// Calculate aspect‑ratio‑preserving draw size
			const imgRatio = imgW / imgH;
			const canvasRatio = cW / cH;

			let drawW = cW;
			let drawH = cH;

			if (imgRatio > canvasRatio) {
				// Image is wider than canvas — fit width
				drawW = cW;
				drawH = cW / imgRatio;
			} else {
				// Image is taller/narrower — fit height
				drawH = cH;
				drawW = cH * imgRatio;
			}

			// Center the image
			const offsetX = (cW - drawW) / 2;
			const offsetY = (cH - drawH) / 2;

			ctx.clearRect(0, 0, cW, cH);
			ctx.drawImage(img, offsetX, offsetY, drawW, drawH);
		}, []),
	});

	useStream(
		deviceId,
		useCallback(async (newData: CameraStreamData) => {
			if (
				newData.ImageHeight !== imageDataRef.current?.height ||
				newData.ImageWidth !== imageDataRef.current?.width
			) {
				imageDataRef.current = new ImageData(
					newData.ImageWidth,
					newData.ImageHeight,
				);
			}
			const img = await window.createImageBitmap(
				new ImageData(
					new Uint8ClampedArray(newData.Image),
					newData.ImageWidth,
					newData.ImageHeight,
				),
			);
			currentImageBitmapRef.current?.close();
			currentImageBitmapRef.current = img;
		}, []),
	);

	return (
		<div className="flex h-full overflow-hidden min-h-0">
			<div className="flex gap-2">
				{state?.running ? (
					<StateButton
						state={state}
						action={action}
						actionName="stop"
						isIconOnly
					>
						<IconPlayerStop />
					</StateButton>
				) : (
					<StateButton
						state={state}
						action={action}
						actionName="start"
						isIconOnly
					>
						<IconPlayerPlay />
					</StateButton>
				)}
			</div>
			<canvas ref={canvasRef} className="flex-1 min-h-0" />
		</div>
	);
}
