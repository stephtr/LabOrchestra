import { useState } from 'react';
import logoDark from '../../docs/assets/laborchestra-logo-dark.svg';
import logoLight from '../../docs/assets/laborchestra-logo-light.svg';
import { Dashboard } from './Dashboard';
import { DevicesPage } from './DevicesPage';
import { navigate, usePath } from './router';
import { login, logout, useStore } from './store';

function Login({ error }: { error: string | null }) {
	const [token, setToken] = useState('');
	return (
		<form
			className="mx-auto mt-24 flex max-w-sm flex-col gap-3 rounded-lg bg-white p-6 shadow dark:bg-slate-900"
			onSubmit={(e) => {
				e.preventDefault();
				void login(token);
			}}
		>
			<h1 className="text-xl font-semibold">Sign in</h1>
			<p className="text-sm text-zinc-500">
				Enter the access token. The server prints a login link with it when it starts.
			</p>
			<input
				className="rounded border border-zinc-300 bg-transparent px-3 py-2 dark:border-slate-700"
				type="password"
				autoFocus
				placeholder="Access token"
				aria-label="Access token"
				value={token}
				onChange={(e) => setToken(e.target.value)}
			/>
			{error && <p role="alert" className="text-sm text-red-600">{error}</p>}
			<button className="rounded bg-brand px-3 py-2 font-medium text-white disabled:opacity-50" disabled={!token.trim()}>
				Sign in
			</button>
		</form>
	);
}

function NavLink({ to, children }: { to: string; children: string }) {
	const path = usePath();
	const active = to === '/' ? path === '/' || path.startsWith('/views') : path.startsWith(to);
	return (
		<a
			href={to}
			data-testid={`nav-${to === '/' ? 'dashboard' : to.slice(1)}`}
			aria-current={active ? 'page' : undefined}
			className={`rounded px-2 py-1 text-sm ${active ? 'bg-brand text-white' : 'text-zinc-600 hover:bg-zinc-200 dark:text-zinc-300 dark:hover:bg-slate-800'}`}
			onClick={(e) => {
				e.preventDefault();
				navigate(to);
			}}
		>
			{children}
		</a>
	);
}

export default function App() {
	const { connection, loginError } = useStore();
	const path = usePath();
	if (connection === 'login') return <Login error={loginError} />;
	return (
		<div className={path.startsWith('/devices') ? 'mx-auto max-w-5xl p-4' : 'flex h-screen flex-col'}>
			<header className={`flex flex-none items-center gap-3 ${path.startsWith('/devices') ? 'mb-4' : 'px-2 py-1'}`}>
				<img src={logoLight} alt="LabOrchestra" className="h-8 dark:hidden" />
				<img src={logoDark} alt="LabOrchestra" className="hidden h-8 dark:block" />
				<nav className="ml-3 flex gap-1">
					<NavLink to="/">Dashboard</NavLink>
					<NavLink to="/devices">Devices</NavLink>
				</nav>
				<span
					data-testid="connection"
					className={`rounded-full px-2 py-0.5 text-xs ${connection === 'connected' ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300' : 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300'}`}
				>
					{connection}
				</span>
				<span className="flex-1" />
				<button className="text-sm text-zinc-500 hover:underline" onClick={logout}>
					Sign out
				</button>
			</header>
			{path.startsWith('/devices') ? <DevicesPage /> : <Dashboard />}
		</div>
	);
}
