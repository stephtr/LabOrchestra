/**
 * The layout of a view: a tree of resizable splits whose leaves are "main" widgets (they fill their pane), and a strip of compact widgets
 * of fixed height (S or M) and variable width along the bottom. Plain data, stored by the server as views/<id>.json; the functions here
 * never change their argument.
 */

export const VIEW_VERSION = 1;

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
export type Node = Split | Main;
export type View = { version: number; title: string; order?: number; root: Node | null; strip: WidgetInstance[] };

/** Where a dropped main widget goes relative to an existing one. */
export type Side = 'left' | 'right' | 'top' | 'bottom';

let counter = 0;
export function newId(prefix = 'n'): string {
	counter += 1;
	return `${prefix}${Date.now().toString(36)}${counter.toString(36)}${Math.random().toString(36).slice(2, 5)}`;
}

export const emptyView = (title = 'View'): View => ({ version: VIEW_VERSION, title, root: null, strip: [] });

export function widget(type: string, device?: string, props?: Record<string, unknown>): WidgetInstance {
	return { id: newId('w'), type, ...(device ? { device } : {}), ...(props ? { props } : {}) };
}

const main = (w: WidgetInstance): Main => ({ id: newId(), kind: 'main', widget: w });

function equalSizes(count: number): number[] {
	return Array.from({ length: count }, () => 100 / count);
}

/** Collapses what editing leaves behind: a split with one child is its child, a split inside a split of the same direction is merged. */
function normalize(node: Node | null): Node | null {
	if (!node || node.kind === 'main') return node;
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
	return node.kind === 'main' ? [node] : node.children.flatMap(mains);
}

/** Every widget of the view, main ones first. */
export function allWidgets(view: View): WidgetInstance[] {
	return [...mains(view.root).map((m) => m.widget), ...view.strip];
}

export function findWidget(view: View, id: string): WidgetInstance | undefined {
	return allWidgets(view).find((w) => w.id === id);
}

/** Adds a main widget next to another one (or as the first one). Without a target it goes below everything. */
export function addMain(view: View, w: WidgetInstance, target?: { id: string; side: Side }): View {
	const added = main(w);
	if (!view.root) return { ...view, root: added };
	if (!target) {
		return { ...view, root: normalize({ id: newId(), kind: 'split', dir: 'column', children: [view.root, added], sizes: [50, 50] }) };
	}
	const dir: Direction = target.side === 'left' || target.side === 'right' ? 'row' : 'column';
	const before = target.side === 'left' || target.side === 'top';
	const root = mapTree(view.root, (node) =>
		node.kind === 'main' && node.widget.id === target.id
			? { id: newId(), kind: 'split', dir, children: before ? [added, node] : [node, added], sizes: [50, 50] }
			: node,
	);
	return { ...view, root: normalize(root) };
}

export function addToStrip(view: View, w: WidgetInstance, index = view.strip.length): View {
	const strip = [...view.strip];
	strip.splice(Math.min(Math.max(index, 0), strip.length), 0, w);
	return { ...view, strip };
}

export function removeWidget(view: View, id: string): View {
	const root = view.root ? mapTree(view.root, (node) => (node.kind === 'main' && node.widget.id === id ? null : node)) : null;
	return { ...view, root: normalize(root), strip: view.strip.filter((w) => w.id !== id) };
}

/** Moves a widget (from the strip or from a pane) next to a main widget, which makes it a main widget. */
export function moveToMain(view: View, id: string, target: { id: string; side: Side }): View {
	if (id === target.id) return view;
	const w = findWidget(view, id);
	if (!w) return view;
	return addMain(removeWidget(view, id), w, target);
}

/** Moves a widget into the strip at an index (it becomes a compact widget). */
export function moveToStrip(view: View, id: string, index: number): View {
	const w = findWidget(view, id);
	if (!w) return view;
	const before = view.strip.findIndex((s) => s.id === id);
	const without = removeWidget(view, id);
	return addToStrip(without, w, before >= 0 && before < index ? index - 1 : index);
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
	const root = view.root ? mapTree(view.root, (node) => (node.kind === 'main' ? { ...node, widget: change(node.widget) } : node)) : null;
	return { ...view, root, strip: view.strip.map(change) };
}

export function equal(a: View, b: View): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

/** Reads a stored view; anything unusable gives an error text (the view is then not shown, the file stays untouched). */
export function parseView(raw: unknown): View | string {
	if (!raw || typeof raw !== 'object') return 'not an object';
	const v = raw as Partial<View>;
	if ((v.version ?? 1) > VIEW_VERSION) return `format version ${v.version} is newer than this client knows (${VIEW_VERSION})`;
	const checkWidget = (w: unknown): w is WidgetInstance => !!w && typeof w === 'object' && typeof (w as WidgetInstance).id === 'string' && typeof (w as WidgetInstance).type === 'string';
	const checkNode = (n: unknown): n is Node => {
		if (!n || typeof n !== 'object') return false;
		const node = n as Node;
		if (node.kind === 'main') return typeof node.id === 'string' && checkWidget(node.widget);
		if (node.kind === 'split')
			return typeof node.id === 'string' && (node.dir === 'row' || node.dir === 'column') && Array.isArray(node.children) && node.children.every(checkNode);
		return false;
	};
	if (v.root != null && !checkNode(v.root)) return 'the layout is not valid';
	if (v.strip != null && !(Array.isArray(v.strip) && v.strip.every(checkWidget))) return 'the strip is not valid';
	const root = normalize((v.root as Node | null | undefined) ?? null);
	// sizes that do not fit the children are reset to equal ones
	const fix = (n: Node): Node =>
		n.kind === 'main' ? n : { ...n, children: n.children.map(fix), sizes: Array.isArray(n.sizes) && n.sizes.length === n.children.length ? n.sizes : equalSizes(n.children.length) };
	return { version: VIEW_VERSION, title: typeof v.title === 'string' ? v.title : 'View', ...(typeof v.order === 'number' ? { order: v.order } : {}), root: root ? fix(root) : null, strip: v.strip ?? [] };
}

/** What a client shows while the server has no view yet: oscilloscopes as panes, everything else as compact summaries. */
export function defaultView(devices: Record<string, { schema?: { widget?: string | null } | null }>): View {
	let view = emptyView('Dashboard');
	for (const id of Object.keys(devices).sort()) {
		if (devices[id]?.schema?.widget === 'oscilloscope') view = addMain(view, widget('oscilloscope', id));
		else view = addToStrip(view, widget('summary', id));
	}
	return view;
}
