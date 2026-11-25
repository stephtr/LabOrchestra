import { useEffect, useRef, useState } from 'react';
import { api, DeviceFile, DriverInfo, PackageContents, PythonInfo } from './api';
import { Param, Schema } from './store';

type OptionValue = { text: string; checked: boolean; touched: boolean; secret: string | null };
const FIELD = 'rounded border border-zinc-300 bg-transparent px-2 py-1 text-sm dark:border-slate-700';
const SNAKE = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;

const secretName = (v: unknown): string | null =>
	v !== null && typeof v === 'object' && 'secret' in v ? String((v as { secret: unknown }).secret) : null;

function initialValues(schema: Schema, config: Record<string, unknown> | null): Record<string, OptionValue> {
	return Object.fromEntries(
		schema.config.map((p) => {
			const value = config?.[p.name];
			const secret = secretName(value);
			const text = value === undefined || secret !== null || typeof value === 'boolean' ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
			return [p.name, { text, checked: typeof value === 'boolean' ? value : Boolean(p.default), touched: typeof value === 'boolean', secret }];
		}),
	);
}

/** The options the user filled in; what was left empty stays at the default of the device. */
function buildConfig(schema: Schema, values: Record<string, OptionValue>, kept: Record<string, unknown>): Record<string, unknown> {
	const config: Record<string, unknown> = { ...kept };
	for (const p of schema.config) {
		const v = values[p.name];
		if (!v) continue;
		if (v.secret !== null) {
			if (!v.secret) throw new Error(`Choose the secret for "${p.name}"`);
			config[p.name] = { secret: v.secret };
		} else if (p.type === 'bool') {
			if (v.touched || p.required) config[p.name] = v.checked;
		} else if (v.text.trim() === '') {
			if (p.required) throw new Error(`"${p.name}" is required`);
		} else if (p.type === 'int' || p.type === 'float') {
			const number = Number(v.text);
			if (Number.isNaN(number) || (p.type === 'int' && !Number.isInteger(number))) throw new Error(`"${p.name}" must be ${p.type === 'int' ? 'a whole number' : 'a number'}`);
			config[p.name] = number;
		} else if (p.type === 'json') {
			try {
				config[p.name] = JSON.parse(v.text);
			} catch {
				throw new Error(`"${p.name}" must be JSON`);
			}
		} else {
			config[p.name] = v.text;
		}
	}
	return config;
}

function OptionField({ param, value, secrets, onChange }: { param: Param; value: OptionValue; secrets: string[]; onChange: (v: OptionValue) => void }) {
	const placeholder = param.required ? 'required' : param.default === null || param.default === undefined ? 'default' : `default: ${JSON.stringify(param.default)}`;
	return (
		<div className="flex flex-wrap items-center gap-2" data-testid={`option-${param.name}`}>
			<label className="w-40 font-mono text-sm" htmlFor={`opt-${param.name}`}>
				{param.name}
				{param.required && <span title="required"> *</span>}
			</label>
			{value.secret !== null ? (
				<select id={`opt-${param.name}`} className={FIELD} value={value.secret} onChange={(e) => onChange({ ...value, secret: e.target.value })}>
					<option value="">choose a secret…</option>
					{secrets.map((s) => (
						<option key={s}>{s}</option>
					))}
				</select>
			) : param.type === 'bool' ? (
				<input id={`opt-${param.name}`} type="checkbox" checked={value.checked} onChange={(e) => onChange({ ...value, checked: e.target.checked, touched: true })} />
			) : (
				<input
					id={`opt-${param.name}`}
					className={`${FIELD} w-56`}
					type={param.type === 'int' || param.type === 'float' ? 'number' : 'text'}
					step="any"
					placeholder={placeholder}
					value={value.text}
					onChange={(e) => onChange({ ...value, text: e.target.value })}
				/>
			)}
			{param.type !== 'bool' && (
				<button
					type="button"
					className="text-xs text-zinc-500 hover:underline disabled:opacity-40"
					disabled={value.secret === null && secrets.length === 0}
					title={secrets.length === 0 ? 'Create a secret first (below the device list)' : undefined}
					onClick={() => onChange({ ...value, secret: value.secret === null ? '' : null })}
				>
					{value.secret === null ? 'use a secret' : 'use a value'}
				</button>
			)}
		</div>
	);
}

/** Add a device (deviceId null) or change one: choose the file, fill in the options the file offers. */
export function DeviceDialog({ deviceId, onClose }: { deviceId: string | null; onClose: () => void }) {
	const editing = deviceId !== null;
	const dialog = useRef<HTMLDialogElement>(null);
	const saved = useRef<Record<string, unknown> | null>(null); // the options now in devices.json (when changing)
	const [id, setId] = useState(deviceId ?? '');
	const [kind, setKind] = useState<'file' | 'driver' | 'remote' | 'package'>('file');
	const [file, setFile] = useState('');
	const [driver, setDriver] = useState('');
	const [drivers, setDrivers] = useState<DriverInfo[]>([]);
	const [python, setPython] = useState('');
	const [pythons, setPythons] = useState<PythonInfo[]>([]);
	useEffect(() => void api.listPythons().then(setPythons, () => setPythons([])), []);
	const [description, setDescription] = useState('');
	const [files, setFiles] = useState<DeviceFile[]>([]);
	const [secrets, setSecrets] = useState<string[]>([]);
	const [schema, setSchema] = useState<Schema | null>(null);
	const [describing, setDescribing] = useState(false);
	const [values, setValues] = useState<Record<string, OptionValue>>({});
	const [error, setError] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	const [pkg, setPkg] = useState('');
	const [pkgEntry, setPkgEntry] = useState('');
	const [contents, setContents] = useState<PackageContents | null>(null);

	useEffect(() => {
		dialog.current?.showModal();
		void Promise.all([api.listDeviceFiles(), api.listSecrets(), api.listDrivers()]).then(([f, s, d]) => {
			setFiles(f);
			setSecrets(s);
			setDrivers(d);
		}, (e: Error) => setError(e.message));
		if (deviceId !== null) {
			void api.getDeviceConfig(deviceId).then((entry) => {
				saved.current = entry.config;
				setPython(entry.python ?? '');
				setDescription(entry.description ?? '');
				setKind(entry.remote ? 'remote' : entry.package ? 'package' : entry.driver ? 'driver' : 'file');
				setPkg(entry.package ?? '');
				setPkgEntry(entry.entry ?? '');
				setDriver(entry.driver ?? '');
				setFile(entry.file ?? '');
			}, (e: Error) => setError(e.message));
		}
	}, [deviceId]);

	const chosen = kind === 'file' ? file : kind === 'driver' ? driver : '';

	/** Looks into the package: builds its environment the first time (that can take a while) and shows what it offers. */
	async function lookInside(entry: string | null) {
		setError(null);
		setDescribing(true);
		setSchema(null);
		try {
			const found = await api.describePackage(pkg.trim(), entry, python.trim() || null);
			setContents(found);
			setPkgEntry(found.entry ?? '');
			if (found.schema) {
				setSchema(found.schema);
				setValues(initialValues(found.schema, editing && saved.current ? saved.current : null));
			}
		} catch (e) {
			setContents(null);
			setError((e as Error).message);
		} finally {
			setDescribing(false);
		}
	}
	useEffect(() => {
		if (kind === 'package' && editing && pkg && !contents) void lookInside(pkgEntry || null);
	}, [kind, editing, pkg]); // eslint-disable-line react-hooks/exhaustive-deps
	useEffect(() => {
		if (!chosen) return;
		let current = true;
		setDescribing(true);
		setSchema(null);
		setError(null);
		(kind === 'file' ? api.describeDeviceFile(chosen) : api.describeDriver(chosen)).then(
			(described) => {
				if (!current) return;
				setSchema(described);
				setValues(initialValues(described, editing && saved.current ? saved.current : null));
				setDescribing(false);
			},
			(e: Error) => {
				if (!current) return;
				setError(e.message);
				setDescribing(false);
			},
		);
		return () => {
			current = false;
		};
	}, [kind, chosen, editing]);

	// options in devices.json that the file does not offer are kept as they are
	const kept = Object.fromEntries(Object.entries(saved.current ?? {}).filter(([k]) => schema && !schema.config.some((p) => p.name === k)));

	async function save() {
		setError(null);
		if (!SNAKE.test(id)) return setError('The id must be snake_case: lowercase letters, digits and underscores');
		if (kind === 'package' && (!pkg.trim() || !pkgEntry || !schema)) return setError('Look inside the package and choose one of its devices');
		if (kind !== 'remote' && kind !== 'package' && (!chosen || !schema)) return setError(kind === 'file' ? 'Choose a device file' : 'Choose a driver');
		setSaving(true);
		try {
			const config = schema ? buildConfig(schema, values, kept) : {};
			const entry =
				kind === 'remote'
					? { remote: true, description: description.trim() || null }
					: kind === 'package'
						? { package: pkg.trim(), entry: pkgEntry, python: python.trim() || null, config: Object.keys(config).length ? config : null, description: description.trim() || null }
						: {
							...(kind === 'file' ? { file, python: python.trim() || null } : { driver }),
							config: Object.keys(config).length ? config : null,
							description: description.trim() || null,
						};
			await (editing ? api.updateDevice(id, entry) : api.addDevice(id, entry));
			dialog.current?.close();
		} catch (e) {
			setError((e as Error).message);
		} finally {
			setSaving(false);
		}
	}

	return (
		<dialog
			ref={dialog}
			data-testid="device-dialog"
			onClose={onClose}
			className="m-auto w-full max-w-xl rounded-lg bg-white p-5 text-zinc-900 shadow-xl backdrop:bg-black/40 dark:bg-slate-900 dark:text-zinc-100"
		>
			<form
				className="flex flex-col gap-3"
				onSubmit={(e) => {
					e.preventDefault();
					void save();
				}}
			>
				<h2 className="text-lg font-semibold">{editing ? `Change ${deviceId}` : 'Add a device'}</h2>
				<div className="flex flex-wrap items-center gap-2">
					<label className="w-40 text-sm" htmlFor="device-id">Id</label>
					<input id="device-id" data-testid="field-id" className={`${FIELD} w-56 font-mono`} value={id} disabled={editing} placeholder="e.g. vacuum_pressure" onChange={(e) => setId(e.target.value)} />
				</div>
				<div className="flex flex-wrap items-center gap-3 text-sm" role="radiogroup" aria-label="Kind of device">
					<span className="w-40">Kind</span>
					<label className="flex items-center gap-1">
						<input type="radio" name="kind" data-testid="kind-file" checked={kind === 'file'} disabled={editing} onChange={() => { setKind('file'); setSchema(null); }} /> Python file
					</label>
					<label className="flex items-center gap-1">
						<input type="radio" name="kind" data-testid="kind-driver" checked={kind === 'driver'} disabled={editing} onChange={() => { setKind('driver'); setSchema(null); }} /> C# driver
					</label>
					<label className="flex items-center gap-1" title="A device that an installed Python package offers (entry point laborchestra.devices)">
						<input type="radio" name="kind" data-testid="kind-package" checked={kind === 'package'} disabled={editing} onChange={() => { setKind('package'); setSchema(null); }} /> Python package
					</label>
					<label className="flex items-center gap-1" title="The device runs in a worker on another machine, which connects with a token">
						<input type="radio" name="kind" data-testid="kind-remote" checked={kind === 'remote'} disabled={editing} onChange={() => { setKind('remote'); setSchema(null); }} /> Remote worker
					</label>
				</div>
				{kind === 'package' ? (
					<div className="flex flex-col gap-2">
						<div className="flex flex-wrap items-center gap-2">
							<label className="w-40 text-sm" htmlFor="device-package">Package</label>
							<input id="device-package" data-testid="field-package" className={`${FIELD} w-72 font-mono`} value={pkg} disabled={editing} placeholder="laborchestra-elliptec==1.2, or a folder" onChange={(e) => { setPkg(e.target.value); setContents(null); setSchema(null); }} />
							<button type="button" data-testid="look-inside" className="rounded bg-zinc-200 px-2 py-1 text-sm disabled:opacity-50 dark:bg-slate-800" disabled={!pkg.trim() || describing} onClick={() => void lookInside(null)}>Look inside</button>
						</div>
						{contents && (
							<div className="flex flex-col gap-1 text-sm" data-testid="package-contents">
								<div className="flex flex-wrap items-center gap-2">
									<label className="w-40" htmlFor="device-entry">Device</label>
									<select id="device-entry" data-testid="field-entry" className={`${FIELD} w-72`} value={pkgEntry} disabled={editing} onChange={(e) => { setPkgEntry(e.target.value); void lookInside(e.target.value); }}>
										<option value="">choose…</option>
										{contents.devices.map((d) => <option key={d.name} value={d.name}>{d.name} ({d.package} {d.version})</option>)}
									</select>
								</div>
								{contents.devices.length === 0 && <p className="text-amber-700 dark:text-amber-400">This package offers no devices (entry point group laborchestra.devices).</p>}
								{contents.widgets.length > 0 && <p className="text-zinc-500">It also brings widgets: {contents.widgets.map((w) => w.name).join(', ')}. They appear in the picker once the device is added.</p>}
							</div>
						)}
					</div>
				) : kind === 'remote' ? (
					<p className="text-sm text-zinc-500">The device runs in a worker on another machine. After adding it, create a token for it under “Remote workers” on this page.</p>
				) : kind === 'file' ? (
					<div className="flex flex-wrap items-center gap-2">
						<label className="w-40 text-sm" htmlFor="device-file">Device file</label>
						<select id="device-file" data-testid="field-file" className={`${FIELD} w-72`} value={file} disabled={editing} onChange={(e) => setFile(e.target.value)}>
							<option value="">choose…</option>
							{files.map((f) => (
								<option key={f.file} value={f.file}>
									{f.file}
									{f.devices.length > 0 ? `  (used by ${f.devices.join(', ')})` : ''}
								</option>
							))}
						</select>
					</div>
				) : (
					<div className="flex flex-wrap items-center gap-2">
						<label className="w-40 text-sm" htmlFor="device-driver">Driver</label>
						<select id="device-driver" data-testid="field-driver" className={`${FIELD} w-72`} value={driver} disabled={editing} onChange={(e) => setDriver(e.target.value)}>
							<option value="">choose…</option>
							{drivers.map((d) => (
								<option key={d.driver} value={d.driver} title={d.doc ?? undefined}>
									{d.driver}
								</option>
							))}
						</select>
					</div>
				)}
				{describing && <p className="text-sm text-zinc-500" data-testid="describing">Loading what {kind === 'package' ? 'the package' : 'the file'} offers… (the first time it may need to set up an environment)</p>}
				{schema && (
					<>
						{schema.doc && <p className="text-sm text-zinc-500">{schema.doc}</p>}
						<div className="flex flex-col gap-2 border-l border-zinc-300 pl-3 dark:border-slate-700">
							{schema.config.length === 0 && <p className="text-sm text-zinc-500">This device has no options.</p>}
							{schema.config.map((p) => (
								<OptionField
									key={p.name}
									param={p}
									secrets={secrets}
									value={values[p.name] ?? { text: '', checked: false, touched: false, secret: null }}
									onChange={(v) => setValues({ ...values, [p.name]: v })}
								/>
							))}
							{Object.keys(kept).length > 0 && (
								<p className="text-xs text-amber-700 dark:text-amber-400">
									Not offered by this file, kept as they are: {Object.keys(kept).join(', ')}
								</p>
							)}
						</div>
					</>
				)}
				{(kind === 'file' || kind === 'package') && (
					<div className="flex flex-wrap items-center gap-2">
						<label className="w-40 text-sm" htmlFor="device-python">Python (optional)</label>
						<input id="device-python" list="pythons" className={`${FIELD} w-56`} value={python} placeholder='a version such as "3.12", or a path' onChange={(e) => setPython(e.target.value)} />
						<datalist id="pythons">
							{pythons.map((p) => (
								<option key={p.path} value={p.path}>{`${p.implementation ?? 'Python'} ${p.version}`}</option>
							))}
						</datalist>
					</div>
				)}
				<div className="flex flex-wrap items-center gap-2">
					<label className="w-40 text-sm" htmlFor="device-description">Description (optional)</label>
					<input id="device-description" className={`${FIELD} w-72`} value={description} onChange={(e) => setDescription(e.target.value)} />
				</div>
				{error && <p role="alert" data-testid="dialog-error" className="whitespace-pre-wrap text-sm text-red-600">{error}</p>}
				<div className="mt-2 flex justify-end gap-2">
					<button type="button" className="rounded px-3 py-1 text-sm hover:bg-zinc-100 dark:hover:bg-slate-800" onClick={() => dialog.current?.close()}>
						Cancel
					</button>
					<button data-testid="save-device" className="rounded bg-brand px-3 py-1 text-sm text-white disabled:opacity-50" disabled={saving || describing || (kind !== 'remote' && !schema)}>
						{editing ? 'Save' : 'Add device'}
					</button>
				</div>
			</form>
		</dialog>
	);
}
