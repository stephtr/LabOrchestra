import assert from 'node:assert/strict';
import { test } from 'node:test';
import { placeInDock, reorderIds, addMain, addToArea, allWidgets, areas, defaultView, emptyView, mains, parseView, placeAtEdge, placeInArea, placeInMain, removeWidget, setSizes, swapMains, widget } from './layout.ts';

const inAreas = (v: ReturnType<typeof emptyView>) => areas(v.root).flatMap((a) => a.widgets.map((w) => w.id));

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

test('moving between areas and panes', () => {
	const a = widget('x');
	const s = widget('summary', 'd');
	let view = addToArea(addMain(emptyView(), a), s);
	assert.deepEqual(inAreas(view), [s.id]);
	assert.deepEqual(ids(view), [a.id]); // the area is below the pane, not a pane itself
	view = placeInMain(view, s, { id: a.id, side: 'top' });
	assert.deepEqual(ids(view), [s.id, a.id]);
	assert.equal(areas(view.root).length, 0); // an area without widgets is gone
	view = placeInArea(view, a, undefined, 0);
	assert.deepEqual(inAreas(view), [a.id]);
	assert.deepEqual(ids(view), [s.id]);
});

test('the first compact widget makes an area, the next ones join the last area; reordering inside it', () => {
	const [a, b, c] = [widget('s'), widget('s'), widget('s')] as const;
	let view = emptyView();
	for (const w of [a, b, c]) view = addToArea(view, w);
	assert.equal(areas(view.root).length, 1);
	const area = areas(view.root)[0]!;
	assert.deepEqual(placeInArea(view, a, area.id, 3).root && inAreas(placeInArea(view, a, area.id, 3)), [b.id, c.id, a.id]);
	assert.deepEqual(inAreas(placeInArea(view, c, area.id, 0)), [c.id, a.id, b.id]);
});

test('a compact widget dropped beside a pane or at an edge gets an area of its own, next to an area it can make a second one', () => {
	const [p, s, t] = [widget('x'), widget('s'), widget('s')] as const;
	let view = addMain(emptyView(), p);
	view = placeInMain(view, s, { id: p.id, side: 'right' }, true);
	assert.deepEqual([ids(view), inAreas(view)], [[p.id], [s.id]]);
	const first = areas(view.root)[0]!;
	view = placeInMain(view, t, { id: first.id, side: 'bottom' }, true); // beside the area: a second area
	assert.equal(areas(view.root).length, 2);
	view = placeAtEdge(view, widget('s'), 'bottom', true);
	assert.equal(areas(view.root).length, 3);
	assert.equal(allWidgets(view).length, 4);
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
	const view = addToArea(addMain(emptyView('T'), widget('oscilloscope', 'o')), widget('summary', 'p'));
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

test('the default view shows oscilloscopes as panes and other devices in an area', () => {
	const view = defaultView({ scope: { schema: { widget: 'oscilloscope' } }, pressure: { schema: {} }, other: { schema: null } });
	assert.deepEqual(mains(view.root).map((m) => m.widget.device), ['scope']);
	assert.deepEqual(areas(view.root)[0]!.widgets.map((w) => w.device), ['other', 'pressure']);
});

test('a new pane goes below the panes but above the area along the bottom', () => {
	const [a, b, c] = [widget('x'), widget('x'), widget('s')] as const;
	let view = addToArea(addMain(emptyView(), a), c);
	view = addMain(view, b);
	assert.deepEqual([ids(view), inAreas(view)], [[a.id, b.id], [c.id]]);
	assert.equal(view.root?.kind === 'split' && view.root.children.at(-1)?.kind, 'area');
	assert.ok(Math.abs((view.root?.kind === 'split' ? view.root.sizes : []).reduce((x, y) => x + y, 0) - 100) < 1e-9);
	assert.deepEqual(ids(addMain(addToArea(emptyView(), c), a)), [a.id]); // only an area so far
});

test('a version 1 view (a strip) becomes an area along the bottom', () => {
	const pane = { id: 'n1', kind: 'main', widget: { id: 'w1', type: 'oscilloscope', device: 'o' } };
	const old = { version: 1, title: 'Old', root: pane, strip: [{ id: 'w2', type: 'summary', device: 'p' }] };
	const view = parseView(old);
	assert.ok(typeof view !== 'string');
	assert.equal(view.version, 2);
	assert.deepEqual([ids(view), inAreas(view)], [['w1'], ['w2']]);
	assert.equal(view.root?.kind === 'split' && view.root.dir, 'column');
	const onlyStrip = parseView({ version: 1, title: 'S', root: null, strip: [{ id: 'w3', type: 'summary' }] });
	assert.ok(typeof onlyStrip !== 'string' && onlyStrip.root?.kind === 'area');
	assert.ok(typeof parseView({ version: 1, title: 'E', root: null, strip: [] }) !== 'string');
	assert.ok(typeof parseView({ version: 2, title: 'Bad', root: { id: 'a', kind: 'area', widgets: [1] } }) === 'string');
});

test('a widget that is not in the view yet is added where it is dropped', () => {
	const a = widget('x');
	const n = widget('x');
	assert.deepEqual(ids(placeInMain(addMain(emptyView(), a), n, { id: a.id, side: 'left' })), [n.id, a.id]);
	assert.deepEqual(ids(placeInMain(emptyView(), n)), [n.id]); // an empty view
	const strip = addToArea(addToArea(emptyView(), widget('s')), widget('s'));
	const area = areas(strip.root)[0]!;
	assert.equal(inAreas(placeInArea(strip, n, area.id, 1))[1], n.id);
	assert.equal(inAreas(placeInArea(strip, n, area.id, 1)).length, 3);
});

test('a widget placed at an edge spans the whole layout', () => {
	const [a, b, c] = [widget('x'), widget('x'), widget('x')] as const;
	const stacked = addMain(addMain(emptyView(), a), b); // A over B
	const right = placeAtEdge(stacked, c, 'right');
	assert.equal(right.root?.kind === 'split' && right.root.dir, 'row'); // the stack next to one tall pane
	assert.deepEqual(ids(right), [a.id, b.id, c.id]);
	const [stack, tall] = right.root?.kind === 'split' ? right.root.children : [];
	assert.equal(stack?.kind === 'split' && stack.dir, 'column');
	assert.equal(tall?.kind === 'main' && tall.widget.id, c.id);
	assert.deepEqual(right.root?.kind === 'split' && right.root.sizes, [70, 30]);
	// the same direction as the layout adds a row instead of nesting
	assert.equal(placeAtEdge(stacked, c, 'bottom').root?.kind === 'split' && (placeAtEdge(stacked, c, 'bottom').root as { children: unknown[] }).children.length, 3);
	assert.deepEqual(ids(placeAtEdge(stacked, c, 'top')), [c.id, a.id, b.id]);
	// an empty view, and a widget that is in the view already
	assert.deepEqual(ids(placeAtEdge(emptyView(), c, 'left')), [c.id]);
	assert.deepEqual(ids(placeAtEdge(stacked, a, 'bottom')), [b.id, a.id]);
});

test('views move next to another one, before or after it', () => {
	const ids = ['a', 'b', 'c', 'd'];
	assert.deepEqual(reorderIds(ids, 'd', 'b', false), ['a', 'd', 'b', 'c']);
	assert.deepEqual(reorderIds(ids, 'a', 'c', true), ['b', 'c', 'a', 'd']);
	assert.deepEqual(reorderIds(ids, 'b', 'b', true), ids);
	assert.deepEqual(reorderIds(ids, 'x', 'b', true), ids);
});

test('small widgets sit in the dock of a pane, go with it when swapped, and are removed with it', () => {
	const [a, b, s1, s2] = [widget('oscilloscope', 'a'), widget('oscilloscope', 'b'), widget('pressure', 'p'), widget('pressure', 'q')] as const;
	let view = addMain(addMain(emptyView(), a), b);
	view = placeInDock(view, s1, a.id, 0);
	view = placeInDock(view, s2, a.id, 0);
	const dockOf = (v: ReturnType<typeof emptyView>, id: string) => mains(v.root).find((m) => m.widget.id === id)?.dock?.map((w) => w.id);
	assert.deepEqual(dockOf(view, a.id), [s2.id, s1.id]);
	assert.deepEqual(allWidgets(view).map((w) => w.id), [a.id, s2.id, s1.id, b.id]);
	view = placeInDock(view, s2, a.id, 2); // moved inside the dock
	assert.deepEqual(dockOf(view, a.id), [s1.id, s2.id]);
	view = placeInDock(view, s1, b.id, 0); // moved to another pane
	assert.deepEqual([dockOf(view, a.id), dockOf(view, b.id)], [[s2.id], [s1.id]]);
	const swapped = swapMains(view, a.id, b.id);
	assert.deepEqual(mains(swapped.root).map((m) => [m.widget.id, m.dock?.map((w) => w.id)]), [[b.id, [s1.id]], [a.id, [s2.id]]]); // each dock stays with its widget
	assert.equal(removeWidget(view, s2.id).root && mains(removeWidget(view, s2.id).root).every((m) => !('dock' in m && m.widget.id === a.id)), true); // an empty dock is not kept
	assert.deepEqual(allWidgets(removeWidget(view, a.id)).map((w) => w.id), [b.id, s1.id]); // with its pane
	assert.ok(typeof parseView(JSON.parse(JSON.stringify(view))) !== 'string');
	assert.equal(typeof parseView({ version: 2, root: { id: 'n', kind: 'main', widget: { id: 'w', type: 'x' }, dock: [1] } }), 'string');
});
