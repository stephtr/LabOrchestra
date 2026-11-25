import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

const names = (text: string, pattern: RegExp) => [...text.matchAll(pattern)].map((m) => m[1]!).sort();

test('the type file for widget authors lists exactly what the SDK exports', () => {
	const sdk = fs.readFileSync(new URL('./widget-sdk.tsx', import.meta.url), 'utf8');
	const types = fs.readFileSync(new URL('../../templates/widget/laborchestra-widget.d.ts', import.meta.url), 'utf8');
	const real = names(sdk, /^export (?:const|function|class) (\w+)/gm);
	const typed = names(types, /^\texport (?:const|function|class) (\w+)/gm);
	assert.deepEqual(typed, real);
	const realTypes = names(sdk, /^export type (\w+)/gm);
	for (const type of realTypes.filter((t) => t !== 'Device')) assert.ok(types.includes(`export type ${type}`), `${type} is missing in the type file`);
});

test('the generated shim module of the SDK has every export', () => {
	// gen-shims.mjs makes public/_lo/widget.js; if it is there it must list the same names
	const shim = new URL('../public/_lo/widget.js', import.meta.url);
	if (!fs.existsSync(shim)) return;
	const sdk = fs.readFileSync(new URL('./widget-sdk.tsx', import.meta.url), 'utf8');
	assert.deepEqual(names(fs.readFileSync(shim, 'utf8'), /^export const (\w+)/gm), names(sdk, /^export (?:const|function|class) (\w+)/gm));
});
