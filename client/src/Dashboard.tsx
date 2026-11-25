import { createContext, ReactNode, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Group, Panel, Separator, useGroupRef } from 'react-resizable-panels';
import {
	addMain,
	addToStrip,
	defaultView,
	emptyView,
	equal,
	findWidget,
	mains,
	moveToMain,
	moveToStrip,
	Node,
	parseView,
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
import { NewWidgetDialog } from './NewWidgetDialog';
import { WidgetSettingsDialog } from './WidgetSettingsDialog';
import { navigate, usePath } from './router';
import { DeviceInfo, deleteView, saveView, useStore } from './store';
import { DeviceCard } from './DeviceCard';
import { OscilloscopeWidget } from './OscilloscopeWidget';
import { COMPACT_HEIGHT, runtimeWidgetsReady, useWidgetDefs, widgetDef } from './widgets';

const AUTO_ID = 'dashboard';
const NO_DEVICE: DeviceInfo = { status: 'ready', error: null, schema: null, state: null, revision: 0 };

type DropTarget = { pane: string; side: Side | 'swap' } | { strip: number } | null;
type Ctx = {
	editing: boolean;
	devices: Record<string, DeviceInfo>;
	dragging: string | null;
	setDragging: (id: string | null) => void;
	drop: DropTarget;
	setDrop: (drop: DropTarget) => void;
	apply: (change: (view: View) => View) => void;
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
			<div data-testid={`placeholder-${instance.id}`} className="flex h-full items-center justify-center rounded-lg border border-dashed border-zinc-400 p-2 text-center text-xs text-zinc-500">
				{problem}
			</div>
		);
	const Component = def.component;
	return <Component id={instance.id} device={instance.device} info={info} props={instance.props ?? {}} />;
}

function dragProps(id: string, ctx: Ctx) {
	return ctx.editing
		? {
				draggable: true,
				onDragStart: (e: React.DragEvent) => {
					e.dataTransfer.setData('application/x-laborchestra-widget', id);
					e.dataTransfer.effectAllowed = 'move';
					ctx.setDragging(id);
				},
				onDragEnd: () => {
					ctx.setDragging(null);
					ctx.setDrop(null);
				},
			}
		: {};
}

function sideAt(e: React.DragEvent, element: HTMLElement): Side | 'swap' {
	const box = element.getBoundingClientRect();
	const x = (e.clientX - box.left) / box.width;
	const y = (e.clientY - box.top) / box.height;
	const edge = 0.25;
	const toEdge = Math.min(x, 1 - x, y, 1 - y);
	if (toEdge > edge) return 'swap';
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
	const over = ctx.drop && 'pane' in ctx.drop && ctx.drop.pane === instance.id ? ctx.drop.side : null;
	return (
		<div data-testid={`pane-${instance.id}`} className="relative flex h-full flex-col">
			{ctx.editing && (
				<div className="z-10 flex flex-none items-center gap-2 bg-zinc-200/90 px-2 py-0.5 text-xs dark:bg-slate-800/90">
					<span {...dragProps(instance.id, ctx)} className="cursor-grab select-none" title="Drag to move" data-testid={`handle-${instance.id}`}>
						⠿ {instance.type}{instance.device ? ` · ${instance.device}` : ''}
					</span>
					<span className="flex-1" />
					<button data-testid={`settings-${instance.id}`} className="text-zinc-500 hover:text-brand" aria-label="Widget settings" onClick={() => ctx.configure(instance)}>⚙</button>
					<button className="text-zinc-500 hover:text-red-600" aria-label="Remove widget" onClick={() => ctx.apply((v) => removeWidget(v, instance.id))}>
						✕
					</button>
				</div>
			)}
			<div className="min-h-0 flex-1 overflow-auto">
				<WidgetView instance={instance} />
			</div>
			{ctx.editing && ctx.dragging && ctx.dragging !== instance.id && (
				<div
					className="absolute inset-0 z-20"
					data-testid={`drop-${instance.id}`}
					onDragOver={(e) => {
						e.preventDefault();
						const side = sideAt(e, e.currentTarget);
						if (!(ctx.drop && 'pane' in ctx.drop && ctx.drop.pane === instance.id && ctx.drop.side === side)) ctx.setDrop({ pane: instance.id, side });
					}}
					onDrop={(e) => {
						e.preventDefault();
						const id = ctx.dragging!;
						const side = sideAt(e, e.currentTarget);
						ctx.apply((v) => (side === 'swap' ? (mains(v.root).some((m) => m.widget.id === id) ? swapMains(v, id, instance.id) : moveToMain(v, id, { id: instance.id, side: 'bottom' })) : moveToMain(v, id, { id: instance.id, side })));
						ctx.setDragging(null);
						ctx.setDrop(null);
					}}
				>
					{over && <div className={`pointer-events-none absolute bg-sky-500/30 ring-2 ring-sky-500 ${HIGHLIGHT[over]}`} />}
				</div>
			)}
		</div>
	);
}

function Gutter({ direction }: { direction: 'row' | 'column' }) {
	return (
		<Separator
			className={`group relative flex-none bg-zinc-300 transition-colors hover:bg-brand data-[separator=active]:bg-brand dark:bg-slate-800 ${direction === 'row' ? 'w-1 cursor-col-resize' : 'h-1 cursor-row-resize'}`}
		>
			<span className={`absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded bg-zinc-500 group-hover:bg-white ${direction === 'row' ? 'h-8 w-0.5' : 'h-0.5 w-8'}`} />
		</Separator>
	);
}

function layoutOf(node: Extract<Node, { kind: 'split' }>): Record<string, number> {
	return Object.fromEntries(node.children.map((c, i) => [c.id, node.sizes[i] ?? 100 / node.children.length]));
}

function SplitView({ node }: { node: Extract<Node, { kind: 'split' }> }) {
	const ctx = useContext(DashboardContext);
	const group = useGroupRef();
	const reported = useRef<string>('');
	// a resize by another client (or a file edit) reaches this one without remounting the widgets
	const wanted = JSON.stringify(node.sizes.map((s) => Math.round(s * 10)));
	useEffect(() => {
		if (reported.current === wanted) return;
		try {
			group.current?.setLayout(layoutOf(node));
		} catch {
			/* not mounted yet */
		}
	}, [wanted]); // eslint-disable-line react-hooks/exhaustive-deps
	return (
		<Group
			key={node.children.map((c) => c.id).join()}
			id={node.id}
			groupRef={group}
			orientation={node.dir === 'row' ? 'horizontal' : 'vertical'}
			defaultLayout={layoutOf(node)}
			onLayoutChanged={(layout) => {
				const sizes = node.children.map((c) => layout[c.id] ?? 0);
				reported.current = JSON.stringify(sizes.map((s) => Math.round(s * 10)));
				if (sizes.some((s, i) => Math.abs(s - (node.sizes[i] ?? 0)) > 0.05)) ctx.apply((v) => setSizes(v, node.id, sizes));
			}}
		>
			{node.children.flatMap((child, i) => [
				...(i > 0 ? [<Gutter key={`g${child.id}`} direction={node.dir} />] : []),
				<Panel key={child.id} id={child.id} minSize="8">
					<NodeView node={child} />
				</Panel>,
			])}
		</Group>
	);
}

function NodeView({ node }: { node: Node }) {
	return node.kind === 'main' ? <Pane instance={node.widget} /> : <SplitView node={node} />;
}

function Strip({ widgets }: { widgets: WidgetInstance[] }) {
	const ctx = useContext(DashboardContext);
	const dragged = ctx.dragging ? findWidget(ctx.view, ctx.dragging) : undefined;
	const fits = !dragged || widgetDef(dragged.type)?.size !== 'main';
	const dropAt = ctx.drop && 'strip' in ctx.drop ? ctx.drop.strip : null;
	const acceptDrop = (index: number) => ({
		onDragOver: (e: React.DragEvent) => {
			if (!ctx.dragging || !fits) return;
			e.preventDefault();
			e.stopPropagation();
			if (dropAt !== index) ctx.setDrop({ strip: index });
		},
		onDrop: (e: React.DragEvent) => {
			if (!ctx.dragging || !fits) return;
			e.preventDefault();
			e.stopPropagation();
			const id = ctx.dragging;
			ctx.apply((v) => moveToStrip(v, id, index));
			ctx.setDragging(null);
			ctx.setDrop(null);
		},
	});
	if (widgets.length === 0 && !ctx.editing) return null;
	return (
		<div
			data-testid="strip"
			className={`flex min-h-16 flex-none flex-wrap items-start gap-2 bg-zinc-100 p-2 dark:bg-slate-950 ${ctx.editing ? 'outline-1 -outline-offset-4 outline-dashed outline-zinc-400' : ''}`}
			{...(ctx.editing ? acceptDrop(widgets.length) : {})}
		>
			{widgets.length === 0 && <span className="self-center text-xs text-zinc-500">Compact widgets go here.</span>}
			{widgets.map((w, i) => {
				const size = widgetDef(w.type)?.size;
				const height = COMPACT_HEIGHT[size === 'M' ? 'M' : 'S'];
				return (
					<div
						key={w.id}
						data-testid={`strip-${w.id}`}
						style={{ height }}
						className={`relative min-w-40 flex-none ${dropAt === i ? 'border-l-4 border-sky-500' : ''}`}
						{...dragProps(w.id, ctx)}
						{...(ctx.editing ? acceptDrop(i) : {})}
					>
						<WidgetView instance={w} />
						{ctx.editing && (
							<span className="absolute right-1 top-0 flex gap-1 text-xs text-zinc-500">
								<button data-testid={`settings-${w.id}`} className="hover:text-brand" aria-label="Widget settings" onClick={() => ctx.configure(w)}>⚙</button>
								<button className="hover:text-red-600" aria-label="Remove widget" onClick={() => ctx.apply((v) => removeWidget(v, w.id))}>✕</button>
							</span>
						)}
					</div>
				);
			})}
		</div>
	);
}

function Picker({ onPick }: { onPick: (instance: WidgetInstance) => void }) {
	const { devices } = useContext(DashboardContext);
	const defs = useWidgetDefs();
	const ids = Object.keys(devices).sort();
	const button = 'rounded bg-zinc-200 px-2 py-0.5 text-xs hover:bg-brand hover:text-white dark:bg-slate-800';
	const [custom, setCustom] = useState<{ type: 'value' | 'number' | 'button'; device: string } | null>(null);
	if (custom && devices[custom.device])
		return (
			<div data-testid="picker" className="border-b border-zinc-300 bg-white p-2 text-sm dark:border-slate-700 dark:bg-slate-900">
				<CustomForm type={custom.type} device={custom.device} info={devices[custom.device]!} onCreate={onPick} onCancel={() => setCustom(null)} />
			</div>
		);
	return (
		<div data-testid="picker" className="max-h-64 overflow-auto border-b border-zinc-300 bg-white p-2 text-sm dark:border-slate-700 dark:bg-slate-900">
			<div className="flex flex-wrap items-center gap-2 py-0.5">
				<span className="w-48 truncate text-zinc-500">whole server</span>
				{defs.filter((d) => d.needsDevice === false).map((d) => (
					<button key={d.type} data-testid={`add-${d.type}`} className={button} onClick={() => onPick(widget(d.type))}>{d.title}</button>
				))}
			</div>
			{ids.length === 0 && <p className="text-zinc-500">There are no devices to show yet.</p>}
			{ids.map((id) => (
				<div key={id} className="flex flex-wrap items-center gap-2 py-0.5">
					<span className="w-48 truncate font-mono">{id}</span>
					{defs
						.filter((d) => d.needsDevice !== false && d.accepts(devices[id]!))
						.flatMap((d) => (d.variants?.(devices[id]!) ?? [{ label: '' }]).map((v) => ({ d, v })))
						.map(({ d, v }) => (
							<button
								key={`${d.type}${v.label}`}
								data-testid={`add-${d.type}-${id}${v.props && 'channel' in v.props ? `-${v.props.channel}` : ''}`}
								className={button}
								onClick={() => (d.configure ? setCustom({ type: d.type as 'value' | 'number' | 'button', device: id }) : onPick(widget(d.type, id, v.props)))}
							>
								{d.title}{v.label ? ` · ${v.label}` : ''}
							</button>
						))}
				</div>
			))}
		</div>
	);
}

function slug(title: string): string {
	return title.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^(\d)/, 'v_$1');
}

/** Before the first view exists: every device as a card, as the dashboard always was. */
function AutoGrid({ devices }: { devices: Record<string, DeviceInfo> }) {
	return (
		<div className="grid gap-4 p-2 md:grid-cols-2" data-testid="auto-grid">
			{Object.keys(devices).sort().map((id) =>
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
	const [configuring, setConfiguring] = useState<WidgetInstance | null>(null);
	const [dragging, setDragging] = useState<string | null>(null);
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

	function newView() {
		const title = window.prompt('Name of the new view');
		if (!title?.trim()) return;
		const newId = slug(title);
		if (!newId || views[newId]) {
			setError(newId ? `A view "${newId}" exists already.` : 'Use letters or digits in the name.');
			return;
		}
		persist(newId, { ...emptyView(title.trim()), order: parsed.list.length });
		navigate(`/views/${newId}`);
		setEditing(true);
	}

	function renameView() {
		const title = window.prompt('Name of the view', view.title);
		if (title?.trim()) apply((v) => ({ ...v, title: title.trim() }));
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
		order.forEach((viewId, index) => {
			const entry = parsed.list.find((v) => v.id === viewId)!;
			if ((entry.view.order ?? -1) !== index) persist(viewId, { ...(viewId === id ? view : entry.view), order: index });
		});
	}

	function removeView() {
		if (!selected || !window.confirm(`Delete the view "${selected.view.title}"?`)) return;
		deleteView(selected.id).catch((e: Error) => setError(e.message));
		navigate('/');
	}

	function createFirstView() {
		persist(AUTO_ID, defaultView(devices));
		setEditing(true);
	}

	const ctx: Ctx = { editing, devices, dragging, setDragging, drop, setDrop, apply, view, configure: setConfiguring };
	const empty = !view.root && view.strip.length === 0;
	return (
		<DashboardContext.Provider value={ctx}>
			<div className="flex min-h-0 flex-1 flex-col">
				<div className="flex flex-none items-center gap-1 px-2 py-1 text-sm">
					{parsed.list.map((v) => (
						<a
							key={v.id}
							href={`/views/${v.id}`}
							data-testid={`view-tab-${v.id}`}
							aria-current={v.id === id ? 'page' : undefined}
							className={`rounded px-2 py-0.5 ${v.id === id ? 'bg-zinc-300 dark:bg-slate-700' : 'text-zinc-600 hover:bg-zinc-200 dark:text-zinc-300 dark:hover:bg-slate-800'}`}
							onClick={(e) => {
								e.preventDefault();
								navigate(`/views/${v.id}`);
							}}
						>
							{v.view.title}
						</a>
					))}
					{Object.entries(parsed.broken).map(([bid, why]) => (
						<span key={bid} className="rounded bg-red-100 px-2 py-0.5 text-xs text-red-800 dark:bg-red-950 dark:text-red-300" title={why}>
							{bid}.json is not valid
						</span>
					))}
					{editing && (
						<button data-testid="new-view" className="rounded px-2 py-0.5 text-zinc-500 hover:bg-zinc-200 dark:hover:bg-slate-800" onClick={newView}>
							+ View
						</button>
					)}
					<span className="flex-1" />
					{error && <span role="alert" className="text-xs text-red-600">{error}</span>}
					{editing && (
						<>
							<button data-testid="add-widget" className="rounded bg-zinc-200 px-2 py-0.5 dark:bg-slate-800" aria-expanded={picking} onClick={() => setPicking(!picking)}>
								Add widget
							</button>
							<button data-testid="new-widget" className="rounded px-2 py-0.5 text-zinc-500 hover:text-brand" onClick={() => setCreatingWidget(true)}>
								New widget…
							</button>
							{selected && (
								<>
									<button data-testid="view-left" aria-label="Move view left" className="rounded px-1 text-zinc-500 hover:text-brand disabled:opacity-30" disabled={parsed.list[0]?.id === id} onClick={() => moveView(-1)}>◀</button>
									<button data-testid="view-right" aria-label="Move view right" className="rounded px-1 text-zinc-500 hover:text-brand disabled:opacity-30" disabled={parsed.list[parsed.list.length - 1]?.id === id} onClick={() => moveView(1)}>▶</button>
									<button data-testid="view-rename" className="rounded px-2 py-0.5 text-zinc-500 hover:text-brand" onClick={renameView}>Rename</button>
									<button data-testid="view-duplicate" className="rounded px-2 py-0.5 text-zinc-500 hover:text-brand" onClick={duplicateView}>Duplicate</button>
									<button className="rounded px-2 py-0.5 text-zinc-500 hover:text-red-600" onClick={removeView}>
										Delete view
									</button>
								</>
							)}
						</>
					)}
					<button
						data-testid="edit-toggle"
						aria-pressed={editing}
						className={`rounded px-2 py-0.5 ${editing ? 'bg-brand text-white' : 'bg-zinc-200 dark:bg-slate-800'}`}
						onClick={() => {
							if (noViews) return createFirstView();
							setEditing(!editing);
							setPicking(false);
						}}
					>
						{noViews ? 'Edit layout' : editing ? 'Done' : 'Edit'}
					</button>
				</div>
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
				{editing && picking && (
					<Picker
						onPick={(instance) => {
							const size = widgetDef(instance.type)?.size ?? 'main';
							apply((v) => (size === 'main' ? addMain(v, instance) : addToStrip(v, instance)));
							setPicking(false);
						}}
					/>
				)}
				<div className={`min-h-0 flex-1 ${noViews ? 'overflow-auto' : 'overflow-hidden'}`}>
					{noViews && connection === 'connected' && Object.keys(devices).length > 0 ? (
						<AutoGrid devices={devices} />
					) : view.root ? (
						<NodeView node={view.root} />
					) : (
						connection === 'connected' && (
							<p className="p-4 text-zinc-500" data-testid="no-devices">
								{Object.keys(devices).length === 0 ? (
									<>
										No devices configured. The workspace is <code className="font-mono">{info?.workspace}</code>
										{info?.devices_file ? ', and its devices.json lists no devices.' : ', and it has no devices.json yet.'} Add one on the{' '}
										<a href="/devices" className="underline" onClick={(e) => { e.preventDefault(); navigate('/devices'); }}>Devices</a>{' '}
										page, or start the server with <code className="font-mono">--workspace &lt;folder&gt;</code> to use another workspace.
									</>
								) : empty ? (
									editing ? 'This view is empty. Add a widget.' : 'This view is empty. Press Edit to add widgets.'
								) : null}
							</p>
						)
					)}
				</div>
				{!noViews && <Strip widgets={view.strip} />}
			</div>
		</DashboardContext.Provider>
	);
}

export type { ReactNode };
