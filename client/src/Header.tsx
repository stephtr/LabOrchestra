import { ReactNode, useEffect, useState } from 'react';
import logoDark from '../../docs/assets/laborchestra-logo-dark.svg';
import logoLight from '../../docs/assets/laborchestra-logo-light.svg';
import { navigate, usePath } from './router';
import { isService, logout, runIsActive, useStore } from './store';
import { Icon, IconButton } from './ui';

function NavLink({ to, children }: { to: string; children: string }) {
	const path = usePath();
	const active = to === '/' ? path === '/' || path.startsWith('/views') : path.startsWith(to);
	return (
		<a
			href={to}
			data-testid={`nav-${to === '/' ? 'dashboard' : to.slice(1)}`}
			aria-current={active ? 'page' : undefined}
			className={`inline-flex h-8 items-center rounded-md px-2.5 text-sm ${active ? 'bg-raised text-ink' : 'text-muted hover:text-ink'}`}
			onClick={(e) => {
				e.preventDefault();
				navigate(to);
			}}
		>
			{children}
		</a>
	);
}

/** Seconds since the start of the recording, while there is one. */
export function useRecordingTime(): string | null {
	const { recording } = useStore();
	const [now, setNow] = useState(Date.now());
	useEffect(() => {
		if (!recording.active) return;
		setNow(Date.now());
		const timer = setInterval(() => setNow(Date.now()), 500);
		return () => clearInterval(timer);
	}, [recording.active]);
	if (!recording.active || !recording.start_time) return null;
	const s = Math.max(0, Math.round((now - Date.parse(recording.start_time)) / 1000));
	const h = Math.floor(s / 3600);
	return `${h > 0 ? `${h}:` : ''}${String(Math.floor(s / 60) % 60).padStart(h > 0 ? 2 : 1, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/** The one bar of every page: logo, pages, what the page puts there (the views), and what is always worth knowing (recording, connection). */
export function Header({ children, actions }: { children?: ReactNode; actions?: ReactNode }) {
	const { connection, recording, runs, devices } = useStore();
	const failing = Object.entries(devices).filter(([, d]) => isService(d) && (d.status === 'error' || d.status === 'degraded'));
	const running = Object.values(runs).filter(runIsActive);
	const time = useRecordingTime();
	return (
		<header className="flex min-h-12 flex-none flex-wrap items-center gap-x-3 gap-y-1 border-b border-line bg-panel px-3 py-1.5">
			<img src={logoLight} alt="LabOrchestra" className="h-7 dark:hidden" />
			<img src={logoDark} alt="LabOrchestra" className="hidden h-7 dark:block" />
			{children}
			<span className="flex-1" />
			{time && (
				<span data-testid="recording-indicator" className="inline-flex items-center gap-1.5 rounded-md bg-bad/10 px-2 py-1 text-sm tabular-nums text-bad" title={`Recording “${recording.name}”`}>
					<Icon name="record" size={12} className="animate-pulse" /> {time}
				</span>
			)}
			{failing.length > 0 && (
				<a
					href="/devices"
					data-testid="service-warning"
					className="inline-flex items-center gap-1.5 rounded-md bg-bad/10 px-2 py-1 text-sm text-bad hover:bg-bad/20"
					title={failing.map(([id, d]) => `${id}: ${d.status}`).join('\n')}
					onClick={(e) => {
						e.preventDefault();
						navigate('/devices');
					}}
				>
					<Icon name="warning" size={13} />
					{failing.length === 1 ? `${failing[0]![0]} is not working` : `${failing.length} services are not working`}
				</a>
			)}
			{running.length > 0 && (
				<a
					href="/procedures"
					data-testid="run-indicator"
					className="inline-flex items-center gap-1.5 rounded-md bg-accent/15 px-2 py-1 text-sm text-accent hover:bg-accent/25"
					title={running.map((r) => r.procedure).join(', ')}
					onClick={(e) => {
						e.preventDefault();
						navigate('/procedures');
					}}
				>
					<Icon name={running.some((r) => r.status === 'paused') ? 'stop' : 'play'} size={11} />
					{running[0]!.procedure.replaceAll('_', ' ')}
					{running[0]!.progress?.total ? <span className="tabular-nums">{running[0]!.progress!.done}/{running[0]!.progress!.total}</span> : null}
					{running.length > 1 ? <span>+{running.length - 1}</span> : null}
				</a>
			)}
			{actions}
			{(children || actions) && <span className="h-5 w-px bg-line" />}
			<nav className="flex gap-0.5" aria-label="Pages">
				<NavLink to="/">Dashboard</NavLink>
				<NavLink to="/procedures">Procedures</NavLink>
				<NavLink to="/devices">Devices</NavLink>
			</nav>
			<span className={`inline-flex items-center gap-1.5 text-xs ${connection === 'connected' ? 'text-faint' : 'rounded-md bg-warn/15 px-2 py-1 text-warn'}`} title={`Server: ${connection}`}>
				<span className={`size-1.5 rounded-full ${connection === 'connected' ? 'bg-good' : 'animate-pulse bg-warn'}`} />
				<span data-testid="connection" className={connection === 'connected' ? 'sr-only' : ''}>{connection}</span>
			</span>
			<IconButton icon="logout" label="Sign out" onClick={logout} />
		</header>
	);
}
