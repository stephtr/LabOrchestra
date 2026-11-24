// Browser, script and device against the real server. Needs: pnpm build (client), dotnet build -c Release (server),
// and the python package installed in the interpreter given by LABORCHESTRA_PYTHON.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const win = process.platform === 'win32';
const python =
	process.env.LABORCHESTRA_PYTHON ?? path.join(root, 'python/.venv', win ? 'Scripts/python.exe' : 'bin/python');
const dll = path.join(root, 'server/LabOrchestra.Server/bin/Release/net11.0/LabOrchestra.Server.dll');
const PASSPHRASE = 'e2e-passphrase';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lo-e2e-'));
fs.mkdirSync(path.join(dir, 'workspace/devices'), { recursive: true });
fs.copyFileSync(path.join(root, 'workspace/devices/demo_pressure.py'), path.join(dir, 'workspace/devices/demo_pressure.py'));
fs.writeFileSync(
	path.join(dir, 'workspace/devices.json'),
	JSON.stringify({ devices: { pressure: { file: 'devices/demo_pressure.py', config: { noise: 0 } } } }),
);
const port = await new Promise((resolve) => {
	const s = net.createServer().listen(0, '127.0.0.1', () => {
		const p = s.address().port;
		s.close(() => resolve(p));
	});
});
const url = `http://127.0.0.1:${port}`;

function startServer() {
	const process_ = spawn('dotnet', [dll, '--urls', url], {
		env: {
			...process.env,
			LABORCHESTRA_WORKSPACE: path.join(dir, 'workspace'),
			LABORCHESTRA_PYTHON: python,
			LABORCHESTRA_PASSPHRASE: PASSPHRASE,
			LABORCHESTRA_DATA_DIR: path.join(dir, 'data'),
		},
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	let log = '';
	process_.stdout.on('data', (d) => (log += d));
	process_.stderr.on('data', (d) => (log += d));
	process_.log = () => log;
	return process_;
}
async function waitForServer() {
	for (let i = 0; ; i++) {
		try {
			await fetch(url);
			return;
		} catch {
			if (i > 150) throw new Error('server did not start');
			await new Promise((r) => setTimeout(r, 200));
		}
	}
}
const script = (code) =>
	execFileSync(python, ['-c', `import laborchestra, time\nlab = laborchestra.connect()\n${code}`], {
		env: { ...process.env, LABORCHESTRA_URL: url, LABORCHESTRA_TOKEN: PASSPHRASE },
		encoding: 'utf8',
	}).trim();
const ok = (m) => console.log('ok  ', m);

let server = startServer();
let browser;
let failed = true;
try {
	await waitForServer();
	browser = await chromium.launch(process.env.CI ? { channel: 'chrome' } : {});
	const page = await browser.newPage();
	page.setDefaultTimeout(15000);
	page.on('pageerror', (e) => console.log('  pageerror', e.message));
	const text = (testId) => page.getByTestId(testId).textContent();
	const waitText = (testId, expected) =>
		page.waitForFunction(
			([id, exp]) => document.querySelector(`[data-testid="${id}"]`)?.textContent === exp,
			[testId, expected],
		);
	const run = async (action, values) => {
		const form = page.getByTestId(`action-pressure-${action}`);
		for (const [name, value] of Object.entries(values)) await form.getByLabel(name).fill(String(value));
		await form.getByRole('button', { name: 'Run' }).click();
	};

	await page.goto(`${url}/#token=wrong`);
	await page.getByRole('alert').waitFor();
	assert.match(await page.getByRole('alert').textContent(), /not accepted/);
	ok('wrong token shows the login form');

	await page.goto(`${url}/#token=${PASSPHRASE}`);
	await waitText('status-pressure', 'ready');
	assert.equal(await text('connection'), 'connected');
	assert.equal(await text('state-pressure-channels.0.pressure'), '0.037');
	assert.ok(!page.url().includes('token'), 'token is removed from the address');
	ok('device card with status and state; token removed from the address');

	await run('set_pressure', { channel: 0, pressure: 0.0123 });
	await waitText('result-pressure-set_pressure', 'done');
	await waitText('state-pressure-channels.0.pressure', '0.0123');
	ok('action from the browser changes the state');

	await run('set_pressure', { channel: 9, pressure: 1 });
	await page.waitForFunction(() => document.querySelector('[data-testid="result-pressure-set_pressure"]')?.textContent !== 'done');
	assert.match(await text('result-pressure-set_pressure'), /ValueError: There is no channel 9/);
	ok('error with its type reaches the browser');

	assert.equal(script("print(lab.pressure.state['channels'][0]['pressure'])"), '0.0123');
	script('lab.pressure.set_pressure(0, 0.0456)');
	await waitText('state-pressure-channels.0.pressure', '0.0456');
	ok('script and browser see the same state, both directions');

	const pid = Number(await text('state-pressure-process_id'));
	process.kill(pid, 'SIGKILL');
	await page.waitForFunction(() => document.querySelector('[data-testid="status-pressure"]')?.textContent !== 'ready');
	await waitText('status-pressure', 'ready');
	assert.notEqual(Number(await text('state-pressure-process_id')), pid);
	ok('killed worker: status leaves "ready" and returns with a new process');

	server.kill('SIGTERM');
	await page.waitForFunction(() => document.querySelector('[data-testid="connection"]')?.textContent === 'reconnecting');
	server = startServer();
	await waitText('connection', 'connected');
	await waitText('status-pressure', 'ready');
	assert.equal(await text('state-pressure-channels.0.pressure'), '0.037'); // fresh state from the new server
	ok('server restart: the page reconnects and shows the new state');

	failed = false;
	console.log('OK');
} catch (e) {
	console.error(e);
	console.error('--- server log ---\n' + server.log());
} finally {
	await browser?.close();
	server.kill('SIGTERM');
	await new Promise((r) => setTimeout(r, 1500));
	fs.rmSync(dir, { recursive: true, force: true });
	process.exit(failed ? 1 : 0);
}
