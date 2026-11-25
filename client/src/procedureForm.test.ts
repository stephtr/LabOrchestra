import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildParams, duration, initialValues, type ProcedureParam } from './procedureForm.ts';

const params: ProcedureParam[] = [
	{ name: 'detunings', type: 'list', items: 'float', default: null, required: true, doc: null },
	{ name: 'duration_s', type: 'float', default: 60, required: false, doc: null },
	{ name: 'repeats', type: 'int', default: null, required: false, doc: null },
	{ name: 'label', type: 'str', default: 'x', required: false, doc: null },
	{ name: 'fast', type: 'bool', default: false, required: false, doc: null },
	{ name: 'extra', type: 'json', default: null, required: false, doc: null },
	{ name: 'names', type: 'list', items: 'str', default: ['a', 'b'], required: false, doc: null },
];

test('the form starts with the defaults', () => {
	assert.deepEqual(initialValues(params), { detunings: '', duration_s: '60', repeats: '', label: 'x', fast: false, extra: '', names: 'a, b' });
});

test('typed values become the parameters of the run; empty optional ones are left out', () => {
	const values = { ...initialValues(params), detunings: '-1e6, 0; 2.5e6', repeats: '', extra: '{"a": [1, 2]}', fast: true };
	const { params: built, errors } = buildParams(params, values);
	assert.deepEqual(errors, {});
	assert.deepEqual(built, { detunings: [-1e6, 0, 2.5e6], duration_s: 60, label: 'x', fast: true, extra: { a: [1, 2] }, names: ['a', 'b'] });
});

test('mistakes are reported per field: required, numbers, whole numbers, JSON, lists', () => {
	const { errors } = buildParams(params, { ...initialValues(params), detunings: '1, two', duration_s: 'long', repeats: '2.5', extra: '{oops' });
	assert.deepEqual(Object.keys(errors).sort(), ['detunings', 'duration_s', 'extra', 'repeats']);
	assert.equal(buildParams(params, initialValues(params)).errors.detunings, 'is required');
	assert.equal(buildParams(params, { ...initialValues(params), detunings: '1', duration_s: '1,5' }).params.duration_s, 1.5); // a decimal comma
});

test('durations read well', () => {
	assert.deepEqual([duration(4), duration(192), duration(3725), duration(-1)], ['4 s', '3 min 12 s', '1 h 02 min', '0 s']);
});
