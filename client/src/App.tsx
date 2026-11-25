import { useState } from 'react';
import logoDark from '../../docs/assets/laborchestra-logo-dark.svg';
import logoLight from '../../docs/assets/laborchestra-logo-light.svg';
import { Dashboard } from './Dashboard';
import { DevicesPage } from './DevicesPage';
import { ProceduresPage } from './ProceduresPage';
import { usePath } from './router';
import { login, useStore } from './store';
import { Button, ErrorText, FormRow, Input } from './ui';

function Login({ error }: { error: string | null }) {
	const [token, setToken] = useState('');
	return (
		<div className="flex min-h-screen items-center justify-center p-4">
			<form
				className="flex w-full max-w-sm flex-col gap-4 rounded-xl border border-line bg-panel p-6 shadow-lg"
				onSubmit={(e) => {
					e.preventDefault();
					void login(token);
				}}
			>
				<img src={logoLight} alt="LabOrchestra" className="h-9 self-start dark:hidden" />
				<img src={logoDark} alt="LabOrchestra" className="hidden h-9 self-start dark:block" />
				<FormRow label="Access token" htmlFor="token" hint="The server prints a login link that contains it when it starts.">
					<Input id="token" type="password" autoFocus value={token} onChange={(e) => setToken(e.target.value)} />
				</FormRow>
				{error && <ErrorText>{error}</ErrorText>}
				<Button variant="primary" disabled={!token.trim()}>Sign in</Button>
			</form>
		</div>
	);
}

export default function App() {
	const { connection, loginError } = useStore();
	const path = usePath();
	if (connection === 'login') return <Login error={loginError} />;
	return <div className="flex h-screen flex-col">{path.startsWith('/devices') ? <DevicesPage /> : path.startsWith('/procedures') ? <ProceduresPage /> : <Dashboard />}</div>;
}
