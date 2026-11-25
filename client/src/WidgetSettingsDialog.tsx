import { useEffect, useRef, useState } from 'react';
import { buildProps, initialValues, LABEL, PropSpec, Values } from './settings';
import type { WidgetInstance } from './layout';

const FIELD = 'rounded border border-zinc-300 bg-transparent px-2 py-1 text-sm dark:border-slate-700';

/** The settings of one widget instance: the label every widget has, and what the widget declares (`props` of its definition or `meta`). */
export function WidgetSettingsDialog({ instance, title, specs, onSave, onClose }: { instance: WidgetInstance; title: string; specs: PropSpec[]; onSave: (props: Record<string, unknown>) => void; onClose: () => void }) {
	const dialog = useRef<HTMLDialogElement>(null);
	const all = [LABEL, ...specs];
	const [values, setValues] = useState<Values>(() => initialValues(all, instance.props));
	const [errors, setErrors] = useState<Record<string, string>>({});
	useEffect(() => dialog.current?.showModal(), []);

	function save() {
		const { props, errors } = buildProps(all, values, instance.props);
		setErrors(errors);
		if (Object.keys(errors).length > 0) return;
		onSave(props);
		dialog.current?.close();
	}

	return (
		<dialog ref={dialog} data-testid="widget-settings" onClose={onClose} className="m-auto w-full max-w-md rounded-lg bg-white p-5 text-zinc-900 shadow-xl backdrop:bg-black/40 dark:bg-slate-900 dark:text-zinc-100">
			<form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); save(); }}>
				<h2 className="text-lg font-semibold">{title}{instance.device ? <span className="ml-2 font-mono text-sm font-normal text-zinc-500">{instance.device}</span> : null}</h2>
				{all.map((spec) => (
					<div key={spec.name} className="flex flex-col gap-0.5">
						<label className="text-sm" htmlFor={`prop-${spec.name}`}>{spec.label ?? spec.name}</label>
						{spec.type === 'boolean' ? (
							<input id={`prop-${spec.name}`} data-testid={`prop-${spec.name}`} type="checkbox" className="h-4 w-4" checked={values[spec.name] === true} onChange={(e) => setValues({ ...values, [spec.name]: e.target.checked })} />
						) : spec.type === 'select' ? (
							<select id={`prop-${spec.name}`} data-testid={`prop-${spec.name}`} className={FIELD} value={String(values[spec.name])} onChange={(e) => setValues({ ...values, [spec.name]: e.target.value })}>
								{(spec.options ?? []).map((o) => <option key={o}>{o}</option>)}
							</select>
						) : (
							<input id={`prop-${spec.name}`} data-testid={`prop-${spec.name}`} className={FIELD} autoFocus={spec.name === 'label'} value={String(values[spec.name])} placeholder={spec.default === undefined ? '' : `default: ${String(spec.default)}`} onChange={(e) => setValues({ ...values, [spec.name]: e.target.value })} />
						)}
						{spec.help && <span className="text-xs text-zinc-500">{spec.help}</span>}
						{errors[spec.name] && <span role="alert" className="text-xs text-red-600">{spec.label ?? spec.name} {errors[spec.name]}</span>}
					</div>
				))}
				<div className="mt-1 flex justify-end gap-2">
					<button type="button" className="rounded px-3 py-1 text-sm hover:bg-zinc-100 dark:hover:bg-slate-800" onClick={() => dialog.current?.close()}>Cancel</button>
					<button data-testid="settings-save" className="rounded bg-brand px-3 py-1 text-sm text-white">Save</button>
				</div>
			</form>
		</dialog>
	);
}
