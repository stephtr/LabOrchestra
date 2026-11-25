import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildProps, initialValues, LABEL, type PropSpec } from './settings.ts';

const specs: PropSpec[] = [
	LABEL,
	{ name: 'channel', label: 'Channel', type: 'integer', min: 0, default: 0 },
	{ name: 'step', type: 'number', min: 0.001 },
	{ name: 'confirm', type: 'boolean' },
	{ name: 'on_by_default', type: 'boolean', default: true },
	{ name: 'mode', type: 'select', options: ['a', 'b'], default: 'a' },
];

test('values start from the props, then the defaults', () => {
	assert.deepEqual(initialValues(specs, { label: 'QWP', channel: 2 }), { label: 'QWP', channel: '2', step: '', confirm: false, on_by_default: true, mode: 'a' });
});

test('only what differs from the default or is set ends up in the props; other props are kept', () => {
	const values = { label: ' QWP ', channel: '0', step: '2.5', confirm: true, on_by_default: false, mode: 'b' };
	const { props, errors } = buildProps(specs, values, { path: 'x.y', channel: 5 });
	assert.deepEqual(errors, {});
	assert.deepEqual(props, { path: 'x.y', label: 'QWP', step: 2.5, confirm: true, on_by_default: false, mode: 'b' }); // channel 0 is the default: dropped
});

test('mistakes are reported per field and nothing is guessed', () => {
	const { errors } = buildProps(specs, { label: '', channel: '1.5', step: '0', confirm: false, on_by_default: true, mode: 'z' }, {});
	assert.deepEqual(Object.keys(errors).sort(), ['channel', 'mode', 'step']);
	assert.match(errors.channel!, /whole number/);
	assert.match(errors.step!, /at least/);
	assert.equal(buildProps(specs, { label: '', channel: 'x', step: '', confirm: false, on_by_default: true, mode: 'a' }, {}).errors.channel, 'must be a number');
});

test('a label that is emptied is removed', () => {
	assert.deepEqual(buildProps(specs, { ...initialValues(specs, { label: 'old' }), label: '' }, { label: 'old' }).props, {});
});
