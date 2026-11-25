import { createContext, ReactNode, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Group, Panel, Separator, useGroupRef } from 'react-resizable-panels';
import {
	addMain,
	addToArea,
	areas,
	fixArea,
	defaultView,
	emptyView,
	equal,
	mains,
	Node,
	parseView,
	placeAtEdge,
	placeInMain,
	placeInArea,
	reorderIds,
	removeWidget,
	setProps,
	Side,
	setSizes,
	swapMains,
	View,
	widget,
	WidgetInstance,
} from './layout';
import { CustomForm } from './generic';
import { Header } from './Header';
import { Button, Dialog, DialogBody, DialogFooter, FormRow, Icon, IconButton, Input, Select } from './ui';
import { NewWidgetDialog } from './NewWidgetDialog';
import { WidgetSettingsDialog } from './WidgetSettingsDialog';
import { navigate, navigateSliding, usePath } from './router';
import { DeviceInfo, deleteView, isService, saveView, useStore } from './store';
import { DeviceCard } from './DeviceCard';
import { OscilloscopeWidget } from './OscilloscopeWidget';
import { COMPACT_HEIGHT, runtimeWidgetsReady, useWidgetDefs, widgetDef, WidgetDef } from './widgets';

const AUTO_ID = 'dashboard';

/** Editing ends by itself after this long without any activity in the page (so that a forgotten edit mode does not stay open on a lab screen).
 *  A client can change it: localStorage "laborchestra.editIdleMs" (the e2e test does). */
const EDIT_IDLE_MS = 3 * 60 * 1000;
function editIdleMs(): number {
	try {
		const set = Number(localStorage.getItem('laborchestra.editIdleMs'));
		return set > 0 ? set : EDIT_IDLE_MS;
	} catch {
		return EDIT_IDLE_MS;
	}
}
const NO_DEVICE: DeviceInfo = { status: 'ready', error: null, schema: null, state: null, revision: 0 };

type DropTarget = { pane: string; side: Side | 'swap' } | { area: string; index: number } | { edge: Side } | null;
type Chosen = { type: string; device: string; /** Where it was dropped (without: at the end). */ place?: Place };
type Place = (view: View, w: WidgetInstance) => View;
type Ctx = {
	editing: boolean;
	devices: Record<string, DeviceInfo>;
	/** The widget being dragged: one of the view, or a new one from the picker (without a device: it is asked for after the drop). */
	dragging: WidgetInstance | null;
	setDragging: (w: WidgetInstance | null) => void;
	drop: DropTarget;
	setDrop: (drop: DropTarget) => void;
	apply: (change: (view: View) => View) => void;
	/** Puts the dragged widget into the view; `place` says where. */
	dropped: (place: Place) => void;
	view: View;
	/** Opens the settings dialog of a widget instance. */
	configure: (instance: WidgetInstance) => void;
};
const DashboardContext = createContext<Ctx>(null as never);

/** Shows a widget; a missing device or an unknown kind gives a placeholder instead of an error. */
function WidgetView({ instance }: { instance: WidgetInstance }) {
	const { devices } = useContext(DashboardContext);
	useWidgetDefs(); // a widget of the workspace may be built or changed
	const def = widgetDef(instance.type);
	const info = instance.device ? devices[instance.device] : undefined;
	if (def?.needsDevice === false) return <def.component id={instance.id} device="" info={NO_DEVICE} props={instance.props ?? {}} />;
	let problem: string | null = null;
	if (!def) problem = /^(ws|pkg):/.test(instance.type) && !runtimeWidgetsReady() ? 'Loading the widgets…' : `Unknown widget "${instance.type}".`;
	else if (!instance.device) problem = 'This widget needs a device.';
	else if (!info) problem = `Device "${instance.device}" does not exist (any more).`;
	else if (!def.accepts(info)) problem = `"${instance.device}" cannot be shown by the ${def.title} widget.`;
	if (problem || !def || !info || !instance.device)
		return (
			<div data-testid={`placeholder-${instance.id}`} className="flex h-full items-center justify-center rounded-lg border border-dashed border-line p-2 text-center text-xs text-muted">
				{problem}
			</div>
		);
	const Component = def.component;
	return <Component id={instance.id} device={instance.device} info={info} props={instance.props ?? {}} />;
}

/** A compact widget (S or M) rather than one that fills a pane: beside a pane or at an edge it gets an area of its own. */
const isCompact = (w: WidgetInstance) => (widgetDef(w.type)?.size ?? 'main') !== 'main';

function dragProps(w: () => WidgetInstance, ctx: Ctx, image?: (from: HTMLElement) => Element | null) {
	return ctx.editing
		? {
				draggable: true,
				onDragStart: (e: React.DragEvent<HTMLElement>) => {
					const dragged = w();
					e.dataTransfer.setData('application/x-laborchestra-widget', dragged.id);
					e.dataTransfer.effectAllowed = 'move';
					const picture = image?.(e.currentTarget);
					if (picture) e.dataTransfer.setDragImage(picture, 20, 20);
					ctx.setDragging(dragged);
				},
				onDragEnd: () => {
					ctx.setDragging(null);
					ctx.setDrop(null);
				},
			}
		: {};
}

function sideAt(e: React.DragEvent, element: HTMLElement, canSwap: boolean): Side | 'swap' {
	const box = element.getBoundingClientRect();
	const x = (e.clientX - box.left) / box.width;
	const y = (e.clientY - box.top) / box.height;
	const edge = 0.25;
	const toEdge = Math.min(x, 1 - x, y, 1 - y);
	if (canSwap && toEdge > edge) return 'swap';
	if (toEdge === x) return 'left';
	if (toEdge === 1 - x) return 'right';
	return toEdge === y ? 'top' : 'bottom';
}

const HIGHLIGHT: Record<Side | 'swap', string> = {
	left: 'left-0 top-0 h-full w-1/2',
	right: 'right-0 top-0 h-full w-1/2',
	top: 'left-0 top-0 h-1/2 w-full',
	bottom: 'bottom-0 left-0 h-1/2 w-full',
	swap: 'left-0 top-0 h-full w-full',
};

function Pane({ instance }: { instance: WidgetInstance }) {
	const ctx = useContext(DashboardContext);
	const isMain = mains(ctx.view.root).some((m) => m.widget.id === ctx.dragging?.id); // two panes can be swapped
	const over = ctx.drop && 'pane' in ctx.drop && ctx.drop.pane === instance.id ? ctx.drop.side : null;
	return (
		<div data-testid={`pane-${instance.id}`} className="relative flex h-full flex-col">
			{ctx.editing && (
				<div className="z-10 flex flex-none items-center gap-1 border-b border-line bg-panel px-1 py-0.5 text-xs text-muted">
					<span {...dragProps(() => instance, ctx)} className="flex flex-1 cursor-grab select-none items-center gap-1 active:cursor-grabbing" title="Drag to move" data-testid={`handle-${instance.id}`}>
						<Icon name="grip" /> {widgetDef(instance.type)?.title ?? instance.type}{instance.device ? ` · ${instance.device}` : ''}
					</span>
					<IconButton small icon="settings" label="Widget settings" data-testid={`settings-${instance.id}`} onClick={() => ctx.configure(instance)} />
					<IconButton small icon="close" variant="danger" label="Remove widget" onClick={() => ctx.apply((v) => removeWidget(v, instance.id))} />
				</div>
			)}
			<div className="min-h-0 flex-1 overflow-auto">
				<WidgetView instance={instance} />
			</div>
			{ctx.editing && ctx.dragging && ctx.dragging.id !== instance.id && (
				<div
					className="absolute inset-0 z-20"
					data-dropzone
					data-testid={`drop-${instance.id}`}
					onDragOver={(e) => {
						e.preventDefault();
						const side = sideAt(e, e.currentTarget, isMain);
						if (!(ctx.drop && 'pane' in ctx.drop && ctx.drop.pane === instance.id && ctx.drop.side === side)) ctx.setDrop({ pane: instance.id, side });
					}}
					onDrop={(e) => {
						e.preventDefault();
						const side = sideAt(e, e.currentTarget, isMain);
						ctx.dropped((v, w) => (side === 'swap' ? swapMains(v, w.id, instance.id) : placeInMain(v, w, { id: instance.id, side }, isCompact(w))));
					}}
				>
					{over && <div className={`pointer-events-none absolute rounded-lg bg-accent/20 ring-2 ring-inset ring-accent ${HIGHLIGHT[over]}`} />}
				</div>
			)}
		</div>
	);
}

const RAIL: Record<Side, string> = {
	left: 'left-0 top-0 h-full w-10',
	right: 'right-0 top-0 h-full w-10',
	top: 'left-0 top-0 h-10 w-full',
	bottom: 'bottom-0 left-0 h-10 w-full',
};

/** While a widget is dragged, the four edges of the whole layout take drops: the widget then goes along that entire side (next to everything),
 *  not just next to the pane under the pointer. */
function EdgeRails() {
	const ctx = useContext(DashboardContext);
	const over = ctx.drop && 'edge' in ctx.drop ? ctx.drop.edge : null;
	return (
		<>
			{(['left', 'right', 'top', 'bottom'] as const).map((side) => (
				<div
					key={side}
					data-dropzone
					data-testid={`edge-${side}`}
					title={`Along the whole ${side} side`}
					className={`absolute z-30 ${RAIL[side]} ${over === side ? 'bg-accent/40' : 'bg-accent/10'}`}
					onDragOver={(e) => {
						e.preventDefault();
						if (over !== side) ctx.setDrop({ edge: side });
					}}
					onDrop={(e) => {
						e.preventDefault();
						ctx.dropped((v, w) => placeAtEdge(v, w, side, isCompact(w)));
					}}
				/>
			))}
			{over && <div className={`pointer-events-none absolute z-30 rounded-lg bg-accent/20 ring-2 ring-inset ring-accent ${HIGHLIGHT[over]}`} />}
		</>
	);
}

/** A movable boundary between two panels; `disabled`: nothing to move (an area beside it whose size is fixed by its widgets), so just a line. */
function Gutter({ direction, disabled }: { direction: 'row' | 'column'; disabled?: boolean }) {
	if (disabled) return <Separator disabled className={`flex-none bg-line ${direction === 'row' ? 'w-px' : 'h-px'}`} />;
	return (
		<Separator className={`group relative flex-none bg-line transition-colors hover:bg-accent data-[separator=active]:bg-accent ${direction === 'row' ? 'w-1 cursor-col-resize' : 'h-1 cursor-row-resize'}`}>
			<span className={`absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-faint group-hover:bg-white ${direction === 'row' ? 'h-8 w-0.5' : 'h-0.5 w-8'}`} />
		</Separator>
	);
}

function layoutOf(node: Extract<Node, { kind: 'split' }>): Record<string, number> {
	return Object.fromEntries(node.children.map((c, i) => [c.id, node.sizes[i] ?? 100 / node.children.length]));
}

/** What an area needs, measured from its widgets (pixels): its content height at the current width, one row (the tallest widget), the widest
 *  single widget, and all widgets in one row. A split keeps the area between these, so it is never cut below a widget nor larger than its content. */
type Extent = { height: number; minHeight: number; minWidth: number; maxWidth: number };
const AREA_PAD = 12; // p-1.5 on both sides
const AREA_GAP = 6; // gap-1.5

/** How a widget with a width sits in an area: laid out from its smallest width (0.85 of it) and grown to fill its row, so rows are always full
 *  (a lone widget in the last row takes the whole row rather than leaving a gap). */
function stretch(width: number) {
	const least = Math.ceil(width * 0.85);
	return { flex: `1 1 ${least}px`, minWidth: least };
}

function SplitView({ node }: { node: Extract<Node, { kind: 'split' }> }) {
	const ctx = useContext(DashboardContext);
	const group = useGroupRef();
	const wrapper = useRef<HTMLDivElement>(null);
	const reported = useRef<string>('');
	/** The layout that was set to fit the areas to their content (not by the user), to tell the two apart when the group reports a change. */
	const expected = useRef<Record<string, number> | null>(null);
	const [extent, setExtent] = useState<Record<string, Extent>>({});
	const [height, setHeight] = useState(0);
	// areas of a column fit their content (until the user drags their size): their share is what their content needs
	const fitIds = node.dir === 'column' ? node.children.filter((c) => c.kind === 'area' && !c.fixed).map((c) => c.id) : [];
	const fitKey = fitIds.map((id) => `${id}:${extent[id]?.height ?? '?'}`).join();
	useEffect(() => {
		const element = wrapper.current;
		if (!element || fitIds.length === 0) return;
		const observer = new ResizeObserver(() => setHeight(element.clientHeight));
		observer.observe(element);
		setHeight(element.clientHeight);
		return () => observer.disconnect();
	}, [fitIds.length > 0]); // eslint-disable-line react-hooks/exhaustive-deps
	useEffect(() => {
		if (fitIds.length === 0) {
			expected.current = null;
			return;
		}
		if (height <= 0 || fitIds.some((id) => extent[id] === undefined)) return;
		const share: Record<string, number> = {};
		for (const id of fitIds) share[id] = Math.min(60, Math.max(1, ((extent[id]!.height + 1) / height) * 100));
		const left = 100 - Object.values(share).reduce((a, b) => a + b, 0);
		const others = node.children.filter((c) => !fitIds.includes(c.id));
		const weight = others.reduce((sum, c) => sum + (node.sizes[node.children.indexOf(c)] ?? 1), 0) || 1;
		for (const c of others) share[c.id] = (left * (node.sizes[node.children.indexOf(c)] ?? 1)) / weight;
		expected.current = share;
		try {
			group.current?.setLayout(share);
		} catch {
			/* not mounted yet */
		}
	}, [fitKey, height, node.children.map((c) => c.id).join()]); // eslint-disable-line react-hooks/exhaustive-deps
	// a resize by another client (or a file edit) reaches this one without remounting the widgets
	const wanted = JSON.stringify(node.sizes.map((s) => Math.round(s * 10)));
	useEffect(() => {
		if (reported.current === wanted || fitIds.length > 0) return;
		try {
			group.current?.setLayout(layoutOf(node));
		} catch {
			/* not mounted yet */
		}
	}, [wanted]); // eslint-disable-line react-hooks/exhaustive-deps
	return (
		<div ref={wrapper} className="h-full">
			<Group
				key={node.children.map((c) => c.id).join()}
				id={node.id}
				groupRef={group}
				orientation={node.dir === 'row' ? 'horizontal' : 'vertical'}
				defaultLayout={layoutOf(node)}
				onLayoutChanged={(layout) => {
					const sizes = node.children.map((c) => layout[c.id] ?? 0);
					const target = expected.current;
					if (target && node.children.every((c) => Math.abs((layout[c.id] ?? 0) - (target[c.id] ?? 0)) < 0.6)) return; // our own fitting, not the user
					reported.current = JSON.stringify(sizes.map((s) => Math.round(s * 10)));
					// the user dragged: an area that was fitted keeps the size it has now
					const moved = target ? fitIds.filter((id) => Math.abs((layout[id] ?? 0) - (target[id] ?? 0)) >= 0.6) : [];
					if (moved.length > 0 || sizes.some((s, i) => Math.abs(s - (node.sizes[i] ?? 0)) > 0.05))
						ctx.apply((v) => setSizes(moved.reduce((view, id) => fixArea(view, id), v), node.id, sizes));
				}}
			>
				{node.children.flatMap((child, i) => [
					...(i > 0 ? [<Gutter key={`g${child.id}`} direction={node.dir} disabled={locked(node.children[i - 1]!, node.dir, extent) || locked(child, node.dir, extent)} />] : []),
					<Panel key={child.id} id={child.id} {...panelLimits(child, node.dir, extent[child.id])}>
						<NodeView node={child} onMeasure={(id, e) => setExtent((all) => (JSON.stringify(all[id]) === JSON.stringify(e) ? all : { ...all, [id]: e }))} />
					</Panel>,
				])}
			</Group>
		</div>
	);
}

/** Limits of a panel in pixels (numbers) or percent (strings): a pane at least 8 %; an area between one row and its content (in a column),
 *  or between its widest widget and all widgets side by side (in a row). */
function panelLimits(child: Node, dir: 'row' | 'column', e: Extent | undefined): { minSize: number | string; maxSize?: number } {
	if (child.kind !== 'area') return { minSize: '8' };
	if (!e) return { minSize: '4' };
	return dir === 'column' ? { minSize: e.minHeight, maxSize: Math.max(e.minHeight, e.height) } : { minSize: e.minWidth, maxSize: Math.max(e.minWidth, e.maxWidth) };
}

/** An area whose limits leave (almost) no room: its size is what its widgets need, there is nothing to drag. */
function locked(child: Node, dir: 'row' | 'column', extent: Record<string, Extent>): boolean {
	const e = extent[child.id];
	if (child.kind !== 'area' || !e) return false;
	return dir === 'column' ? e.height - e.minHeight < 4 : e.maxWidth - e.minWidth < 4;
}

function NodeView({ node, onMeasure }: { node: Node; onMeasure?: (id: string, e: Extent) => void }) {
	return node.kind === 'main' ? <Pane instance={node.widget} /> : node.kind === 'area' ? <AreaView node={node} onMeasure={onMeasure} /> : <SplitView node={node} />;
}

/** Compact widgets that wrap like text: each keeps its height (S or M); those with a width (a trace) grow a little to fill their row. */
function AreaView({ node, onMeasure }: { node: Extract<Node, { kind: 'area' }>; onMeasure?: (id: string, e: Extent) => void }) {
	const ctx = useContext(DashboardContext);
	const inner = useRef<HTMLDivElement>(null);
	const widgetKey = node.widgets.map((w) => w.id).join();
	useEffect(() => {
		const element = inner.current;
		if (!element || !onMeasure) return;
		const measure = () => {
			const items = [...element.children].filter((c): c is HTMLElement => c instanceof HTMLElement && c.dataset.areaItem !== undefined);
			// a widget with a width may shrink to 0.85 of it and is laid out from its width; the others are as wide as their content
			const least = (el: HTMLElement) => (el.dataset.width ? Math.ceil(Number(el.dataset.width) * 0.85) : el.offsetWidth);
			const basis = (el: HTMLElement) => (el.dataset.width ? Number(el.dataset.width) : el.offsetWidth);
			onMeasure(node.id, {
				height: element.offsetHeight + 1, // + the border line
				minHeight: Math.max(0, ...items.map((el) => el.offsetHeight)) + AREA_PAD + 1,
				minWidth: Math.max(0, ...items.map(least)) + AREA_PAD,
				maxWidth: items.reduce((sum, el) => sum + basis(el), 0) + AREA_GAP * Math.max(0, items.length - 1) + AREA_PAD,
			});
		};
		const observer = new ResizeObserver(measure);
		observer.observe(element);
		for (const child of element.children) observer.observe(child); // a tile whose text gets longer
		measure();
		return () => observer.disconnect();
	}, [node.id, widgetKey]); // eslint-disable-line react-hooks/exhaustive-deps
	const fits = !ctx.dragging || isCompact(ctx.dragging);
	const dropAt = ctx.drop && 'area' in ctx.drop && ctx.drop.area === node.id ? ctx.drop.index : null;
	const widgets = node.widgets;
	const acceptDrop = (index: number) => ({
		onDragOver: (e: React.DragEvent) => {
			if (!ctx.dragging || !fits) return;
			e.preventDefault();
			e.stopPropagation();
			if (dropAt !== index) ctx.setDrop({ area: node.id, index });
		},
		onDrop: (e: React.DragEvent) => {
			if (!ctx.dragging || !fits) return;
			e.preventDefault();
			e.stopPropagation();
			ctx.dropped((v, w) => placeInArea(v, w, node.id, index));
		},
	});
	return (
		<div
			data-testid="area"
			data-dropzone
			className={`relative z-40 h-full overflow-y-auto border-t border-line ${ctx.editing ? 'bg-raised' : ''} ${ctx.dragging && fits && dropAt === widgets.length ? 'outline-2 -outline-offset-2 outline-accent' : ''}`}
			{...(ctx.editing ? acceptDrop(widgets.length) : {})}
		>
			{ctx.editing && ctx.dragging && !fits && (
				// a pane dragged over an area goes beside it (the area itself holds compact widgets only)
				<div
					className="absolute inset-0 z-20"
					data-dropzone
					data-testid={`drop-${node.id}`}
					onDragOver={(e) => {
						e.preventDefault();
						const side = sideAt(e, e.currentTarget, false) as Side;
						if (!(ctx.drop && 'pane' in ctx.drop && ctx.drop.pane === node.id && ctx.drop.side === side)) ctx.setDrop({ pane: node.id, side });
					}}
					onDrop={(e) => {
						e.preventDefault();
						const side = sideAt(e, e.currentTarget, false) as Side;
						ctx.dropped((v, w) => placeInMain(v, w, { id: node.id, side }));
					}}
				>
					{ctx.drop && 'pane' in ctx.drop && ctx.drop.pane === node.id && <div className={`pointer-events-none absolute rounded-lg bg-accent/20 ring-2 ring-inset ring-accent ${HIGHLIGHT[ctx.drop.side]}`} />}
				</div>
			)}
			<div ref={inner} className="flex min-h-16 flex-wrap items-start gap-1.5 p-1.5">
				{widgets.map((w, i) => {
					const def = widgetDef(w.type);
					const height = COMPACT_HEIGHT[def?.size === 'M' ? 'M' : 'S'];
					const width = def?.width;
					return (
						<div
							key={w.id}
							data-testid={`area-${w.id}`}
							data-area-item=""
							data-width={width}
							data-dropzone
							style={{ height, ...(width ? stretch(width) : {}) }}
							className={`group relative min-w-28 ${width ? '' : 'flex-none'} ${ctx.editing ? 'cursor-grab active:cursor-grabbing' : ''} ${dropAt === i ? 'before:absolute before:inset-y-0 before:-left-1 before:w-0.5 before:rounded before:bg-accent' : ''}`}
							{...dragProps(() => w, ctx)}
							{...(ctx.editing ? acceptDrop(i) : {})}
						>
							<WidgetView instance={w} />
							{ctx.editing && (
								<span className="absolute right-px top-px flex rounded-tr-lg bg-panel opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
									<IconButton small icon="settings" label="Widget settings" data-testid={`settings-${w.id}`} onClick={() => ctx.configure(w)} />
									<IconButton small icon="close" variant="danger" label="Remove widget" onClick={() => ctx.apply((v) => removeWidget(v, w.id))} />
								</span>
							)}
						</div>
					);
				})}
			</div>
		</div>
	);
}

/** A widget as it would look, with the live values of its device. Not to be used, only to be looked at. */
function Preview({ type, device, props }: { type: string; device: string; props?: Record<string, unknown> }) {
	const { devices } = useContext(DashboardContext);
	const def = widgetDef(type);
	const info = device ? devices[device] : NO_DEVICE;
	if (!def || !info) return null;
	if (def.size === 'main') return <Thumbnail type={type} large />;
	const Component = def.component;
	return (
		<div inert className="pointer-events-none w-fit min-w-28 max-w-full overflow-hidden" style={{ height: COMPACT_HEIGHT[def.size], ...(def.width ? { width: def.width } : {}) }}>
			<Component id="preview" device={device} info={info} props={props ?? {}} />
		</div>
	);
}

/** A live preview that adds the widget when it is clicked, or where it is dragged. The target lies over the preview: a widget has buttons and fields of its own. */
function PreviewButton({ def, device, props, caption = '', testId, make, onClick }: { def: WidgetDef; device: string; props?: Record<string, unknown>; caption?: string; testId: string; make: () => WidgetInstance; onClick: () => void }) {
	return (
		<div className="group relative flex w-fit max-w-full flex-col gap-1">
			<div className="w-fit max-w-full rounded-lg ring-accent group-hover:ring-2"><Preview type={def.type} device={device} props={props} /></div>
			<span aria-hidden="true" className="text-xs text-muted group-hover:text-ink">{def.title}{caption}</span>
			<AddTarget testId={testId} label={`${def.title} ${device}${caption}`} make={make} onClick={onClick} className="absolute inset-0 rounded-lg active:cursor-grabbing" image={(from) => from.parentElement!.firstElementChild} />
		</div>
	);
}

const PICTURE: Record<string, ReactNode> = {
	oscilloscope: <path d="M3 25h8l2-19 2 19h9l2-12 2 12h17M3 4v24h42" />,
	device_card: <path d="M4 6h14M36 6h8M4 13h10M20 13h16M4 19h8M20 19h20M4 26h10M34 23h10v5H34z" />,
	summary: <path d="M4 10h12M36 10h8M4 20h9M19 20h9M34 20h9" />,
	value: <path d="M4 9h14M4 21h22M31 21h6" strokeWidth="1.5" />,
	number: <path d="M4 8h12M4 15h40v11H4zM32 20.5h7" />,
	button: <path d="M8 10h32v13H8zM17 16.5h14" />,
};

/** A little picture of a widget that cannot be shown as it is (too large, or not set up yet). */
function Thumbnail({ type, large }: { type: string; large?: boolean }) {
	return (
		<span className={`flex flex-none items-center justify-center rounded-md border border-line bg-field text-muted ${large ? 'h-20 w-full' : 'h-9 w-13'}`}>
			<svg aria-hidden="true" viewBox="0 0 48 32" className={large ? 'h-12' : 'h-7'} fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
				{PICTURE[type] ?? <path d="M6 6h36v20H6zM12 13h14M12 19h22" />}
			</svg>
		</span>
	);
}

/** What can be clicked to add a widget, and dragged to where it should be. (Not a <button>: Firefox does not drag buttons.) */
function AddTarget({ testId, label, className, make, onClick, image, children }: { testId: string; label: string; className: string; make: () => WidgetInstance; onClick: () => void; image?: (from: HTMLElement) => Element | null; children?: ReactNode }) {
	const ctx = useContext(DashboardContext);
	return (
		<div
			role="button"
			tabIndex={0}
			data-testid={testId}
			aria-label={label}
			title={`${label}: click, or drag it into the view`}
			className={className}
			onClick={onClick}
			onKeyDown={(e) => {
				if (e.key !== 'Enter' && e.key !== ' ') return;
				e.preventDefault();
				onClick();
			}}
			{...dragProps(make, ctx, image)}
		>
			{children}
		</div>
	);
}

/** A row of the picker for a widget that is not shown live: picture, name, what it is for. */
function PickerRow({ def, testId, make, onClick }: { def: WidgetDef; testId: string; make: () => WidgetInstance; onClick: () => void }) {
	return (
		<AddTarget testId={testId} label={def.title} make={make} onClick={onClick} className="-mx-2 flex items-center gap-3 rounded-lg p-2 text-left hover:bg-raised active:cursor-grabbing">
			<Thumbnail type={def.type} />
			<span className="min-w-0">
				<span className="block text-sm">{def.title}</span>
				{def.description && <span className="block text-xs text-muted">{def.description}</span>}
			</span>
		</AddTarget>
	);
}

/** The panel next to the view with everything that can be placed. What the profiles of a device offer is shown live, by device; what fits any
 *  device is listed once and asks for the device. */
function Picker({ chosen, setChosen, onPick, onClose, onNewWidget }: { /** A widget for any device that is being set up. */ chosen: Chosen | null; setChosen: (c: Chosen | null) => void; onPick: (instance: WidgetInstance) => void; onClose: () => void; onNewWidget: () => void }) {
	const { devices } = useContext(DashboardContext);
	const defs = useWidgetDefs();
	const [search, setSearch] = useState('');
	const ids = Object.keys(devices).sort().filter((id) => !isService(devices[id])); // instruments first: the services are in the selector of the "any device" widgets
	const everything = [...ids, ...Object.keys(devices).sort().filter((id) => isService(devices[id]))];
	const matches = (...texts: (string | undefined)[]) => texts.some((t) => t?.toLowerCase().includes(search.trim().toLowerCase()));
	const specific = (id: string) =>
		defs
			.filter((d) => d.needsDevice !== false && !d.generic && d.accepts(devices[id]!) && matches(id, d.title, d.description))
			.flatMap((d) => (d.variants?.(devices[id]!) ?? [{ label: '' }]).map((v, _, all) => ({ d, v, many: all.length > 1 })));
	const generic = defs.filter((d) => d.generic && matches(d.title, d.description));
	const server = defs.filter((d) => d.needsDevice === false && matches(d.title, d.description));
	const def = chosen ? defs.find((d) => d.type === chosen.type) : undefined;

	let body: ReactNode;
	if (chosen && def) {
		const done = (w: WidgetInstance) => {
			onPick(w);
			setChosen(null);
		};
		const preview = (props?: Record<string, unknown>) => (
			<div className="flex flex-col gap-1" data-testid="picker-preview">
				<span className="text-sm text-muted">Preview</span>
				<div className="rounded-lg bg-ground p-3">
					<div className="relative w-fit min-w-28 max-w-full">
						<Preview type={def.type} device={chosen.device} props={props} />
						<AddTarget testId="drag-preview" label={def.title} make={() => widget(def.type, chosen.device, props)} onClick={() => done(widget(def.type, chosen.device, props))} className="absolute inset-0 cursor-grab rounded-lg active:cursor-grabbing" image={(from) => from.parentElement!.firstElementChild} />
					</div>
				</div>
			</div>
		);
		const info = devices[chosen.device];
		body = (
			<div className="flex flex-col gap-3 overflow-y-auto p-4">
				{def.description && <p className="text-sm text-muted">{def.description}.</p>}
				{chosen.place && <p className="text-sm text-accent">It will be placed where you dropped it.</p>}
				<FormRow label="Device" htmlFor="pick-device">
					<Select id="pick-device" data-testid="pick-device" value={chosen.device} onChange={(e) => setChosen({ ...chosen, device: e.target.value })}>
						{everything.map((id) => <option key={id} value={id}>{isService(devices[id]) ? `${id} (service)` : id}</option>)}
					</Select>
				</FormRow>
				{info && def.configure ? (
					<CustomForm key={chosen.device} type={def.type as 'value' | 'number' | 'button' | 'trace'} device={chosen.device} info={info} preview={preview} onCreate={done} onCancel={() => setChosen(null)} />
				) : (
					<>
						{preview()}
						<div className="flex justify-end gap-2">
							<Button variant="ghost" onClick={() => setChosen(null)}>Back</Button>
							<Button variant="primary" data-testid="pick-add" disabled={!info} onClick={() => done(widget(def.type, chosen.device))}>Add</Button>
						</div>
					</>
				)}
			</div>
		);
	} else {
		body = (
			<>
				<div className="relative flex-none px-4 pt-3">
					<Icon name="search" size={14} className="absolute left-6.5 top-5.5 text-faint" />
					<Input type="search" aria-label="Search widgets" placeholder="Search" className="w-full !pl-8" value={search} onChange={(e) => setSearch(e.target.value)} />
				</div>
				<div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-4">
					{ids.length === 0 && <p className="text-sm text-muted">There are no devices to show yet.</p>}
					{ids.map((id) => {
						const entries = specific(id);
						if (entries.length === 0) return null;
						return (
							<section key={id} className="flex flex-col gap-2">
								<h3 className="flex items-baseline gap-2 text-sm font-medium">{id}<span className="truncate text-xs font-normal text-faint">{devices[id]!.schema?.class}</span></h3>
								{entries.filter(({ d }) => d.size === 'main').map(({ d, v }) => <PickerRow key={d.type} def={d} testId={`add-${d.type}-${id}`} make={() => widget(d.type, id, v.props)} onClick={() => onPick(widget(d.type, id, v.props))} />)}
								<div className="flex flex-wrap gap-2">
									{entries.filter(({ d }) => d.size !== 'main').map(({ d, v, many }) => (
										<PreviewButton key={`${d.type}${v.label}`} def={d} device={id} props={v.props} caption={many ? ` · ${v.label}` : ''} testId={`add-${d.type}-${id}${v.props && 'channel' in v.props ? `-${v.props.channel}` : ''}`} make={() => widget(d.type, id, v.props)} onClick={() => onPick(widget(d.type, id, v.props))} />
									))}
								</div>
							</section>
						);
					})}
					{server.length > 0 && (
						<section className="flex flex-col gap-2">
							<h3 className="text-sm font-medium">Whole server</h3>
							{server.map((d) => <PreviewButton key={d.type} def={d} device="" testId={`add-${d.type}`} make={() => widget(d.type)} onClick={() => onPick(widget(d.type))} />)}
						</section>
					)}
					{ids.length > 0 && generic.length > 0 && (
						<section className="flex flex-col">
							<h3 className="mb-1 text-sm font-medium">For any device</h3>
							{generic.map((d) => <PickerRow key={d.type} def={d} testId={`add-${d.type}`} make={() => widget(d.type)} onClick={() => setChosen({ type: d.type, device: ids[0] ?? Object.keys(devices).sort()[0]! })} />)}
						</section>
					)}
				</div>
				<div className="flex-none border-t border-line p-3">
					<Button data-testid="new-widget" variant="ghost" icon="plus" className="w-full" title="Write a widget of your own" onClick={onNewWidget}>New widget…</Button>
				</div>
			</>
		);
	}
	return (
		<aside data-testid="picker" aria-label="Add widget" className="flex w-92 flex-none flex-col border-l border-line bg-panel">
			<div className="flex flex-none items-center gap-1 border-b border-line py-1.5 pl-2 pr-2">
				{chosen ? <IconButton icon="chevron-left" label="Back to the list" onClick={() => setChosen(null)} /> : <span className="w-2" />}
				<h2 className="flex-1 truncate text-sm font-semibold">{def && chosen ? def.title : 'Add widget'}</h2>
				<IconButton icon="close" label="Close panel" onClick={onClose} />
			</div>
			{body}
		</aside>
	);
}

/** Asks for the name of a view. */
function NameDialog({ title, initial, onSave, onClose }: { title: string; initial: string; onSave: (name: string) => void; onClose: () => void }) {
	const [name, setName] = useState(initial);
	return (
		<Dialog title={title} testId="name-dialog" width="max-w-sm" onClose={onClose}>
			{(close) => (
				<form
					onSubmit={(e) => {
						e.preventDefault();
						if (!name.trim()) return;
						onSave(name.trim());
						close();
					}}
				>
					<DialogBody>
						<FormRow label="Name" htmlFor="view-name">
							<Input id="view-name" data-testid="name-input" autoFocus value={name} onChange={(e) => setName(e.target.value)} />
						</FormRow>
					</DialogBody>
					<DialogFooter>
						<Button type="button" variant="ghost" onClick={close}>Cancel</Button>
						<Button variant="primary" data-testid="name-save" disabled={!name.trim()}>Save</Button>
					</DialogFooter>
				</form>
			)}
		</Dialog>
	);
}

function slug(title: string): string {
	return title.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^(\d)/, 'v_$1');
}

/** Before the first view exists: every device as a card, as the dashboard always was. */
function AutoGrid({ devices }: { devices: Record<string, DeviceInfo> }) {
	return (
		<div className="mx-auto grid max-w-6xl items-start gap-3 p-3 md:grid-cols-2" data-testid="auto-grid">
			{Object.keys(devices).sort().filter((id) => !isService(devices[id])).map((id) =>
				devices[id]!.schema?.widget === 'oscilloscope' ? <div key={id} className="h-96 md:col-span-2"><OscilloscopeWidget id={id} info={devices[id]!} /></div> : <DeviceCard key={id} id={id} info={devices[id]!} />,
			)}
		</div>
	);
}

export function Dashboard() {
	const { connection, devices, info, views } = useStore();
	const path = usePath();
	const [editing, setEditing] = useState(false);
	const [picking, setPicking] = useState(false);
	const [creatingWidget, setCreatingWidget] = useState(false);
	const [note, setNote] = useState<string | null>(null);
	const [naming, setNaming] = useState<'new' | 'rename' | null>(null);
	const [configuring, setConfiguring] = useState<WidgetInstance | null>(null);
	const [dragging, setDragging] = useState<WidgetInstance | null>(null);
	const [chosen, setChosen] = useState<Chosen | null>(null);
	const [drop, setDrop] = useState<DropTarget>(null);
	const [drafts, setDrafts] = useState<Record<string, View>>({});
	const [error, setError] = useState<string | null>(null);
	const inFlight = useRef(0);

	const parsed = useMemo(() => {
		const list: { id: string; view: View }[] = [];
		const broken: Record<string, string> = {};
		for (const [id, text] of Object.entries(views)) {
			try {
				const view = parseView(JSON.parse(text));
				if (typeof view === 'string') broken[id] = view;
				else list.push({ id, view });
			} catch (e) {
				broken[id] = String(e);
			}
		}
		// a view without an `order` (a file written by hand) takes the place it has when sorted by title, so that new views go after it
		list.sort((a, b) => a.view.title.localeCompare(b.view.title));
		const place = new Map(list.map((v, i) => [v.id, v.view.order ?? i]));
		list.sort((a, b) => place.get(a.id)! - place.get(b.id)! || a.view.title.localeCompare(b.view.title));
		return { list, broken };
	}, [views]);

	const asked = path.startsWith('/views/') ? decodeURIComponent(path.slice('/views/'.length)) : null;
	const selected = parsed.list.find((v) => v.id === asked) ?? parsed.list[0] ?? null;
	const id = selected?.id ?? AUTO_ID;
	const view = drafts[id] ?? selected?.view ?? emptyView();
	const noViews = parsed.list.length === 0 && !drafts[id] && Object.keys(parsed.broken).length === 0;

	function persist(saveId: string, next: View) {
		setDrafts((d) => ({ ...d, [saveId]: next }));
		inFlight.current += 1;
		saveView(saveId, next)
			.then(() => setError(null))
			.catch((e: Error) => setError(`The view was not saved: ${e.message}`))
			.finally(() => {
				inFlight.current -= 1;
				// the server's echo has arrived by now; if it did not, the draft is dropped and the stored view shows again
				setTimeout(() => {
					if (inFlight.current === 0) setDrafts({});
				}, 300);
			});
	}
	const apply = (change: (view: View) => View) => {
		const next = change(view);
		if (!equal(next, view)) persist(id, next);
	};

	function newView(title: string) {
		const newId = slug(title);
		if (!newId || views[newId]) {
			setError(newId ? `A view "${newId}" exists already.` : 'Use letters or digits in the name.');
			return;
		}
		persist(newId, { ...emptyView(title), order: parsed.list.length });
		navigate(`/views/${newId}`);
		setEditing(true);
	}

	function duplicateView() {
		let copy = `${id}_copy`;
		for (let n = 2; views[copy]; n++) copy = `${id}_copy${n}`;
		persist(copy, { ...view, title: `${view.title} (copy)`, order: parsed.list.length });
		navigate(`/views/${copy}`);
	}

	/** Moves the view one place to the left or right among the tabs (the order is the `order` number of each view file). */
	function moveView(by: -1 | 1) {
		const at = parsed.list.findIndex((v) => v.id === id);
		const other = parsed.list[at + by];
		if (at < 0 || !other) return;
		const order = parsed.list.map((v) => v.id);
		[order[at], order[at + by]] = [order[at + by]!, order[at]!];
		saveOrder(order);
	}
	function saveOrder(order: string[]) {
		order.forEach((viewId, index) => {
			const entry = parsed.list.find((v) => v.id === viewId)!;
			if ((entry.view.order ?? -1) !== index) persist(viewId, { ...(viewId === id ? view : entry.view), order: index });
		});
	}
	/** Dragging a tab: which tab it is over and on which half of it (the drop goes before or after that tab). */
	const [tabDrop, setTabDrop] = useState<{ id: string; after: boolean } | null>(null);
	const draggedTab = useRef<string | null>(null);

	function removeView() {
		if (!selected || !window.confirm(`Delete the view "${selected.view.title}"?`)) return;
		deleteView(selected.id).catch((e: Error) => setError(e.message));
		navigate('/');
	}

	function createFirstView() {
		persist(AUTO_ID, defaultView(devices));
		setEditing(true);
	}

	/** The end of the list: main widgets below everything, compact ones at the end of the last area (the first one makes an area along the bottom). */
	const atTheEnd: Place = (v, w) => ((widgetDef(w.type)?.size ?? 'main') === 'main' ? addMain(v, w) : addToArea(v, w));

	function dropped(place: Place) {
		const w = dragging;
		setDragging(null);
		setDrop(null);
		if (!w) return;
		if (!w.device && widgetDef(w.type)?.generic) return setChosen({ type: w.type, device: Object.keys(devices).sort().find((d) => !isService(devices[d])) ?? Object.keys(devices).sort()[0] ?? '', place }); // ask for the device first
		apply((v) => place(v, w));
		setChosen(null);
	}

	// editing ends by itself when nothing has happened for a few minutes
	useEffect(() => {
		if (!editing) return;
		const wait = editIdleMs();
		let timer: ReturnType<typeof setTimeout>;
		const restart = () => {
			clearTimeout(timer);
			timer = setTimeout(() => {
				setEditing(false);
				setPicking(false);
				setChosen(null);
				setNote(`Editing ended: no activity for ${wait >= 60_000 ? `${Math.round(wait / 60_000)} min` : `${Math.round(wait / 1000)} s`}.`);
			}, wait);
		};
		const events = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'dragstart', 'touchstart'] as const;
		restart();
		for (const e of events) window.addEventListener(e, restart, { capture: true, passive: true });
		return () => {
			clearTimeout(timer);
			for (const e of events) window.removeEventListener(e, restart, { capture: true });
		};
	}, [editing]);
	useEffect(() => {
		if (!note) return;
		const timer = setTimeout(() => setNote(null), 10_000);
		return () => clearTimeout(timer);
	}, [note]);

	// the highlight of a drop zone goes away when the pointer leaves it (there is no event for "left every zone")
	useEffect(() => {
		if (!dragging) return;
		const leave = (e: DragEvent) => {
			if (!(e.target instanceof Element) || !e.target.closest('[data-dropzone]')) setDrop(null);
		};
		// leaving a zone for something that is not inside it (browsers differ in whether they keep sending dragover elsewhere)
		const left = (e: DragEvent) => {
			const zone = e.target instanceof Element ? e.target.closest('[data-dropzone]') : null;
			if (zone && !(e.relatedTarget instanceof globalThis.Node && zone.contains(e.relatedTarget))) setDrop(null);
		};
		const finish = () => {
			setDragging(null);
			setDrop(null);
		};
		window.addEventListener('dragover', leave);
		window.addEventListener('dragleave', left);
		window.addEventListener('dragend', finish);
		window.addEventListener('drop', finish);
		return () => {
			window.removeEventListener('dragover', leave);
			window.removeEventListener('dragleave', left);
			window.removeEventListener('dragend', finish);
			window.removeEventListener('drop', finish);
		};
	}, [dragging]);

	const ctx: Ctx = { editing, devices, dragging, setDragging, drop, setDrop, apply, dropped, view, configure: setConfiguring };
	const empty = !view.root;
	return (
		<DashboardContext.Provider value={ctx}>
			<Header
				actions={
					<>
						{error && <span role="alert" className="text-xs text-bad">{error}</span>}
						{note && <span role="status" data-testid="edit-note" className="text-xs text-muted">{note}</span>}
						{editing && (
							<>
								{selected && (
									<span className="flex items-center" role="group" aria-label="This view">
										<IconButton icon="chevron-left" label="Move view left" data-testid="view-left" disabled={parsed.list[0]?.id === id} onClick={() => moveView(-1)} />
										<IconButton icon="chevron-right" label="Move view right" data-testid="view-right" disabled={parsed.list[parsed.list.length - 1]?.id === id} onClick={() => moveView(1)} />
										<IconButton icon="edit" label="Rename view" data-testid="view-rename" onClick={() => setNaming('rename')} />
										<IconButton icon="copy" label="Duplicate view" data-testid="view-duplicate" onClick={duplicateView} />
										<IconButton icon="trash" variant="danger" label="Delete view" data-testid="view-delete" onClick={removeView} />
									</span>
								)}
								<Button data-testid="add-widget" icon="plus" aria-expanded={picking} onClick={() => setPicking(!picking)}>Add widget</Button>
							</>
						)}
						<Button
							data-testid="edit-toggle"
							aria-pressed={editing}
							variant={editing ? 'primary' : 'ghost'}
							icon={editing ? 'check' : 'edit'}
							onClick={() => {
								if (noViews) return createFirstView();
								setNote(null);
								setEditing(!editing);
								setPicking(false);
								setChosen(null);
							}}
						>
							{noViews ? 'Edit layout' : editing ? 'Done' : 'Edit'}
						</Button>
					</>
				}
			>
				<nav className="flex flex-wrap items-center gap-0.5" aria-label="Views">
					{parsed.list.map((v) => (
						<a
							key={v.id}
							href={`/views/${v.id}`}
							data-testid={`view-tab-${v.id}`}
							aria-current={v.id === id ? 'page' : undefined}
							className={`relative inline-flex h-8 items-center border-b-2 px-2.5 text-sm ${v.id === id ? 'border-accent text-ink' : 'border-transparent text-muted hover:text-ink'} ${tabDrop?.id === v.id ? (tabDrop.after ? 'after:absolute after:inset-y-1 after:-right-0.5 after:w-0.5 after:rounded after:bg-accent' : 'before:absolute before:inset-y-1 before:-left-0.5 before:w-0.5 before:rounded before:bg-accent') : ''}`}
							{...(editing
								? {
										draggable: true,
										onDragStart: (e: React.DragEvent) => {
											draggedTab.current = v.id;
											e.dataTransfer.setData('application/x-laborchestra-view', v.id);
											e.dataTransfer.effectAllowed = 'move';
										},
										onDragOver: (e: React.DragEvent<HTMLElement>) => {
											if (!draggedTab.current || draggedTab.current === v.id) return;
											e.preventDefault();
											const box = e.currentTarget.getBoundingClientRect();
											const after = e.clientX > box.left + box.width / 2;
											if (tabDrop?.id !== v.id || tabDrop.after !== after) setTabDrop({ id: v.id, after });
										},
										onDragLeave: () => setTabDrop((t) => (t?.id === v.id ? null : t)),
										onDrop: (e: React.DragEvent) => {
											e.preventDefault();
											const moved = draggedTab.current;
											if (moved && tabDrop) saveOrder(reorderIds(parsed.list.map((x) => x.id), moved, v.id, tabDrop.after));
											draggedTab.current = null;
											setTabDrop(null);
										},
										onDragEnd: () => {
											draggedTab.current = null;
											setTabDrop(null);
										},
									}
								: {})}
							onClick={(e) => {
								e.preventDefault();
								const to = parsed.list.findIndex((x) => x.id === v.id);
								const from = parsed.list.findIndex((x) => x.id === id);
								navigateSliding(`/views/${v.id}`, to >= from ? 'forward' : 'back');
							}}
						>
							{v.view.title}
						</a>
					))}
					{Object.entries(parsed.broken).map(([bid, why]) => (
						<span key={bid} className="inline-flex items-center gap-1 rounded-md bg-bad/10 px-2 py-1 text-xs text-bad" title={why}>
							<Icon name="warning" size={12} /> {bid}.json is not valid
						</span>
					))}
					{editing && <IconButton icon="plus" label="New view" data-testid="new-view" onClick={() => setNaming('new')} />}
				</nav>
			</Header>
			<div className="flex min-h-0 flex-1 flex-col">
				{naming && (
					<NameDialog
						title={naming === 'new' ? 'New view' : 'Rename view'}
						initial={naming === 'new' ? '' : view.title}
						onSave={(name) => (naming === 'new' ? newView(name) : apply((v) => ({ ...v, title: name })))}
						onClose={() => setNaming(null)}
					/>
				)}
				{configuring && (
					<WidgetSettingsDialog
						key={configuring.id}
						instance={configuring}
						title={widgetDef(configuring.type)?.title ?? configuring.type}
						specs={widgetDef(configuring.type)?.props ?? []}
						onSave={(props) => apply((v) => setProps(v, configuring.id, props))}
						onClose={() => setConfiguring(null)}
					/>
				)}
				{creatingWidget && <NewWidgetDialog onClose={() => setCreatingWidget(false)} />}
				<div className="flex min-h-0 flex-1">
					<div className="flex min-w-0 flex-1 flex-col" style={{ viewTransitionName: 'dashboard-content' }}>
				<div
							{...(editing && dragging && !view.root && !noViews
								? {
										'data-testid': 'drop-empty',
										onDragOver: (e: React.DragEvent) => e.preventDefault(),
										onDrop: (e: React.DragEvent) => {
											e.preventDefault();
											dropped((v, w) => placeInMain(v, w, undefined, isCompact(w)));
										},
									}
								: {})}
							className={`min-h-0 flex-1 ${editing && dragging && !view.root && !noViews ? 'rounded-lg outline-2 -outline-offset-8 outline-dashed outline-accent' : ''} ${noViews ? 'overflow-auto' : 'overflow-hidden'}`}>
					{noViews && connection === 'connected' && Object.keys(devices).length > 0 ? (
						<AutoGrid devices={devices} />
					) : view.root ? (
						<div className="relative h-full">
							<NodeView node={view.root} />
							{editing && dragging && <EdgeRails />}
						</div>
					) : (
						connection === 'connected' && (
							<p className="mx-auto max-w-lg p-12 text-center text-muted" data-testid="no-devices">
								{Object.keys(devices).length === 0 ? (
									<>
										No devices configured. The workspace is <code className="font-mono">{info?.workspace}</code>
										{info?.devices_file ? ', and its devices.json lists no devices.' : ', and it has no devices.json yet.'} Add one on the{' '}
										<a href="/devices" className="underline" onClick={(e) => { e.preventDefault(); navigate('/devices'); }}>Devices</a>{' '}
										page, or start the server with <code className="font-mono">--workspace &lt;folder&gt;</code> to use another workspace.
									</>
								) : empty ? (
									editing ? 'This view is empty. Add a widget, or drag one here.' : 'This view is empty. Press Edit to add widgets.'
								) : null}
							</p>
						)
					)}
				</div>
					</div>
					{editing && picking && (
						<Picker
							chosen={chosen}
							setChosen={setChosen}
							onPick={(instance) => apply((v) => (chosen?.place ?? atTheEnd)(v, instance))}
							onClose={() => {
								setPicking(false);
								setChosen(null);
							}}
							onNewWidget={() => setCreatingWidget(true)}
						/>
					)}
				</div>
			</div>
		</DashboardContext.Provider>
	);
}
