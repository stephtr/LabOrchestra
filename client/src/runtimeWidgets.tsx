import { Component, ComponentType, ErrorInfo, ReactNode, useSyncExternalStore } from 'react';
import { describe, reportError } from './errors';
import { invokeHub, setWidgetsHandler } from './store';
import type { WidgetMeta, WidgetProps } from './widget-sdk';

/**
 * Widgets that are not part of the client: the files in the workspace's widgets/ folder, built by the server. The server announces them
 * (name and version), this loads each module over the control hub (so the access token is used) and imports it from a blob URL; the
 * import map of the page resolves react and the SDK to the host's own modules. A new version is imported again and replaces the old one.
 */
export type RuntimeWidget = {
	name: string;
	version: string;
	/** Why it could not be built or loaded: shown in place of the widget. */
	error: string | null;
	module: { component: ComponentType<WidgetProps>; meta: WidgetMeta } | null;
};
type State = { ready: boolean; widgets: Record<string, RuntimeWidget>; problem: string | null };
type Listing = { widgets: { name: string; version: string; error: string | null }[]; css_version: string; problem: string | null };

let state: State = { ready: false, widgets: {}, problem: null };
const listeners = new Set<() => void>();
let cssVersion = '';
let latest = 0;

function set(next: State) {
	state = next;
	listeners.forEach((l) => l());
}

export function useRuntimeWidgets(): State {
	return useSyncExternalStore(
		(l) => {
			listeners.add(l);
			return () => listeners.delete(l);
		},
		() => state,
	);
}

export const runtimeWidgets = () => state;

async function load(name: string): Promise<RuntimeWidget> {
	const { version, code, error } = await invokeHub<{ version: string; code: string | null; error: string | null }>('get_widget', name);
	if (error || code === null) return { name, version, error: error ?? 'The widget has no code', module: null };
	const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
	try {
		const imported = await import(/* @vite-ignore */ url);
		if (typeof imported.default !== 'function') return { name, version, error: `The widget "${name}" must export a component as default`, module: null };
		const meta = (imported.meta ?? {}) as Partial<WidgetMeta>;
		return {
			name,
			version,
			error: null,
			module: { component: imported.default, meta: { title: meta.title ?? name, size: meta.size ?? 'S', profile: meta.profile, needsDevice: meta.needsDevice, props: Array.isArray(meta.props) ? meta.props : undefined } },
		};
	} catch (e) {
		return { name, version, error: `The widget "${name}" could not be loaded: ${e instanceof Error ? e.message : String(e)}`, module: null };
	} finally {
		URL.revokeObjectURL(url);
	}
}

async function loadCss(version: string) {
	if (version === cssVersion) return;
	const css = await invokeHub<string>('get_widget_css');
	if (!css) return;
	let style = document.getElementById('lo-widget-css') as HTMLStyleElement | null;
	if (!style) {
		style = document.createElement('style');
		style.id = 'lo-widget-css';
		document.head.append(style);
	}
	style.textContent = css;
	cssVersion = version;
}

/** Brings the loaded widgets in line with what the server lists (at the start, after a reconnect, and when the server announces a change). */
async function sync(listing: Listing) {
	const mine = ++latest;
	try {
		await loadCss(listing.css_version);
		const widgets: Record<string, RuntimeWidget> = {};
		await Promise.all(
			listing.widgets.map(async (w) => {
				const known = state.widgets[w.name];
				if (known && known.version === w.version && known.version !== '0' && !known.error) widgets[w.name] = known;
				else if (w.error) widgets[w.name] = { name: w.name, version: w.version, error: w.error, module: null };
				else widgets[w.name] = await load(w.name);
			}),
		);
		if (mine === latest) set({ ready: true, widgets, problem: listing.problem });
	} catch (e) {
		if (mine === latest) set({ ...state, ready: true, problem: `The widgets could not be loaded: ${e instanceof Error ? e.message : String(e)}` });
	}
}

setWidgetsHandler((listing) => void sync(listing as Listing));

/** One widget instance: a failure inside it shows where it is and does not take the dashboard down. A new version starts it afresh. */
export class WidgetBoundary extends Component<{ name: string; children: ReactNode }, { error: Error | null }> {
	state = { error: null as Error | null };

	static getDerivedStateFromError(error: Error) {
		return { error };
	}

	componentDidCatch(error: Error, info: ErrorInfo) {
		const { message, stack } = describe(error);
		reportError(`Widget ${this.props.name}: ${message}`, `${stack ?? ''}\n${info.componentStack ?? ''}`, 'widget');
	}

	render() {
		if (!this.state.error) return this.props.children;
		return (
			<div role="alert" data-testid={`widget-crash-${this.props.name}`} className="h-full overflow-auto rounded-lg border border-bad/40 bg-bad/10 p-2 text-xs text-bad">
				The widget “{this.props.name}” failed: {String(this.state.error.message)}
			</div>
		);
	}
}
