import { ButtonHTMLAttributes, forwardRef, InputHTMLAttributes, ReactNode, SelectHTMLAttributes, useEffect, useRef } from 'react';

/** The building blocks of the interface: one look for buttons, fields, badges and dialogs. */

type Variant = 'primary' | 'default' | 'ghost' | 'danger';
const VARIANT: Record<Variant, string> = {
	primary: 'bg-brand text-white hover:bg-[#136a50] dark:bg-[#14694f] dark:hover:bg-[#1a8363]',
	default: 'bg-raised text-ink hover:bg-hover',
	ghost: 'text-muted hover:bg-raised hover:text-ink',
	danger: 'text-muted hover:bg-bad/10 hover:text-bad',
};
const BASE = 'inline-flex flex-none items-center justify-center gap-1.5 whitespace-nowrap rounded-md text-sm transition-colors disabled:pointer-events-none disabled:opacity-40';

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; icon?: IconName };

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button({ variant = 'default', icon, className = '', children, ...rest }, ref) {
	return (
		<button ref={ref} className={`${BASE} h-8 px-3 ${VARIANT[variant]} ${className}`} {...rest}>
			{icon && <Icon name={icon} />}
			{children}
		</button>
	);
});

/** A button that is only an icon: `label` is its name (tooltip and for screen readers). */
export function IconButton({ icon, label, variant = 'ghost', small = false, className = '', ...rest }: Omit<ButtonProps, 'children'> & { icon: IconName; label: string; small?: boolean }) {
	return (
		<button aria-label={label} title={label} className={`${BASE} ${small ? 'size-6' : 'size-8'} ${VARIANT[variant]} ${className}`} {...rest}>
			<Icon name={icon} size={small ? 14 : 16} />
		</button>
	);
}

const FIELD = 'h-8 min-w-0 rounded-md border border-line bg-field px-2.5 text-sm text-ink placeholder:text-faint disabled:opacity-50';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className = '', ...rest }, ref) {
	return <input ref={ref} className={`${FIELD} ${className}`} {...rest} />;
});

/** A select with our own arrow, so that it has the same height and look everywhere. */
export function Select({ className = '', children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
	return (
		<span className={`relative inline-flex min-w-0 ${className}`}>
			<select className={`${FIELD} w-full appearance-none pr-7`} {...rest}>
				{children}
			</select>
			<Icon name="chevron-down" size={14} className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-muted" />
		</span>
	);
}

/** A few choices of which one is active. */
export function Segmented<T extends string>({ value, options, onChange, label, disabled, testId }: { value: T; options: { value: T; label: string; title?: string; testId?: string }[]; onChange: (value: T) => void; label: string; disabled?: boolean; testId?: string }) {
	return (
		<span role="group" aria-label={label} data-testid={testId} className="inline-flex flex-none self-start rounded-md bg-raised p-0.5">
			{options.map((o) => (
				<button key={o.value} type="button" data-testid={o.testId} title={o.title} aria-pressed={value === o.value} disabled={disabled} onClick={() => onChange(o.value)}
					className={`h-7 rounded px-2.5 text-sm transition-colors disabled:opacity-40 ${value === o.value ? 'bg-panel text-ink shadow-sm dark:bg-hover' : 'text-muted hover:text-ink'}`}>
					{o.label}
				</button>
			))}
		</span>
	);
}

/** A label above a field, with an optional hint and error below. */
export function FormRow({ label, htmlFor, hint, error, children, testId, mono }: { label: ReactNode; htmlFor?: string; hint?: ReactNode; error?: ReactNode; children: ReactNode; testId?: string; mono?: boolean }) {
	return (
		<div className="flex min-w-0 flex-col gap-1" data-testid={testId}>
			<label className={`text-muted ${mono ? 'font-mono text-xs' : 'text-sm'}`} htmlFor={htmlFor}>{label}</label>
			{children}
			{hint && <span className="text-xs text-faint">{hint}</span>}
			{error && <span role="alert" className="text-xs text-bad">{error}</span>}
		</div>
	);
}

const TONE: Record<string, string> = { running: 'text-accent', paused: 'text-warn', aborting: 'text-warn', finished: 'text-good', failed: 'text-bad', aborted: 'text-warn', crashed: 'text-bad', ready: 'text-good', waiting: 'text-muted', preparing: 'text-accent', starting: 'text-warn', reconnecting: 'text-warn', degraded: 'text-warn', error: 'text-bad', stopped: 'text-faint' };

/** The status of a device: a dot and the word. */
export function StatusBadge({ status, testId, title, hidden }: { status: string; testId?: string; title?: string; hidden?: boolean }) {
	return (
		<span hidden={hidden} title={title} className={`inline-flex items-center gap-1.5 text-xs ${hidden ? 'hidden' : ''} ${TONE[status] ?? 'text-faint'}`}>
			<span className="size-1.5 rounded-full bg-current" />
			<span data-testid={testId}>{status}</span>
		</span>
	);
}

export function ErrorText({ children, testId }: { children: ReactNode; testId?: string }) {
	return <p role="alert" data-testid={testId} className="whitespace-pre-wrap break-words rounded-md bg-bad/10 px-3 py-2 text-sm text-bad">{children}</p>;
}

/** A modal dialog with a title and a close button; `onClose` is called however it is closed. */
export function Dialog({ title, testId, onClose, children, width = 'max-w-xl' }: { title: ReactNode; testId: string; onClose: () => void; children: (close: () => void) => ReactNode; width?: string }) {
	const ref = useRef<HTMLDialogElement>(null);
	useEffect(() => ref.current?.showModal(), []);
	const close = () => ref.current?.close();
	return (
		<dialog ref={ref} data-testid={testId} onClose={onClose} className={`m-auto max-h-[90vh] w-[calc(100%-2rem)] ${width} overflow-hidden rounded-xl border border-line bg-panel p-0 shadow-2xl backdrop:bg-black/50 open:flex open:flex-col`}>
			<header className="flex flex-none items-center gap-2 border-b border-line py-2 pl-5 pr-2">
				<h2 className="min-w-0 flex-1 truncate text-base font-semibold">{title}</h2>
				<IconButton icon="close" label="Close dialog" type="button" onClick={close} />
			</header>
			{children(close)}
		</dialog>
	);
}

export const DialogBody = ({ children }: { children: ReactNode }) => <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-4">{children}</div>;
export const DialogFooter = ({ children }: { children: ReactNode }) => <footer className="flex flex-none items-center justify-end gap-2 border-t border-line px-5 py-3">{children}</footer>;

// --- icons: 16x16 outlines, drawn with the colour of the text ------------------------------------------------------------
const ICONS = {
	close: 'M4 4l8 8M12 4l-8 8',
	plus: 'M8 3v10M3 8h10',
	minus: 'M3 8h10',
	check: 'M3 8.5l3.5 3.5L13 5',
	'chevron-down': 'M4 6l4 4 4-4',
	'chevron-right': 'M6 4l4 4-4 4',
	'chevron-left': 'M10 4l-4 4 4 4',
	settings: 'M2 4.5h6M12 4.5h2M2 11.5h2M8 11.5h6M10 2.8a1.7 1.7 0 1 0 0 3.4 1.7 1.7 0 0 0 0-3.4zM6 9.8a1.7 1.7 0 1 0 0 3.4 1.7 1.7 0 0 0 0-3.4z',
	edit: 'M3 13l.6-3L10.5 3l2.5 2.5L6 12.4 3 13z',
	copy: 'M6 6h7v7H6zM10 6V3H3v7h3',
	trash: 'M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5M7 7v3.5M9 7v3.5',
	grip: 'M6 4h.01M10 4h.01M6 8h.01M10 8h.01M6 12h.01M10 12h.01',
	restart: 'M13 8a5 5 0 1 1-1.5-3.5M13 2.5V5h-2.5',
	folder: 'M2 4.5h4l1.5 1.5H14V12.5H2z',
	code: 'M5.5 5L2.5 8l3 3M10.5 5l3 3-3 3',
	search: 'M7 2.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9zM10.5 10.5L14 14',
	camera: 'M2 5h3l1-1.5h4L11 5h3v8H2zM8 6.7a2.2 2.2 0 1 0 0 4.4 2.2 2.2 0 0 0 0-4.4z',
	logout: 'M6.5 3H3v10h3.5M7 8h7M11.5 5.5L14 8l-2.5 2.5',
	expand: 'M9.5 3H13v3.5M6.5 13H3V9.5M13 3L9 7M3 13l4-4',
	warning: 'M8 2.5L14.5 13.5h-13zM8 6.5v3.5M8 11.8h.01',
} as const;
const FILLED = { play: 'M4.5 3v10l8-5z', stop: 'M4 4h8v8H4z', record: 'M8 3.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9z' } as const;
export type IconName = keyof typeof ICONS | keyof typeof FILLED;

export function Icon({ name, size = 16, className = '' }: { name: IconName; size?: number; className?: string }) {
	const filled = name in FILLED;
	return (
		<svg aria-hidden="true" width={size} height={size} viewBox="0 0 16 16" className={`flex-none ${className}`} fill={filled ? 'currentColor' : 'none'} stroke={filled ? 'none' : 'currentColor'} strokeWidth={name === 'grip' ? 2 : 1.4} strokeLinecap="round" strokeLinejoin="round">
			<path d={filled ? FILLED[name as keyof typeof FILLED] : ICONS[name as keyof typeof ICONS]} />
		</svg>
	);
}
