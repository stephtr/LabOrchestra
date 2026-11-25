import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ago, axisRange, decadeTicks, drawable, logTicks, niceTicks, drawSeries, summarize, type Point } from './trace.ts';

const series = (values: number[], step = 600, start = 1_000_000): Point[] => values.map((v, i) => [start + i * step, v]);

test('summary: min, max, last and the change per hour of the last hour', () => {
	const s = summarize(series([1, 2, 3, 4, 5, 6, 7]), false)!; // one point per 10 minutes, rising by 1 per 10 minutes
	assert.deepEqual([s.min, s.max, s.last], [1, 7, 7]);
	assert.ok(Math.abs(s.trend! - 6) < 1e-9); // 6 per hour
	assert.equal(summarize([], false), null);
	assert.ok(Math.abs(summarize(series([1, 2]), false)!.trend! - 6) < 1e-9); // 10 minutes of data are enough for a trend
	assert.equal(summarize([[0, 5]], false)!.trend, null); // one point: no trend
});

test('on a logarithmic axis the trend is a factor per hour, and values <= 0 are left out', () => {
	const s = summarize(series([1e-6, 0, -3, 2e-6, 4e-6, 8e-6, 1.6e-5], 1200), true)!;
	assert.equal(s.min, 1e-6);
	assert.ok(Math.abs(s.trend! - 8) < 1e-6); // doubling every 20 minutes = x8 per hour
	assert.equal(drawable(series([0, -1, NaN, Infinity, 3]), true).length, 1);
	assert.equal(drawable(series([0, -1, 3]), false).length, 3);
});

test('ticks are round numbers inside the range', () => {
	assert.deepEqual(niceTicks(8.9, 9.1, 4), [8.9, 8.95, 9, 9.05, 9.1]);
	assert.deepEqual(niceTicks(0, 10, 5), [0, 2, 4, 6, 8, 10]);
	assert.deepEqual(niceTicks(5, 5, 4), [5]);
	assert.deepEqual(decadeTicks(3e-7, 0.04), [1e-7, 1e-6, 1e-5, 1e-4, 1e-3, 1e-2, 1e-1]);
});

test('the axis has room around the data, also for a flat series', () => {
	const [lo, hi] = axisRange(10, 20, false);
	assert.ok(lo < 10 && hi > 20 && lo > 8);
	const [flatLo, flatHi] = axisRange(7, 7, false);
	assert.ok(flatLo < 7 && flatHi > 7);
	const [logLo, logHi] = axisRange(1e-6, 1e-3, true);
	assert.ok(logLo < 1e-6 && logHi > 1e-3);
	const [flatLogLo, flatLogHi] = axisRange(5, 5, true);
	assert.ok(flatLogLo < 5 && flatLogHi > 5);
});

test('a value that does not change is held up to now; with no points the live value fills the range; a short history starts at its first point', () => {
	const now = 2_000_000;
	assert.deepEqual(drawSeries([[now - 500, 3]], 3, now, 3600, false), { data: [[now - 500, 3], [now, 3]], from: now - 500 });
	assert.deepEqual(drawSeries([], 7, now, 3600, false), { data: [[now - 3600, 7], [now, 7]], from: now - 3600 });
	assert.deepEqual(drawSeries([], null, now, 3600, false).data, []);
	assert.deepEqual(drawSeries([], -1, now, 3600, true).data, []); // not drawable on a log axis
	const long = drawSeries([[now - 7200, 1], [now - 100, 2]], 2.5, now, 3600, false);
	assert.equal(long.from, now - 3600); // the range is the limit
	assert.deepEqual(long.data.at(-1), [now, 2.5]); // up to the live value
});

test('log ticks: decades, or round numbers inside one decade', () => {
	assert.deepEqual(logTicks(2e-7, 5e-3, 4), [1e-6, 1e-5, 1e-4, 1e-3]);
	assert.deepEqual(logTicks(1.5e-8, 1.7e-8, 3).length > 1, true);
});

test('how long ago', () => {
	assert.deepEqual([ago(2), ago(46), ago(180), ago(7200)], ['just now', '46 s ago', '3 min ago', '2 h ago']);
});
