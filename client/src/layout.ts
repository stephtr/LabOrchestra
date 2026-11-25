/**
 * The layout of a view: a tree of resizable splits. Its leaves are "main" widgets (they fill their pane) and "areas": a wrapping flow of
 * compact widgets of fixed height (S or M) that fit the width of the area. Plain data, stored by the server as views/<id>.json; the functions
 * here never change their argument. (Version 1 had one strip of compact widgets along the bottom instead of areas; it is converted on reading.)
 */

export const VIEW_VERSION = 2;

export type WidgetInstance = {
	id: string;
	/** The kind of widget ("oscilloscope", "summary", or one shipped by a device package). */
	type: string;
	device?: string;
	/** Settings of this instance, checked against the widget's props schema. */
	props?: Record<string, unknown>;
};
export type Direction = 'row' | 'column';
export type Split = { id: string; kind: 'split'; dir: Direction; children: Node[]; sizes: number[] };
export type Main = { id: string; kind: 'main'; widget: WidgetInstance };
/** Compact widgets that wrap like text. `fixed`: the user has dragged its size, so it no longer fits itself to its content. */
export type Area = { id: string; kind: 'area'; widgets: WidgetInstance[]; fixed?: boolean };
export type Node = Split | Main | Area;
export type View = { version: number; title: string; order?: number; root: Node | null };

/** Where a dropped main widget goes relative to an existing one. */
export type Side = 'left' | 'right' | 'top' | 'bottom';

let counter = 0;
export function newId(prefix = 'n'): string {
	counter += 1;
	return `${prefix}${Date.now().toString(36)}${counter.toString(36)}${Math.random().toString(36).slice(2, 5)}`;
}

export const emptyView = (title = 'View'): View => ({ version: VIEW_VERSION, title, root: null });

export function widget(type: string, device?: string, props?: Record<string, unknown>): WidgetInstance {
	return { id: newId('w'), type, ...(device ? { device } : {}), ...(props ? { props } : {}) };
}

const main = (w: WidgetInstance): Main => ({ id: newId(), kind: 'main', widget: w });
const area = (widgets: WidgetInstance[]): Area => ({ id: newId('a'), kind: 'area', widgets });
/** A compact widget beside a pane goes into an area of its own; a large one is a pane. */
const leaf = (w: WidgetInstance, compact?: boolean): Node => (compact ? area([w]) : main(w));

function equalSizes(count: number): number[] {
	return Array.from({ length: count }, () => 100 / count);
}

/** Collapses what editing leaves behind: a split with one child is its child, a split inside a split of the same direction is merged. */
function normalize(node: Node | null): Node | null {
	if (!node) return node;
	if (node.kind === 'area') return node.widgets.length === 0 ? null : node;
	if (node.kind === 'main') return node;
	const children: Node[] = [];
	const sizes: number[] = [];
	const given = Array.isArray(node.sizes) && node.sizes.length === node.children.length ? node.sizes : equalSizes(node.children.length);
	node.children.forEach((child, i) => {
		const normalized = normalize(child);
		if (!normalized) return;
		const share = given[i]!;
		if (normalized.kind === 'split' && normalized.dir === node.dir) {
			normalized.children.forEach((grandchild, j) => {
				children.push(grandchild);
				sizes.push((share * (normalized.sizes[j] ?? 0)) / 100);
			});
		} else {
			children.push(normalized);
			sizes.push(share);
		}
	});
	if (children.length === 0) return null;
	if (children.length === 1) return children[0]!;
	const total = sizes.reduce((a, b) => a + b, 0) || 1;
	return { ...node, children, sizes: sizes.map((s) => (s * 100) / total) };
}

function mapTree(node: Node, change: (node: Node) => Node | null): Node | null {
	const replaced = change(node);
	if (replaced !== node) return replaced;
	if (node.kind === 'split') return { ...node, children: node.children.map((c) => mapTree(c, change)).filter((c): c is Node => c !== null) };
	return node;
}

export function mains(node: Node | null): Main[] {
	if (!node) return [];
	if (node.kind === 'area') return [];
	return node.kind === 'main' ? [node] : node.children.flatMap(mains);
}

/** The areas of the layout, in reading order. */
export function areas(node: Node | null): Area[] {
	if (!node) return [];
	if (node.kind === 'area') return [node];
	return node.kind === 'main' ? [] : node.children.flatMap(areas);
}

/** Every widget of the view in reading order (panes and areas as they come). */
export function allWidgets(view: View): WidgetInstance[] {
	const walk = (n: Node | null): WidgetInstance[] => (!n ? [] : n.kind === 'main' ? [n.widget] : n.kind === 'area' ? n.widgets : n.children.flatMap(walk));
	return walk(view.root);
}

export function findWidget(view: View, id: string): WidgetInstance | undefined {
	return allWidgets(view).find((w) => w.id === id);
}

/** Adds a pane next to another pane or area (or as the first one). Without a target it goes below everything. `compact`: an area instead of a pane. */
export function addMain(view: View, w: WidgetInstance, target?: { id: string; side: Side }, compact?: boolean): View {
	const added = leaf(w, compact);
	if (!view.root) return { ...view, root: added };
	if (!target) {
		const root = view.root;
		// below the panes but above the area along the bottom, if there is one
		if (root.kind === 'area') return { ...view, root: { id: newId(), kind: 'split', dir: 'column', children: [added, root], sizes: [80, 20] } };
		if (root.kind === 'split' && root.dir === 'column' && root.children.at(-1)?.kind === 'area') {
			const n = root.children.length + 1;
			const children = [...root.children.slice(0, -1), added, root.children.at(-1)!];
			const sizes = [...root.sizes.slice(0, -1).map((s) => (s * (n - 1)) / n), 100 / n, root.sizes.at(-1)! * ((n - 1) / n)];
			return { ...view, root: normalize({ ...root, children, sizes }) };
		}
		return { ...view, root: normalize({ id: newId(), kind: 'split', dir: 'column', children: [root, added], sizes: [50, 50] }) };
	}
	const dir: Direction = target.side === 'left' || target.side === 'right' ? 'row' : 'column';
	const before = target.side === 'left' || target.side === 'top';
	const root = mapTree(view.root, (node) =>
		(node.kind === 'main' && node.widget.id === target.id) || (node.kind === 'area' && node.id === target.id)
			? { id: newId(), kind: 'split', dir, children: before ? [added, node] : [node, added], sizes: [50, 50] }
			: node,
	);
	return { ...view, root: normalize(root) };
}

/** Adds a compact widget to an area: the given one at an index, else the last area of the layout, else a new area along the bottom. */
export function addToArea(view: View, w: WidgetInstance, areaId?: string, index?: number): View {
	const target = (areaId ? areas(view.root).find((a) => a.id === areaId) : undefined) ?? areas(view.root).at(-1);
	if (!target) return addMain(view, w, undefined, true);
	const root = mapTree(view.root!, (node) => {
		if (node.kind !== 'area' || node.id !== target.id) return node;
		const widgets = [...node.widgets];
		widgets.splice(Math.min(Math.max(index ?? widgets.length, 0), widgets.length), 0, w);
		return { ...node, widgets };
	});
	return { ...view, root };
}

export function removeWidget(view: View, id: string): View {
	const root = view.root
		? mapTree(view.root, (node) =>
				node.kind === 'main' && node.widget.id === id ? null : node.kind === 'area' && node.widgets.some((w) => w.id === id) ? { ...node, widgets: node.widgets.filter((w) => w.id !== id) } : node,
			)
		: null;
	return { ...view, root: normalize(root) };
}

/** Puts a widget next to a main widget (without a target: below everything), which makes it a main widget. One that is in the view already is moved. */
export function placeInMain(view: View, w: WidgetInstance, target?: { id: string; side: Side }, compact?: boolean): View {
	if (w.id === target?.id) return view;
	// a target that is an area which only held this widget is gone after removing it: then the widget stays where it was
	const rest = removeWidget(view, w.id);
	if (target && !findNode(rest.root, target.id)) return view;
	return addMain(rest, w, target, compact);
}

function findNode(node: Node | null, id: string): boolean {
	if (!node) return false;
	if (node.kind === 'main') return node.widget.id === id || node.id === id;
	if (node.kind === 'area') return node.id === id;
	return node.id === id || node.children.some((c) => findNode(c, id));
}

/** Puts a widget along a whole side of the layout, next to everything (not just next to one pane): with A over B, "right" gives A | C over B | C
 *  with C as one tall pane. One that is in the view already is moved. */
export function placeAtEdge(view: View, w: WidgetInstance, side: Side, compact?: boolean): View {
	const rest = removeWidget(view, w.id);
	if (!rest.root) return { ...rest, root: leaf(w, compact) };
	const dir: Direction = side === 'left' || side === 'right' ? 'row' : 'column';
	const added = leaf(w, compact);
	const first = side === 'left' || side === 'top';
	return { ...rest, root: normalize({ id: newId(), kind: 'split', dir, children: first ? [added, rest.root] : [rest.root, added], sizes: first ? [30, 70] : [70, 30] }) };
}

/** Puts a compact widget into an area at an index (the last area when none is named; one that is in the view already is moved). */
export function placeInArea(view: View, w: WidgetInstance, areaId: string | undefined, index: number): View {
	const inArea = areas(view.root).find((a) => a.id === areaId);
	const before = inArea ? inArea.widgets.findIndex((x) => x.id === w.id) : -1;
	return addToArea(removeWidget(view, w.id), w, areaId, before >= 0 && before < index ? index - 1 : index);
}

/** Swaps two main widgets. */
export function swapMains(view: View, a: string, b: string): View {
	if (!view.root || a === b) return view;
	const wa = findWidget(view, a);
	const wb = findWidget(view, b);
	if (!wa || !wb) return view;
	const root = mapTree(view.root, (node) =>
		node.kind === 'main' ? (node.widget.id === a ? { ...node, widget: wb } : node.widget.id === b ? { ...node, widget: wa } : node) : node,
	);
	return { ...view, root };
}

export function setSizes(view: View, splitId: string, sizes: number[]): View {
	if (!view.root) return view;
	const root = mapTree(view.root, (node) => (node.kind === 'split' && node.id === splitId && sizes.length === node.children.length ? { ...node, sizes } : node));
	return { ...view, root };
}

export function setProps(view: View, id: string, props: Record<string, unknown>): View {
	const change = (w: WidgetInstance) => (w.id === id ? { ...w, props } : w);
	const root = view.root ? mapTree(view.root, (node) => (node.kind === 'main' ? { ...node, widget: change(node.widget) } : node.kind === 'area' ? { ...node, widgets: node.widgets.map(change) } : node)) : null;
	return { ...view, root };
}

/** The user dragged the size of an area: it keeps that size from now on instead of fitting its content. */
export function fixArea(view: View, areaId: string): View {
	if (!view.root) return view;
	return { ...view, root: mapTree(view.root, (node) => (node.kind === 'area' && node.id === areaId && !node.fixed ? { ...node, fixed: true } : node)) };
}

export function equal(a: View, b: View): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

/** Reads a stored view; anything unusable gives an error text (the view is then not shown, the file stays untouched). Version 1 (a strip) is converted. */
export function parseView(raw: unknown): View | string {
	if (!raw || typeof raw !== 'object') return 'not an object';
	const v = raw as Partial<View> & { strip?: unknown };
	if ((v.version ?? 1) > VIEW_VERSION) return `format version ${v.version} is newer than this client knows (${VIEW_VERSION})`;
	const checkWidget = (w: unknown): w is WidgetInstance => !!w && typeof w === 'object' && typeof (w as WidgetInstance).id === 'string' && typeof (w as WidgetInstance).type === 'string';
	const checkNode = (n: unknown): n is Node => {
		if (!n || typeof n !== 'object') return false;
		const node = n as Node;
		if (node.kind === 'main') return typeof node.id === 'string' && checkWidget(node.widget);
		if (node.kind === 'area') return typeof node.id === 'string' && Array.isArray(node.widgets) && node.widgets.every(checkWidget);
		if (node.kind === 'split')
			return typeof node.id === 'string' && (node.dir === 'row' || node.dir === 'column') && Array.isArray(node.children) && node.children.every(checkNode);
		return false;
	};
	if (v.root != null && !checkNode(v.root)) return 'the layout is not valid';
	if (v.strip != null && !(Array.isArray(v.strip) && v.strip.every(checkWidget))) return 'the strip is not valid';
	let root = (v.root as Node | null | undefined) ?? null;
	const strip = (v.strip as WidgetInstance[] | undefined) ?? [];
	if (strip.length > 0) {
		// version 1: the strip becomes an area along the bottom (it keeps the fit to its content)
		const along = { id: 'a_strip', kind: 'area' as const, widgets: strip };
		root = root ? { id: newId(), kind: 'split', dir: 'column', children: [root, along], sizes: [80, 20] } : along;
	}
	root = normalize(root);
	// sizes that do not fit the children are reset to equal ones
	const fix = (n: Node): Node =>
		n.kind !== 'split' ? n : { ...n, children: n.children.map(fix), sizes: Array.isArray(n.sizes) && n.sizes.length === n.children.length ? n.sizes : equalSizes(n.children.length) };
	return { version: VIEW_VERSION, title: typeof v.title === 'string' ? v.title : 'View', ...(typeof v.order === 'number' ? { order: v.order } : {}), root: root ? fix(root) : null };
}

/** What a client shows while the server has no view yet: oscilloscopes as panes, every other device as a compact summary in an area (background services are left out). */
export function defaultView(devices: Record<string, { schema?: { widget?: string | null; kind?: string } | null }>): View {
	let view = emptyView('Dashboard');
	for (const id of Object.keys(devices).sort()) {
		if (devices[id]?.schema?.kind === 'service') continue; // a background task is not an instrument: no tile unless asked for
		if (devices[id]?.schema?.widget === 'oscilloscope') view = addMain(view, widget('oscilloscope', id));
		else view = addToArea(view, widget('summary', id));
	}
	return view;
}
