import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyPatch } from './patch.ts';

const state = { channels: [{ pressure: 1, status: 'ok' }, { pressure: 2, status: 'ok' }], name: 'a', x: 1 };

test('sets nested values and leaves the old state alone', () => {
	const next = applyPatch(state, { set: { 'channels.1.pressure': 3, name: 'b' } });
	assert.equal(next.channels[1]?.pressure, 3);
	assert.equal(next.name, 'b');
	assert.equal(state.channels[1]?.pressure, 2);
	assert.equal(next.channels[0], state.channels[0]); // unchanged parts are shared
});

test('adds, deletes and replaces lists', () => {
	const next = applyPatch(state, { set: { y: { z: 1 }, channels: [] }, del: ['x'] });
	assert.deepEqual(next, { channels: [], name: 'a', y: { z: 1 } });
});

test('paths that do not exist are errors', () => {
	assert.throws(() => applyPatch(state, { set: { 'nothing.here': 1 } }));
	assert.throws(() => applyPatch(state, { set: { 'channels.5.pressure': 1 } }));
	assert.throws(() => applyPatch(state, { del: ['channels.0'] }));
	assert.throws(() => applyPatch(state, { del: ['missing'] }));
});

test('follows the same patches as the Python implementation', () => {
	// a list that changes length is replaced as a whole, an element is set by index
	let s: Record<string, unknown> = { tree: { items: [{ value: 1 }], flag: false } };
	s = applyPatch(s, { set: { 'tree.items.0.value': 0.5, 'tree.flag': true } });
	s = applyPatch(s, { set: { 'tree.items': [{ value: 1 }, { value: 2 }] } });
	assert.deepEqual(s, { tree: { items: [{ value: 1 }, { value: 2 }], flag: true } });
});
