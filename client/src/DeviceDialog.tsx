import { useEffect, useRef, useState } from 'react';
import { Button, Dialog, DialogBody, DialogFooter, ErrorText, FormRow, Input, Segmented, Select } from './ui';
import { api, DeviceFile, DriverInfo, PackageContents, PythonInfo } from './api';
import { Param, Schema } from './store';

type OptionValue = { text: string; checked: boolean; touched: boolean; secret: string | null };
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
	const inputId = `opt-${param.name}`;
	if (param.type === 'bool')
		return (
			<label className="flex items-center gap-2 h-8 self-end font-mono text-xs" data-testid={`option-${param.name}`}>
				<input id={inputId} type="checkbox" className="size-4" checked={value.checked} onChange={(e) => onChange({ ...value, checked: e.target.checked, touched: true })} />
				{param.name}
			</label>
		);
	return (
		<div className="flex min-w-0 flex-col gap-1" data-testid={`option-${param.name}`}>
			<div className="flex items-baseline justify-between gap-2 text-xs">
				<label className="truncate font-mono text-muted" htmlFor={inputId}>
					{param.name}
					{param.required && <span className="text-bad" title="required"> *</span>}
				</label>
				{(secrets.length > 0 || value.secret !== null) && (
					<button type="button" className="flex-none text-faint hover:text-ink" onClick={() => onChange({ ...value, secret: value.secret === null ? '' : null })}>
						{value.secret === null ? 'use a secret' : 'use a value'}
					</button>
				)}
			</div>
			{value.secret !== null ? (
				<Select id={inputId} value={value.secret} onChange={(e) => onChange({ ...value, secret: e.target.value })}>
					<option value="">choose a secret…</option>
					{secrets.map((s) => <option key={s}>{s}</option>)}
				</Select>
			) : (
				<Input id={inputId} type={param.type === 'int' || param.type === 'float' ? 'number' : 'text'} step="any" placeholder={placeholder} value={value.text} onChange={(e) => onChange({ ...value, text: e.target.value })} />
			)}
		</div>
	);
}

/** Add a device (deviceId null) or change one: choose the file, fill in the options the file offers. */
export function DeviceDialog({ deviceId, onClose }: { deviceId: string | null; onClose: () => void }) {
	const editing = deviceId !== null;
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

	async function save(close: () => void) {
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
			close();
		} catch (e) {
			setError((e as Error).message);
		} finally {
			setSaving(false);
		}
	}

	const KINDS = [
		{ value: 'file', label: 'Python file', title: 'A device file of the workspace', testId: 'kind-file' },
		{ value: 'package', label: 'Package', title: 'A device that a Python package offers (entry point laborchestra.devices)', testId: 'kind-package' },
		{ value: 'driver', label: 'C# driver', title: 'A driver of the server or of a plugin', testId: 'kind-driver' },
		{ value: 'remote', label: 'Remote', title: 'The device runs in a worker on another machine, which connects with a token', testId: 'kind-remote' },
	] as const;
	return (
		<Dialog title={editing ? `Change ${deviceId}` : 'Add a device'} testId="device-dialog" onClose={onClose}>
			{(close) => (
				<form className="flex min-h-0 flex-col" onSubmit={(e) => { e.preventDefault(); void save(close); }}>
					<DialogBody>
						{!editing && <Segmented label="Kind of device" value={kind} options={[...KINDS]} onChange={(k) => { setKind(k); setSchema(null); }} />}
						{!editing && (
							<FormRow label="Id" htmlFor="device-id">
								<Input id="device-id" data-testid="field-id" value={id} placeholder="e.g. vacuum_pressure" onChange={(e) => setId(e.target.value)} />
							</FormRow>
						)}
						{kind === 'remote' && <p className="text-sm text-muted">The device runs in a worker on another machine. After adding it, create a token for it under “Remote workers”.</p>}
						{kind === 'file' && (
							<FormRow label="Device file" htmlFor="device-file">
								<Select id="device-file" data-testid="field-file" value={file} disabled={editing} onChange={(e) => setFile(e.target.value)}>
									<option value="">choose…</option>
									{files.map((f) => <option key={f.file} value={f.file}>{f.file}{f.devices.length > 0 ? `  (used by ${f.devices.join(', ')})` : ''}</option>)}
								</Select>
							</FormRow>
						)}
						{kind === 'driver' && (
							<FormRow label="Driver" htmlFor="device-driver">
								<Select id="device-driver" data-testid="field-driver" value={driver} disabled={editing} onChange={(e) => setDriver(e.target.value)}>
									<option value="">choose…</option>
									{drivers.map((d) => <option key={d.driver} value={d.driver} title={d.doc ?? undefined}>{d.driver}</option>)}
								</Select>
							</FormRow>
						)}
						{kind === 'package' && (
							<>
								<FormRow label="Package" htmlFor="device-package">
									<span className="flex gap-2">
										<Input id="device-package" data-testid="field-package" className="flex-1 font-mono" value={pkg} disabled={editing} placeholder="laborchestra-elliptec==1.2, or a folder" onChange={(e) => { setPkg(e.target.value); setContents(null); setSchema(null); }} />
										<Button type="button" data-testid="look-inside" icon="search" disabled={!pkg.trim() || describing} onClick={() => void lookInside(null)}>Look inside</Button>
									</span>
								</FormRow>
								{contents && (
									<div className="flex flex-col gap-2 text-sm" data-testid="package-contents">
										<FormRow label="Device" htmlFor="device-entry">
											<Select id="device-entry" data-testid="field-entry" value={pkgEntry} disabled={editing} onChange={(e) => { setPkgEntry(e.target.value); void lookInside(e.target.value); }}>
												<option value="">choose…</option>
												{contents.devices.map((d) => <option key={d.name} value={d.name}>{d.name} ({d.package} {d.version})</option>)}
											</Select>
										</FormRow>
										{contents.devices.length === 0 && <p className="text-warn">This package offers no devices (entry point group laborchestra.devices).</p>}
										{contents.widgets.length > 0 && <p className="text-xs text-faint">It also brings widgets: {contents.widgets.map((w) => w.name).join(', ')}. You find them under “Add widget” once the device is added.</p>}
									</div>
								)}
							</>
						)}
						{describing && <p className="text-sm text-muted" data-testid="describing">Loading what {kind === 'package' ? 'the package' : 'the file'} offers… (the first time it may need to set up an environment)</p>}
						{schema && (
							<fieldset className="flex flex-col gap-3 rounded-lg border border-line p-4">
								<legend className="px-1.5 text-xs text-muted">Options</legend>
								{schema.doc && <p className="text-sm text-muted">{schema.doc}</p>}
								{schema.config.length === 0 && <p className="text-sm text-faint">This device has no options.</p>}
								<div className="grid gap-x-4 gap-y-3 sm:grid-cols-2">
									{schema.config.map((p) => (
										<OptionField key={p.name} param={p} secrets={secrets} value={values[p.name] ?? { text: '', checked: false, touched: false, secret: null }} onChange={(v) => setValues({ ...values, [p.name]: v })} />
									))}
								</div>
								{Object.keys(kept).length > 0 && <p className="text-xs text-warn">Not offered by this file, kept as they are: {Object.keys(kept).join(', ')}</p>}
							</fieldset>
						)}
						{(kind === 'file' || kind === 'package') && (
							<FormRow label="Python (optional)" htmlFor="device-python">
								<Input id="device-python" list="pythons" value={python} placeholder='a version such as "3.12", or a path' onChange={(e) => setPython(e.target.value)} />
								<datalist id="pythons">
									{pythons.map((p) => <option key={p.path} value={p.path}>{`${p.implementation ?? 'Python'} ${p.version}`}</option>)}
								</datalist>
							</FormRow>
						)}
						<FormRow label="Description (optional)" htmlFor="device-description">
							<Input id="device-description" value={description} onChange={(e) => setDescription(e.target.value)} />
						</FormRow>
						{error && <ErrorText testId="dialog-error">{error}</ErrorText>}
					</DialogBody>
					<DialogFooter>
						<Button type="button" variant="ghost" onClick={close}>Cancel</Button>
						<Button variant="primary" data-testid="save-device" disabled={saving || describing || (kind !== 'remote' && !schema)}>{editing ? 'Save' : 'Add device'}</Button>
					</DialogFooter>
				</form>
			)}
		</Dialog>
	);
}
