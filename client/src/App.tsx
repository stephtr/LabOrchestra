import { useState } from 'react';
import { DeviceCard } from './DeviceCard';
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

export default function App() {
	const { connection, devices, info, loginError } = useStore();
	if (connection === 'login') return <Login error={loginError} />;
	const ids = Object.keys(devices).sort();
	return (
		<div className="mx-auto max-w-5xl p-4">
			<header className="mb-4 flex items-center gap-3">
				<h1 className="text-xl font-semibold text-brand dark:text-gold">LabOrchestra</h1>
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
			{connection === 'connected' && ids.length === 0 && (
				<p className="text-zinc-500" data-testid="no-devices">
					No devices configured. The workspace is <code className="font-mono">{info?.workspace}</code>
					{info?.devices_file ? ', and its devices.json lists no devices.' : ', and it has no devices.json yet.'} Start the server with{' '}
					<code className="font-mono">--workspace &lt;folder&gt;</code> to use another one.
				</p>
			)}
			<div className="grid gap-4 md:grid-cols-2">
				{ids.map((id) => (
					<DeviceCard key={id} id={id} info={devices[id]!} />
				))}
			</div>
		</div>
	);
}
