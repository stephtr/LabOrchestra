import { useState } from 'react';
import { buildProps, initialValues, LABEL, PropSpec, Values } from './settings';
import type { WidgetInstance } from './layout';
import { Button, Dialog, DialogBody, DialogFooter, FormRow, Input, Select } from './ui';

/** The settings of one widget instance: the label every widget has, and what the widget declares (`props` of its definition or `meta`). */
export function WidgetSettingsDialog({ instance, title, specs, onSave, onClose }: { instance: WidgetInstance; title: string; specs: PropSpec[]; onSave: (props: Record<string, unknown>) => void; onClose: () => void }) {
	// a widget of a channel takes the channel's name from the device (rename it there); the label stays for the others, and for a view that has one
	const named = specs.some((s) => s.name === 'channel') && !instance.props?.label;
	const all = named ? specs : [LABEL, ...specs];
	const [values, setValues] = useState<Values>(() => initialValues(all, instance.props));
	const [errors, setErrors] = useState<Record<string, string>>({});

	function save(close: () => void) {
		const { props, errors } = buildProps(all, values, instance.props);
		setErrors(errors);
		if (Object.keys(errors).length > 0) return;
		onSave(props);
		close();
	}

	return (
		<Dialog title={<>{title}{instance.device && <span className="ml-2 font-normal text-muted">{instance.device}</span>}</>} testId="widget-settings" width="max-w-md" onClose={onClose}>
			{(close) => (
				<form className="flex min-h-0 flex-col" onSubmit={(e) => { e.preventDefault(); save(close); }}>
					<DialogBody>
						{all.map((spec) => {
							const shared = { id: `prop-${spec.name}`, 'data-testid': `prop-${spec.name}` };
							const error = errors[spec.name] && `${spec.label ?? spec.name} ${errors[spec.name]}`;
							if (spec.type === 'boolean')
								return (
									<label key={spec.name} className="flex items-center gap-2 text-sm">
										<input {...shared} type="checkbox" className="size-4" checked={values[spec.name] === true} onChange={(e) => setValues({ ...values, [spec.name]: e.target.checked })} />
										{spec.label ?? spec.name}
									</label>
								);
							return (
								<FormRow key={spec.name} label={spec.label ?? spec.name} htmlFor={shared.id} hint={spec.help} error={error}>
									{spec.type === 'select' ? (
										<Select {...shared} value={String(values[spec.name])} onChange={(e) => setValues({ ...values, [spec.name]: e.target.value })}>
											{(spec.options ?? []).map((o) => <option key={o}>{o}</option>)}
										</Select>
									) : (
										<Input {...shared} autoFocus={spec.name === 'label'} value={String(values[spec.name])} placeholder={spec.default === undefined ? '' : `default: ${String(spec.default)}`} onChange={(e) => setValues({ ...values, [spec.name]: e.target.value })} />
									)}
								</FormRow>
							);
						})}
					</DialogBody>
					<DialogFooter>
						<Button type="button" variant="ghost" onClick={close}>Cancel</Button>
						<Button variant="primary" data-testid="settings-save">Save</Button>
					</DialogFooter>
				</form>
			)}
		</Dialog>
	);
}
