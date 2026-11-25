import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addMain, addToStrip, defaultView, emptyView, mains, moveToMain, moveToStrip, parseView, removeWidget, setSizes, swapMains, widget } from './layout.ts';

const ids = (v: ReturnType<typeof emptyView>) => mains(v.root).map((m) => m.widget.id);

test('the first main widget is the root, later ones split below', () => {
	const a = widget('oscilloscope', 'a');
	const b = widget('oscilloscope', 'b');
	const view = addMain(addMain(emptyView(), a), b);
	assert.equal(view.root?.kind, 'split');
	assert.deepEqual(ids(view), [a.id, b.id]);
	assert.deepEqual(view.root?.kind === 'split' && view.root.sizes, [50, 50]);
});

test('adding next to a widget splits it in the asked direction, same direction merges', () => {
	const a = widget('x');
	const b = widget('x');
	const c = widget('x');
	let view = addMain(emptyView(), a);
	view = addMain(view, b, { id: a.id, side: 'right' });
	view = addMain(view, c, { id: b.id, side: 'right' });
	assert.equal(view.root?.kind === 'split' && view.root.dir, 'row');
	assert.equal(view.root?.kind === 'split' && view.root.children.length, 3); // merged, not nested
	assert.deepEqual(ids(view), [a.id, b.id, c.id]);
});

test('removing the second of two collapses the split', () => {
	const a = widget('x');
	const b = widget('x');
	const view = removeWidget(addMain(addMain(emptyView(), a), b), b.id);
	assert.equal(view.root?.kind, 'main');
	assert.equal(removeWidget(view, a.id).root, null);
});

test('removing from a nested split keeps the proportions of the rest', () => {
	const [a, b, c] = [widget('x'), widget('x'), widget('x')] as const;
	let view = addMain(emptyView(), a);
	view = addMain(view, b, { id: a.id, side: 'bottom' });
	view = addMain(view, c, { id: b.id, side: 'right' });
	view = removeWidget(view, c.id);
	assert.deepEqual(ids(view), [a.id, b.id]);
	const sizes = view.root?.kind === 'split' ? view.root.sizes : [];
	assert.ok(Math.abs(sizes.reduce((x, y) => x + y, 0) - 100) < 1e-9);
});

test('moving between strip and panes', () => {
	const a = widget('x');
	const s = widget('summary', 'd');
	let view = addToStrip(addMain(emptyView(), a), s);
	view = moveToMain(view, s.id, { id: a.id, side: 'top' });
	assert.deepEqual(ids(view), [s.id, a.id]);
	assert.equal(view.strip.length, 0);
	view = moveToStrip(view, a.id, 0);
	assert.deepEqual(view.strip.map((w) => w.id), [a.id]);
	assert.deepEqual(ids(view), [s.id]);
});

test('reordering inside the strip', () => {
	const [a, b, c] = [widget('s'), widget('s'), widget('s')] as const;
	let view = emptyView();
	for (const w of [a, b, c]) view = addToStrip(view, w);
	assert.deepEqual(moveToStrip(view, a.id, 3).strip.map((w) => w.id), [b.id, c.id, a.id]);
	assert.deepEqual(moveToStrip(view, c.id, 0).strip.map((w) => w.id), [c.id, a.id, b.id]);
});

test('swap and sizes; the argument is never changed', () => {
	const a = widget('x');
	const b = widget('x');
	const view = addMain(addMain(emptyView(), a), b);
	const before = JSON.stringify(view);
	const swapped = swapMains(view, a.id, b.id);
	assert.deepEqual(ids(swapped), [b.id, a.id]);
	const resized = setSizes(view, view.root!.id, [30, 70]);
	assert.deepEqual(resized.root?.kind === 'split' && resized.root.sizes, [30, 70]);
	assert.equal(JSON.stringify(view), before);
});

test('parseView accepts what it wrote and refuses nonsense and newer formats', () => {
	const view = addToStrip(addMain(emptyView('T'), widget('oscilloscope', 'o')), widget('summary', 'p'));
	assert.deepEqual(parseView(JSON.parse(JSON.stringify(view))), view);
	assert.equal(typeof parseView('x'), 'string');
	assert.match(String(parseView({ version: 99 })), /newer/);
	assert.equal(typeof parseView({ root: { kind: 'split', id: 'a', dir: 'diagonal', children: [] } }), 'string');
});

test('parseView repairs sizes that do not fit', () => {
	const a = widget('x');
	const b = widget('x');
	const view = addMain(addMain(emptyView(), a), b);
	const broken = JSON.parse(JSON.stringify(view));
	broken.root.sizes = [10];
	const fixed = parseView(broken);
	assert.ok(typeof fixed !== 'string');
	assert.deepEqual(fixed.root?.kind === 'split' && fixed.root.sizes, [50, 50]);
});

test('the default view shows oscilloscopes as panes and other devices in the strip', () => {
	const view = defaultView({ scope: { schema: { widget: 'oscilloscope' } }, pressure: { schema: {} }, other: { schema: null } });
	assert.deepEqual(mains(view.root).map((m) => m.widget.device), ['scope']);
	assert.deepEqual(view.strip.map((w) => w.device), ['other', 'pressure']);
});
