import { Plugin, Point } from 'chart.js';
import tinycolor from 'tinycolor2';

const fsSource = `
	precision lowp float;
	uniform vec4 uColor;

	void main() {
		gl_FragColor = uColor;
	}`;
const vsSource = `
	attribute vec4 aVertexPosition;
	uniform mat4 uTransformationMatrix;

	void main() {
   		gl_Position = uTransformationMatrix * aVertexPosition;
	}`;

function loadShader(gl: WebGLRenderingContext, type: number, source: string) {
	const shader = gl.createShader(type);
	if (!shader) return null;
	gl.shaderSource(shader, source);
	gl.compileShader(shader);
	if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
		alert(
			`An error occurred compiling the shaders: ${gl.getShaderInfoLog(shader)}`,
		);
		gl.deleteShader(shader);
		return null;
	}
	return shader;
}

function initShaderProgram(
	gl: WebGLRenderingContext,
	vsSource: string,
	fsSource: string,
) {
	const vertexShader = loadShader(gl, gl.VERTEX_SHADER, vsSource);
	const fragmentShader = loadShader(gl, gl.FRAGMENT_SHADER, fsSource);

	const shaderProgram = gl.createProgram();
	if (!shaderProgram || !vertexShader || !fragmentShader) return null;
	gl.attachShader(shaderProgram, vertexShader);
	gl.attachShader(shaderProgram, fragmentShader);
	gl.linkProgram(shaderProgram);

	if (!gl.getProgramParameter(shaderProgram, gl.LINK_STATUS)) {
		alert(
			`Unable to initialize the shader program: ${gl.getProgramInfoLog(
				shaderProgram,
			)}`,
		);
		return null;
	}

	return {
		program: shaderProgram,
		uTransformationMatrix: gl.getUniformLocation(
			shaderProgram,
			'uTransformationMatrix',
		),
		aVertexPosition: gl.getAttribLocation(shaderProgram, 'aVertexPosition'),
		uColor: gl.getUniformLocation(shaderProgram, 'uColor'),
	};
}

function createTransformationMatrix(
	xMin: number,
	xMax: number,
	yMin: number,
	yMax: number,
) {
	const scaleX = 2 / (xMax - xMin);
	const scaleY = 2 / (yMax - yMin);

	const translateX = -((xMax + xMin) / 2) * scaleX;
	const translateY = -((yMax + yMin) / 2) * scaleY;

	return new Float32Array([
		scaleX,
		0,
		0,
		0,
		0,
		scaleY,
		0,
		0,
		0,
		0,
		1,
		0,
		translateX,
		translateY,
		0,
		1,
	]);
}

export function createWebglPlugin(): Plugin<'line'> {
	let canvas2: HTMLCanvasElement | null;
	let gl: WebGLRenderingContext | null;
	let shaderProgram: ReturnType<typeof initShaderProgram> | null;
	let positionBuffer: WebGLBuffer | null;
	return {
		id: 'webgl',
		install(chart) {
			if (canvas2) return;
			canvas2 = document.createElement('canvas');
			chart.canvas.insertAdjacentElement('beforebegin', canvas2);
			canvas2.style.position = 'absolute';
			canvas2.style.pointerEvents = 'none';
			gl = canvas2.getContext('webgl');
			if (!gl) return false;
			shaderProgram = initShaderProgram(gl, vsSource, fsSource);
			positionBuffer = gl.createBuffer();
		},
		uninstall() {
			canvas2?.remove();
			canvas2 = null;
		},
		resize(chart, { size: { width, height } }) {
			if (!canvas2) return;
			canvas2.width = width * window.devicePixelRatio;
			canvas2.height = height * window.devicePixelRatio;
			canvas2.style.width = `${width}px`;
			canvas2.style.height = `${height}px`;
		},
		beforeDatasetsDraw(chart, args) {
			if (!gl || !shaderProgram) return;
			const { left, top, right, bottom } = chart.chartArea;
			const { height } = chart.canvas.getBoundingClientRect();
			gl.viewport(
				left * window.devicePixelRatio,
				(height - bottom) * window.devicePixelRatio,
				(right - left) * window.devicePixelRatio,
				(bottom - top) * window.devicePixelRatio,
			);
		},
		beforeDatasetDraw(chart, { index, meta }) {
			if (!gl || !shaderProgram) return;
			const data = chart.data.datasets[index];
			if (data.data.length === 0) return;
			const scales = chart.scales;
			const xAxis = data.xAxisID ? scales[data.xAxisID] : scales.x;
			const yAxis = data.yAxisID ? scales[data.yAxisID] : scales.y;
			gl.uniformMatrix4fv(
				shaderProgram.uTransformationMatrix,
				false,
				createTransformationMatrix(
					xAxis.min,
					xAxis.max,
					yAxis.min,
					yAxis.max,
				),
			);
			gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
			const positions = new Array(data.data.length * 2);
			if ((data.data[0] as any).x) {
				for (let i = 0; i < data.data.length; i++) {
					const { x, y } = data.data[i] as Point;
					positions[2 * i] = x;
					positions[2 * i + 1] = y;
				}
			} else {
				const labels = chart.data.labels as Number[];
				for (let i = 0; i < data.data.length; i++) {
					const x = labels[i];
					const y = data.data[i] as number;
					positions[2 * i] = x;
					positions[2 * i + 1] = y;
				}
			}
			gl.bufferData(
				gl.ARRAY_BUFFER,
				new Float32Array(positions),
				gl.STATIC_DRAW,
			);
			gl.vertexAttribPointer(
				shaderProgram.aVertexPosition,
				2,
				gl.FLOAT,
				false,
				0,
				0,
			);
			gl.enableVertexAttribArray(shaderProgram.aVertexPosition);
			const color = tinycolor(
				data.borderColor && typeof data.borderColor === 'string'
					? data.borderColor
					: 'rgba(0.5, 0.5, 0.5, 1)',
			).toRgb();
			gl.uniform4f(
				shaderProgram.uColor,
				color.r,
				color.g,
				color.b,
				color.a,
			);
			gl.useProgram(shaderProgram.program);
			const drawArea = false;
			gl.drawArrays(
				drawArea ? gl.TRIANGLE_STRIP : gl.LINE_STRIP,
				0,
				positions.length / 2,
			);
			return false;
		},
	};
}
