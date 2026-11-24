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
	const add = (d) => (log += `[${new Date().toISOString().slice(11, 23)}] ${String(d).replace(/\n$/, '').replace(/\n/g, '\n               ')}\n`);
	process_.stdout.on('data', add);
	process_.stderr.on('data', add);
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

	await page.getByTestId('device-pressure').getByText('Log', { exact: true }).click();
	const logs = page.getByTestId('logs-device:pressure');
	await logs.getByText('Demo gauge ready').waitFor();
	await logs.getByText(/Action set_pressure failed: ValueError/).waitFor();
	ok('log of the device is shown, live');

	assert.equal(script("print(lab.pressure.state['channels'][0]['pressure'])"), '0.0123');
	script('lab.pressure.set_pressure(0, 0.0456)');
	await waitText('state-pressure-channels.0.pressure', '0.0456');
	ok('script and browser see the same state, both directions');

	// branding
	assert.equal(await page.locator('link[rel=icon]').getAttribute('href'), '/favicon.svg');
	assert.equal((await fetch(`${url}/favicon.svg`)).status, 200);
	assert.equal(await page.getByAltText('LabOrchestra').count(), 2); // the light and the dark logo; CSS shows one
	ok('logo and favicon');

	// device management
	const devicesFile = () => JSON.parse(fs.readFileSync(path.join(dir, 'workspace/devices.json'), 'utf8')).devices;
	await page.getByTestId('nav-devices').click();
	await page.getByTestId('row-pressure').waitFor();
	assert.match(page.url(), /\/devices$/);
	await page.getByTestId('add-device').click();
	const dialog = page.getByTestId('device-dialog');
	await dialog.getByTestId('field-id').fill('second_gauge');
	await dialog.getByTestId('field-file').selectOption('devices/demo_pressure.py');
	await dialog.getByTestId('option-noise').waitFor(); // the form comes from the options of the file
	await dialog.locator('#opt-noise').fill('0');
	await dialog.getByTestId('save-device').click();
	await dialog.waitFor({ state: 'detached' });
	await waitText('row-status-second_gauge', 'ready');
	assert.deepEqual(devicesFile().second_gauge, { file: 'devices/demo_pressure.py', config: { noise: 0 } });
	ok('device added through the dialog: starts, and devices.json has it');

	await page.getByTestId('add-device').click();
	await dialog.getByTestId('field-id').fill('second_gauge');
	await dialog.getByTestId('field-file').selectOption('devices/demo_pressure.py');
	await dialog.getByTestId('option-noise').waitFor();
	await dialog.getByTestId('save-device').click();
	await dialog.getByTestId('dialog-error').waitFor();
	assert.match(await dialog.getByTestId('dialog-error').textContent(), /already a device/);
	await dialog.getByTestId('field-id').fill('Bad-Id');
	await dialog.getByTestId('save-device').click();
	assert.match(await dialog.getByTestId('dialog-error').textContent(), /snake_case/);
	await dialog.getByRole('button', { name: 'Cancel' }).click();
	await dialog.waitFor({ state: 'detached' });
	ok('mistakes are explained in the dialog');

	await page.getByTestId('edit-second_gauge').click();
	await dialog.locator('#opt-noise').waitFor();
	assert.equal(await dialog.locator('#opt-noise').inputValue(), '0'); // shows what devices.json has
	await dialog.locator('#opt-noise').fill('0.25');
	await dialog.getByLabel('Description (optional)').fill('second one');
	await dialog.getByTestId('save-device').click();
	await dialog.waitFor({ state: 'detached' });
	assert.deepEqual(devicesFile().second_gauge, { file: 'devices/demo_pressure.py', config: { noise: 0.25 }, description: 'second one' });
	await waitText('row-status-second_gauge', 'ready');
	ok('device changed through the dialog');

	await page.getByLabel('Secret name').fill('demo_key');
	await page.getByLabel('Secret value').fill('hunter2');
	await page.getByRole('button', { name: 'Save secret' }).click();
	await page.getByTestId('secret-demo_key').waitFor();
	assert.ok(!(await page.content()).includes('hunter2'), 'the value of a secret is never shown');
	await page.getByTestId('secret-demo_key').getByRole('button', { name: 'Delete' }).click();
	await page.getByTestId('secret-demo_key').waitFor({ state: 'detached' });
	ok('secrets: set (value not shown) and deleted');

	page.once('dialog', (d) => d.accept());
	await page.getByTestId('remove-second_gauge').click();
	await page.getByTestId('row-second_gauge').waitFor({ state: 'detached' });
	assert.ok(!('second_gauge' in devicesFile()) && 'pressure' in devicesFile());
	ok('device removed');

	// the simulated oscilloscope: a C# driver, added through the dialog, shown with its own widget
	await page.getByTestId('add-device').click();
	await dialog.getByTestId('kind-driver').check();
	await dialog.getByTestId('field-driver').selectOption('simulated_oscilloscope');
	await dialog.getByTestId('field-id').fill('scope');
	await dialog.getByTestId('option-noise').waitFor(); // the options of the driver
	await dialog.getByTestId('save-device').click();
	await dialog.waitFor({ state: 'detached' });
	assert.deepEqual(devicesFile().scope, { driver: 'simulated_oscilloscope' });
	await page.getByTestId('nav-dashboard').click();
	const canvas = page.getByTestId('osc-canvas');
	await canvas.waitFor();
	const frameCount = async () => Number(await page.getByTestId('osc-frames').textContent());
	await page.waitForFunction(() => Number(document.querySelector('[data-testid="osc-frames"]')?.textContent) >= 5);
	assert.equal(await canvas.getAttribute('data-mode'), 'fft');
	assert.equal(await canvas.getAttribute('data-channels'), '0,1');
	const blue = () => canvas.evaluate((el) => {
		const d = el.getContext('2d').getImageData(0, 0, el.width, el.height).data;
		let n = 0;
		for (let i = 0; i < d.length; i += 4) if (d[i + 2] > 150 && d[i] < 100) n++; // the colour of channel 1
		return n;
	});
	assert.ok((await blue()) > 200, 'the trace of channel 1 is drawn');
	const before = await frameCount();
	await page.waitForTimeout(2500); // more than the frames that may be on their way unacknowledged: they keep coming
	assert.ok((await frameCount()) - before >= 30, 'frames keep arriving');
	ok('oscilloscope: added through the dialog, spectrum is drawn and keeps updating');

	await page.getByTestId('osc-mode-time').click();
	await page.waitForFunction(() => document.querySelector('[data-testid="osc-canvas"]')?.dataset.mode === 'time');
	await page.getByTestId('osc-mode-fft').click();
	await page.waitForFunction(() => document.querySelector('[data-testid="osc-canvas"]')?.dataset.mode === 'fft');
	await page.getByTestId('osc-fft-length').selectOption('1024');
	await page.waitForFunction(() => document.querySelector('[data-testid="osc-canvas"]')?.dataset.fftLength === '1024');
	await page.getByTestId('osc-fft-length').selectOption('8192');
	await page.getByTestId('osc-channel-2').click();
	await page.waitForFunction(() => document.querySelector('[data-testid="osc-canvas"]')?.dataset.channels === '0,1,2');
	await page.getByTestId('osc-channel-2').click();
	await page.waitForFunction(() => document.querySelector('[data-testid="osc-canvas"]')?.dataset.channels === '0,1');
	ok('oscilloscope controls: time trace / FFT, FFT length, channels');

	await page.waitForFunction(() => document.querySelector('[data-testid="osc-canvas"]')?.dataset.fftLength === '8192');
	const full = await page.getByTestId('osc-range').textContent();
	await canvas.hover();
	await page.mouse.wheel(0, -400);
	await page.waitForFunction((r) => document.querySelector('[data-testid="osc-range"]')?.textContent !== r, full);
	const zoomed = await page.getByTestId('osc-range').textContent();
	const length = Number(await canvas.getAttribute('data-length'));
	assert.ok(zoomed !== full && length > 0);
	await canvas.dblclick();
	await page.waitForFunction((r) => document.querySelector('[data-testid="osc-range"]')?.textContent === r, full);
	ok(`zoom asks the server for the range (${zoomed}) and double click goes back (${full})`);

	await page.getByTestId('osc-run').click();
	await page.getByRole('button', { name: 'Start' }).waitFor();
	await page.waitForTimeout(700);
	const framesWhenStopped = await frameCount();
	await page.waitForTimeout(1000);
	assert.ok((await frameCount()) - framesWhenStopped <= 1, 'no frames while stopped');
	await page.getByTestId('osc-run').click();
	await page.getByRole('button', { name: 'Stop' }).waitFor();
	await page.waitForFunction((n) => Number(document.querySelector('[data-testid="osc-frames"]')?.textContent) > n + 10, framesWhenStopped);
	ok('stop and start');

	await page.getByTestId('nav-dashboard').click();
	await page.getByTestId('device-pressure').waitFor();

	const pid = Number(await text('state-pressure-process_id'));
	process.kill(pid, 'SIGKILL');
	await page.waitForFunction(() => document.querySelector('[data-testid="status-pressure"]')?.textContent !== 'ready');
	await waitText('status-pressure', 'ready');
	assert.notEqual(Number(await text('state-pressure-process_id')), pid);
	ok('killed worker: status leaves "ready" and returns with a new process');

	const stopped = new Promise((resolve) => server.once('exit', resolve));
	server.kill('SIGTERM');
	await page.waitForFunction(() => document.querySelector('[data-testid="connection"]')?.textContent === 'reconnecting');
	await stopped; // the new server needs the port
	server = startServer();
	page.setDefaultTimeout(60000); // a slow machine needs time to start a server
	await waitText('connection', 'connected');
	await waitText('status-pressure', 'ready');
	assert.equal(await text('state-pressure-channels.0.pressure'), '0.037'); // fresh state from the new server
	const afterRestart = await frameCount();
	await page.waitForFunction((n) => Number(document.querySelector('[data-testid="osc-frames"]')?.textContent) > n + 20, afterRestart);
	ok('oscilloscope: the stream is subscribed again after the server restarted');
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
