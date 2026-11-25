import { useEffect, useState } from 'react';
import { api, McpInfo, McpToken } from './api';
import { Section, TABLE } from './Section';
import { useStore } from './store';
import { Button, IconButton, Input, Segmented } from './ui';

const MODES = [
	{ value: 'off', label: 'Off', title: 'No AI client can connect', testId: 'ai-mode-off' },
	{ value: 'read_only', label: 'Read-only', title: 'AI clients can look at the experiment (state, logs, history), not change it', testId: 'ai-mode-read_only' },
	{ value: 'control', label: 'Control', title: 'AI clients can also act: call actions, run procedures, record', testId: 'ai-mode-control' },
] as const;

/** A command in a box with a button that copies it. */
function CopyBlock({ testId, text, note }: { testId: string; text: string; note?: string }) {
	const [copied, setCopied] = useState(false);
	return (
		<div className="mt-2">
			{note && <p className="mb-1 text-xs text-muted">{note}</p>}
			<div className="flex items-start gap-2 rounded-md bg-ground p-2.5">
				<pre data-testid={testId} className="min-w-0 flex-1 overflow-x-auto whitespace-pre-wrap break-all font-mono text-xs">{text}</pre>
				<IconButton small icon="copy" label="Copy" onClick={() => void navigator.clipboard.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }, () => undefined)} />
				{copied && <span className="text-xs text-good">Copied</span>}
			</div>
		</div>
	);
}

const isLoopback = (address: string) => /^https?:\/\/(localhost|127\.|\[::1\])/i.test(address);

/** What AI clients (Claude and others, over MCP) may do, and how to connect one: on this computer with one click when the browser runs on the
 *  server's computer, on another computer with a command. The server enforces the mode for every call; tokens are shown once and can be revoked. */
export function AiAccessPanel() {
	const { epoch } = useStore();
	const [info, setInfo] = useState<McpInfo | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState<string | null>(null);
	const [done, setDone] = useState<string | null>(null);
	const [label, setLabel] = useState('');
	const [tokenMode, setTokenMode] = useState<'read_only' | 'control'>('control');
	const [address, setAddress] = useState('');
	const [created, setCreated] = useState<McpToken | null>(null);

	const refresh = () => api.getMcp().then((i) => { setInfo(i); setAddress((a) => a || i.url); setError(null); }, (e: Error) => setError(e.message));
	useEffect(() => void refresh(), [epoch]); // eslint-disable-line react-hooks/exhaustive-deps

	async function run(what: string, action: () => Promise<unknown>) {
		setBusy(what);
		setError(null);
		try {
			await action();
		} catch (e) {
			setError((e as Error).message);
		} finally {
			setBusy(null);
			await refresh();
		}
	}

	const base = (address || info?.url || '').replace(/\/+$/, '');
	const mcp = `${base}/mcp`;
	const token = created?.token ?? '';
	const installMode = info?.mode === 'control' ? 'control' : 'read_only';
	return (
		<Section
			testId="ai-access"
			title="AI access"
			description="Lets an AI client such as Claude read the experiment and, if you allow it, act on it, through MCP. The server decides what each connection may do; nothing is open until you switch it on."
		>
			<div className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3">
				<span className="text-sm text-muted">AI clients may</span>
				<Segmented<'off' | 'read_only' | 'control'> label="AI access" value={info?.mode ?? 'off'} options={[...MODES]} disabled={!info} onChange={(mode) => void run('mode', () => api.setMcpMode(mode))} />
				<span className="text-xs text-faint">{info?.mode === 'control' ? 'They can change settings, move things and record. Everything they do is in the event log as mcp:<name>.' : info?.mode === 'read_only' ? 'They can look, not change anything.' : 'Nothing can connect.'}</span>
			</div>

			{info?.local && (
				<div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3">
					<span className="text-sm">On this computer:</span>
					<Button data-testid="ai-install-claude-code" disabled={busy !== null} onClick={() => void run('claude-code', async () => setDone((await api.installMcp('claude-code', installMode)).output))}>Set up Claude Code</Button>
					<Button data-testid="ai-install-claude-desktop" disabled={busy !== null} onClick={() => void run('claude-desktop', async () => setDone((await api.installMcp('claude-desktop', installMode)).output))}>Set up Claude Desktop</Button>
					<span className="text-xs text-faint">Makes a token and writes it into the program’s settings (mode: {installMode === 'control' ? 'control' : 'read-only'}; switches AI access on if it is off).</span>
				</div>
			)}
			{done && <pre data-testid="ai-installed" className="whitespace-pre-wrap border-b border-line bg-good/10 px-4 py-3 text-sm">{done}</pre>}

			{(info?.tokens.length ?? 0) > 0 && (
				<table className={TABLE}>
					<thead><tr><th>Connection</th><th>Mode</th><th>Created</th><th /></tr></thead>
					<tbody>
						{info!.tokens.map((t) => (
							<tr key={t.id} data-testid={`ai-token-${t.id}`}>
								<td className="font-medium">{t.label}</td>
								<td className="text-muted">{t.mode === 'control' ? 'control' : 'read-only'}</td>
								<td className="text-muted">{new Date(t.created * 1000).toLocaleString()}</td>
								<td className="text-right">
									<IconButton icon="trash" variant="danger" label={`Revoke ${t.label}`} onClick={() => { if (window.confirm(`Revoke "${t.label}"? That AI client cannot connect again.`)) void run('revoke', () => api.revokeToken(t.id)); }} />
								</td>
							</tr>
						))}
					</tbody>
				</table>
			)}

			<form className="flex flex-wrap items-center gap-2 border-t border-line px-4 py-3" onSubmit={(e) => { e.preventDefault(); void run('create', async () => setCreated(await api.createMcpToken(label, tokenMode))); setLabel(''); }}>
				<span className="text-sm">Connect another computer:</span>
				<Input data-testid="ai-token-label" aria-label="Name of the connection" placeholder="Name, e.g. Anna’s notebook" className="w-56" value={label} onChange={(e) => setLabel(e.target.value)} />
				<Segmented<'read_only' | 'control'> label="Mode of the connection" value={tokenMode} options={[{ value: 'read_only', label: 'Read-only', testId: 'ai-token-mode-read_only' }, { value: 'control', label: 'Control', testId: 'ai-token-mode-control' }]} onChange={setTokenMode} />
				<Button data-testid="ai-token-create" disabled={busy !== null}>Create connection</Button>
			</form>

			{created && (
				<div data-testid="ai-created" className="border-t border-line bg-warn/10 px-4 py-3 text-sm">
					<p className="font-medium">Copy what you need now: the token is not shown again.</p>
					<div className="mt-2 flex flex-wrap items-center gap-2">
						<label className="text-xs text-muted" htmlFor="ai-address">Address of this server, as the other computer reaches it</label>
						<Input id="ai-address" data-testid="ai-address" className="w-72" value={address} onChange={(e) => setAddress(e.target.value)} />
					</div>
					{isLoopback(base) && <p className="mt-1 text-xs text-warn">This address only works on this computer: use the name or address of the lab PC, e.g. https://lab-pc:5095.</p>}
					{!isLoopback(base) && base.startsWith('http://') && <p className="mt-1 text-xs text-warn">Not encrypted: outside this computer the token travels in the clear. Use https (TLS) and never expose this to the internet.</p>}
					<CopyBlock testId="ai-cmd-installer" note="On the other computer (sets up Claude Code and Claude Desktop where they are installed; needs uv):" text={`uvx --from laborchestra laborchestra mcp install --url ${base} --token ${token} --bridge uvx`} />
					<CopyBlock testId="ai-cmd-claude" note="Or only Claude Code, without installing anything:" text={`claude mcp add --transport http --scope user laborchestra ${mcp} --header "Authorization: Bearer ${token}"`} />
					<CopyBlock testId="ai-cmd-mcpjson" note="Or in a project (.mcp.json; the token stays in an environment variable):" text={`{ "mcpServers": { "laborchestra": { "type": "http", "url": "${mcp}", "headers": { "Authorization": "Bearer \${LABORCHESTRA_MCP_TOKEN}" } } } }\nLABORCHESTRA_MCP_TOKEN=${token}`} />
					<p className="mt-2 text-xs text-muted">Until laborchestra is published, install it from the LabOrchestra folder instead (pip install ./python) and use <code className="font-mono">laborchestra mcp install …</code> without uvx.</p>
					<Button variant="ghost" className="mt-2" onClick={() => setCreated(null)}>Hide</Button>
				</div>
			)}
			{error && <p role="alert" className="border-t border-line px-4 py-3 text-sm text-bad">{error}</p>}
		</Section>
	);
}
