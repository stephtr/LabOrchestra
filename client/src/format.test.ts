import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseFrequency, unitFor } from './format.ts';

const units = { 'channels.*.pressure': 'mbar', theta: 'rad' };

test('a list index in the path matches the star of the schema', () => {
	assert.equal(unitFor(units, 'channels.0.pressure'), 'mbar');
	assert.equal(unitFor(units, 'channels.12.pressure'), 'mbar');
	assert.equal(unitFor(units, 'theta'), 'rad');
});

test('fields without a unit have none', () => {
	assert.equal(unitFor(units, 'channels.0.status'), undefined);
	assert.equal(unitFor(undefined, 'theta'), undefined);
	assert.equal(unitFor(units, 'channels.pressure'), undefined);
});

test('parseFrequency understands SI prefixes and plain numbers', () => {
	assert.equal(parseFrequency('867 kHz'), 867e3);
	assert.equal(parseFrequency('1,5MHz'), 1.5e6);
	assert.equal(parseFrequency('2e6'), 2e6);
	assert.equal(parseFrequency(' 100 Hz '), 100);
	assert.ok(Number.isNaN(parseFrequency('fast')));
	assert.ok(Number.isNaN(parseFrequency('')));
});
