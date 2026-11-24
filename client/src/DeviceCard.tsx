import { useState } from 'react';
import { formatNumber } from './format';
import { callAction, DeviceInfo, Param, RemoteError, ActionSchema } from './store';

const STATUS_STYLE: Record<string, string> = {
	ready: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300',
	starting: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
	disconnected: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
	error: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300',
	stopped: 'bg-zinc-200 text-zinc-700 dark:bg-slate-800 dark:text-zinc-300',
};

function Value({ id, path, value }: { id: string; path: string; value: unknown }) {
	if (value !== null && typeof value === 'object') {
		const entries = Array.isArray(value) ? value.map((v, i) => [String(i), v] as const) : Object.entries(value);
		return (
			<dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 border-l border-zinc-300 pl-3 dark:border-slate-700">
				{entries.map(([key, item]) => (
					<div key={key} className="contents">
						<dt className="text-zinc-500">{key}</dt>
						<dd>
							<Value id={id} path={path ? `${path}.${key}` : key} value={item} />
						</dd>
					</div>
				))}
			</dl>
		);
	}
	const text = typeof value === 'number' ? formatNumber(value) : typeof value === 'string' ? value || '""' : String(value);
	return (
		<span data-testid={`state-${id}-${path}`} className="font-mono tabular-nums">
			{text}
		</span>
	);
}

function toArgument(param: Param, raw: string | boolean): unknown {
	if (param.type === 'bool') return Boolean(raw);
	const text = String(raw);
	if (text === '' && !param.required) return param.default;
	if (text === '') throw new Error(`"${param.name}" is required`);
	if (param.type === 'int' || param.type === 'float') {
		const number = Number(text);
		if (Number.isNaN(number)) throw new Error(`"${param.name}" must be a number`);
		return number;
	}
	if (param.type === 'json') return JSON.parse(text);
	return text;
}

function ActionRow({ device, action }: { device: string; action: ActionSchema }) {
	const [values, setValues] = useState<Record<string, string | boolean>>(() =>
		Object.fromEntries(
			action.params.map((p) => [p.name, p.type === 'bool' ? Boolean(p.default) : p.default == null ? '' : String(p.default)]),
		),
	);
	const [busy, setBusy] = useState(false);
	const [outcome, setOutcome] = useState<{ ok: boolean; text: string; details?: string } | null>(null);

	async function run() {
		setBusy(true);
		try {
			const args = action.params.map((p) => toArgument(p, values[p.name] ?? ''));
			const result = await callAction(device, action.name, args);
			setOutcome({ ok: true, text: result == null ? 'done' : JSON.stringify(result) });
		} catch (e) {
			const error = e as Error;
			setOutcome({
				ok: false,
				text: error instanceof RemoteError && error.type ? `${error.type}: ${error.message}` : error.message,
				details: error instanceof RemoteError ? error.traceback : undefined,
			});
		} finally {
			setBusy(false);
		}
	}

	return (
		<form
			className="flex flex-wrap items-center gap-2"
			data-testid={`action-${device}-${action.name}`}
			onSubmit={(e) => {
				e.preventDefault();
				void run();
			}}
		>
			<span className="font-mono text-sm" title={action.doc ?? undefined}>
				{action.name}
			</span>
			{action.params.map((p) =>
				p.type === 'bool' ? (
					<label key={p.name} className="flex items-center gap-1 text-sm">
						<input
							type="checkbox"
							checked={Boolean(values[p.name])}
							onChange={(e) => setValues({ ...values, [p.name]: e.target.checked })}
						/>
						{p.name}
					</label>
				) : (
					<input
						key={p.name}
						aria-label={p.name}
						placeholder={p.name}
						type={p.type === 'int' || p.type === 'float' ? 'number' : 'text'}
						step="any"
						className="w-28 rounded border border-zinc-300 bg-transparent px-2 py-1 text-sm dark:border-slate-700"
						value={String(values[p.name] ?? '')}
						onChange={(e) => setValues({ ...values, [p.name]: e.target.value })}
					/>
				),
			)}
			<button className="rounded bg-brand px-3 py-1 text-sm text-white disabled:opacity-50" disabled={busy}>
				Run
			</button>
			{outcome && (
				<span
					role="status"
					data-testid={`result-${device}-${action.name}`}
					className={`text-sm ${outcome.ok ? 'text-emerald-700 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}
				>
					{outcome.text}
				</span>
			)}
			{outcome?.details && (
				<details className="w-full text-xs text-zinc-500">
					<summary>Traceback</summary>
					<pre className="overflow-x-auto">{outcome.details}</pre>
				</details>
			)}
		</form>
	);
}

/** The generated widget: shows any device from its schema, state and status. */
export function DeviceCard({ id, info }: { id: string; info: DeviceInfo }) {
	const ready = info.status === 'ready';
	return (
		<section data-testid={`device-${id}`} className="rounded-lg bg-white p-4 shadow dark:bg-slate-900">
			<div className="mb-2 flex items-center gap-2">
				<h2 className="font-mono text-lg">{id}</h2>
				{info.schema && <span className="text-sm text-zinc-500">{info.schema.class}</span>}
				<span className="flex-1" />
				<span
					data-testid={`status-${id}`}
					className={`rounded-full px-2 py-0.5 text-xs ${STATUS_STYLE[info.status] ?? STATUS_STYLE.stopped}`}
				>
					{info.status}
				</span>
			</div>
			{info.schema?.doc && <p className="mb-2 text-sm text-zinc-500">{info.schema.doc}</p>}
			{info.error && (
				<pre data-testid={`error-${id}`} className="mb-2 overflow-x-auto rounded bg-red-50 p-2 text-xs text-red-800 dark:bg-red-950 dark:text-red-300">
					{info.error}
				</pre>
			)}
			{info.state && (
				<div className={`mb-3 text-sm ${ready ? '' : 'opacity-50'}`}>
					<Value id={id} path="" value={info.state} />
				</div>
			)}
			<div className={`flex flex-col gap-2 ${ready ? '' : 'pointer-events-none opacity-50'}`}>
				{info.schema?.actions.map((action) => (
					<ActionRow key={action.name} device={id} action={action} />
				))}
			</div>
		</section>
	);
}
