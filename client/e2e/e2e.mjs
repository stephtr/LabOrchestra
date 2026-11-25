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

// "Open in editor" starts a program on the server's computer: a stand-in that writes down what it was asked to open
const editorLog = path.join(dir, 'editor.log');
const editor = path.join(dir, win ? 'editor.cmd' : 'editor.sh');
fs.writeFileSync(editor, win ? `@echo %* > "${editorLog}"\r\n` : `#!/bin/sh\necho "$@" > "${editorLog}"\n`);
fs.chmodSync(editor, 0o755);

function startServer() {
	const process_ = spawn('dotnet', [dll, '--urls', url], {
		env: {
			...process.env,
			LABORCHESTRA_WORKSPACE: path.join(dir, 'workspace'),
			LABORCHESTRA_PYTHON: python,
			LABORCHESTRA_PASSPHRASE: PASSPHRASE,
			LABORCHESTRA_DATA_DIR: path.join(dir, 'data'),
			LABORCHESTRA_EDITOR: editor,
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

// a device package for the "Python package" kind: installed (editable) into the interpreter the e2e server uses, which is named explicitly
const packageDir = path.join(root, 'python/tests/packages/lab_test_pkg');
try {
	execFileSync(python, ['-c', 'import lab_test_pkg'], { stdio: 'ignore' });
} catch {
	try {
		execFileSync('uv', ['pip', 'install', '--quiet', '--python', python, '--editable', packageDir], { stdio: 'inherit' });
	} catch {
		execFileSync(python, ['-m', 'pip', 'install', '--quiet', '--editable', packageDir], { stdio: 'inherit' });
	}
}

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
	// adds a widget from the panel: the panel is closed again, because its previews are real widgets with the same test ids
	const GENERIC = ['summary', 'device_card', 'ws:status_tile', 'pkg:packaged_tile'];
	const openPicker = async () => {
		if ((await page.getByTestId('picker').count()) === 0) await page.getByTestId('add-widget').click();
	};
	const addWidget = async (type, device, channel) => {
		await openPicker();
		if (GENERIC.includes(type)) {
			await page.getByTestId(`add-${type}`).click();
			await page.getByTestId('pick-device').selectOption(device);
			await page.getByTestId('pick-add').click();
		} else await page.getByTestId(['add', type, device, channel].filter((x) => x !== undefined).join('-')).click();
		await page.getByLabel('Close panel').click();
	};
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
	assert.equal(await text('unit-pressure-channels.0.pressure'), 'mbar'); // the unit comes from the profile
	assert.equal(await text('profile-pressure-pressure_sensor'), 'pressure_sensor');
	ok('units and profiles from the schema are shown');

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

	// an error in the page reaches the server's log
	const readLogs = () => {
		const folder = path.join(dir, 'data', 'logs');
		return fs.existsSync(folder) ? fs.readdirSync(folder, { recursive: true }).map((f) => { try { return fs.readFileSync(path.join(folder, String(f)), 'utf8'); } catch { return ''; } }).join('\n') : '';
	};
	const waitUntil = async (condition, what, seconds = 15) => {
		for (let i = 0; i < seconds * 10; i++) { if (condition()) return; await page.waitForTimeout(100); }
		throw new Error(`Timed out waiting for ${what}`);
	};
	await page.evaluate(() => setTimeout(() => { throw new Error('boom from the e2e test'); }, 0));
	await waitUntil(() => readLogs().includes('boom from the e2e test'), 'the page error in the server log');
	ok('errors of the page are reported to the server');

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

	// "New device": a file from a template, registered, running simulated
	await page.getByTestId('new-device').click();
	await page.getByTestId('template-frequency_generator').check();
	await page.getByTestId('new-device-name').fill('Bad Name');
	await page.getByTestId('create-device').click();
	assert.match(await text('dialog-error'), /snake_case/);
	await page.getByTestId('new-device-name').fill('gen_one');
	await page.getByTestId('new-device-connection').selectOption('tcp');
	await page.getByTestId('create-device').click();
	await page.getByTestId('new-device-done').waitFor();
	assert.match(await text('new-device-path'), /gen_one\.py$/);
	const made = path.join(dir, 'workspace/devices/gen_one.py');
	assert.ok(fs.existsSync(made) && fs.readFileSync(made, 'utf8').includes('class GenOne(Device)') && fs.readFileSync(made, 'utf8').includes('tcp_port'));
	assert.equal(devicesFile().gen_one.file, 'devices/gen_one.py');
	await page.getByTestId('new-device-done').getByTestId('open-editor-devices/gen_one.py').click();
	for (let i = 0; i < 50 && !(fs.existsSync(editorLog) && fs.readFileSync(editorLog, 'utf8').includes('gen_one.py')); i++) await new Promise((r) => setTimeout(r, 100));
	assert.ok(fs.readFileSync(editorLog, 'utf8').includes('gen_one.py'), 'the editor was asked to open the new file');
	ok('"Open in editor" starts the configured editor with the new file');
	await page.getByRole('button', { name: 'Done' }).click();
	await waitText('row-status-gen_one', 'ready');
	ok('new device from a template: file written, registered, running simulated');
	page.once('dialog', (d) => d.accept());
	await page.getByTestId('remove-gen_one').click();
	await page.getByTestId('row-gen_one').waitFor({ state: 'detached' });

	// a device that runs on another machine: added without a file, a token for its worker
	await page.getByTestId('add-device').click();
	const remoteDialog = page.getByTestId('device-dialog');
	await remoteDialog.getByTestId('kind-remote').click();
	await remoteDialog.getByTestId('field-id').fill('far_gauge');
	await remoteDialog.getByTestId('save-device').click();
	await remoteDialog.waitFor({ state: 'detached' });
	assert.equal(devicesFile().far_gauge.remote, true);
	await waitText('row-status-far_gauge', 'waiting');
	await page.getByTestId('token-label').fill('lab PC 2');
	await page.getByTestId('token-create').click();
	const command = await text('token-command');
	assert.match(command, /--id far_gauge .*--token lo_/);
	assert.ok(!fs.readFileSync(path.join(dir, 'data', 'tokens.json'), 'utf8').includes(command.split('--token ')[1].trim())); // only a hash is kept
	const tokenRow = page.locator('[data-testid^="token-"]', { hasText: 'lab PC 2' }).first();
	await tokenRow.waitFor();
	page.once('dialog', (d) => d.accept());
	await tokenRow.getByRole('button', { name: 'Revoke' }).click();
	await tokenRow.waitFor({ state: 'detached' });
	ok('remote worker: device without file, token shown once (hashed on disk), revoked');
	page.once('dialog', (d) => d.accept());
	await page.getByTestId('remove-far_gauge').click();
	await page.getByTestId('row-far_gauge').waitFor({ state: 'detached' });

	await page.getByTestId('environments').waitFor();
	assert.ok(await page.getByTestId('env-cleanup').isVisible());
	ok('environments are listed with their clean-up');

	// the simulated oscilloscope: a C# driver, added through the dialog, shown with its own widget
	await page.getByTestId('add-device').click();
	await dialog.getByTestId('kind-driver').click();
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
	const arrived = (await frameCount()) - before;
	assert.ok(arrived >= 8, `frames keep arriving (${arrived} in 2.5 s; a stalled stream would deliver a handful at most)`); // a slow CI runner draws slower than a laptop
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
	await page.getByLabel('Settings of channel 1').click();
	await page.getByLabel('Range of channel 1').selectOption('2000');
	await page.getByTestId('osc-settings').click();
	await page.getByLabel('Window function').selectOption('hann');
	await page.waitForFunction(() => true);
	for (let i = 0; i < 50 && script("print(lab.scope.state['channels'][0]['range_in_millivolts'], lab.scope.state['fft_window_function'])") !== '2000 hann'; i++) await new Promise((r) => setTimeout(r, 100));
	assert.equal(script("print(lab.scope.state['channels'][0]['range_in_millivolts'], lab.scope.state['fft_window_function'])"), '2000 hann');
	ok('channel range (under the arrow) and FFT settings (gear)');
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

	// views: the first view is made from the devices, then edited
	const viewFile = path.join(dir, 'workspace/views/dashboard.json');
	const readView = () => JSON.parse(fs.readFileSync(viewFile, 'utf8'));
	const waitView = async (check, what) => {
		for (let i = 0; i < 100; i++) {
			try {
				if (check(readView())) return readView();
			} catch {
				/* not written yet */
			}
			await new Promise((r) => setTimeout(r, 100));
		}
		throw new Error(`view file never showed: ${what}\n${fs.existsSync(viewFile) ? fs.readFileSync(viewFile, 'utf8') : '(no file)'}`);
	};
	await page.getByTestId('edit-toggle').click(); // "Edit layout": creates the view from the devices
	await page.getByTestId('strip').waitFor();
	let view = await waitView((v) => v.root?.kind === 'main' && v.strip.length === 1, 'oscilloscope pane and one summary');
	assert.equal(view.root.widget.type, 'oscilloscope');
	assert.equal(view.strip[0].type, 'summary');
	await page.getByTestId('summary-pressure').waitFor();
	await page.getByTestId('osc-canvas').waitFor();
	ok('first view is created from the devices: oscilloscope pane, summary in the strip');

	await addWidget('device_card', 'pressure');
	view = await waitView((v) => v.root?.kind === 'split' && v.root.children.length === 2, 'a second pane');
	assert.equal(view.root.dir, 'column');
	await page.getByTestId('device-pressure').waitFor();
	ok('a widget picked from the list becomes a second pane');

	// the gutter moves with the mouse and the size is stored
	const gutter = page.getByRole('separator').first();
	const box = await gutter.boundingBox();
	await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
	await page.mouse.down();
	await page.mouse.move(box.x + box.width / 2, box.y - 150, { steps: 8 });
	await page.mouse.up();
	view = await waitView((v) => Math.abs(v.root.sizes[0] - 50) > 5, 'resized panes');
	assert.ok(view.root.sizes[0] < 45, `the upper pane got smaller: ${view.root.sizes}`);
	assert.ok(Math.abs(view.root.sizes[0] + view.root.sizes[1] - 100) < 0.01);
	ok('the gutter can be dragged; the sizes are stored');

	// drag one pane to the side of the other: a row
	const handles = page.locator('[data-testid^="handle-"]');
	const target = page.locator('[data-testid^="pane-"]').first();
	const targetBox = await target.boundingBox();
	await handles.nth(1).dragTo(target, { targetPosition: { x: targetBox.width - 20, y: targetBox.height / 2 } });
	view = await waitView((v) => v.root?.kind === 'split' && v.root.dir === 'row', 'panes side by side');
	assert.equal(view.root.children.length, 2);
	ok('dropping on the right edge of a pane puts the dragged one next to it');

	// reorder in the strip
	await addWidget('summary', 'scope');
	view = await waitView((v) => v.strip.length === 2, 'two summaries');
	const order = view.strip.map((w) => w.device);
	const strip = page.locator('[data-testid^="strip-"]:not([data-testid="strip"])');
	await strip.nth(1).dragTo(strip.nth(0), { targetPosition: { x: 5, y: 10 } });
	view = await waitView((v) => v.strip[0].device === order[1], 'strip reordered');
	ok('summaries can be reordered in the strip');

	await page.getByTestId('edit-toggle').click(); // Done
	await page.reload();
	await page.getByTestId('summary-pressure').waitFor();
	await page.getByTestId('device-pressure').waitFor();
	assert.equal(await page.locator('[data-testid^="pane-"]').count(), 2);
	assert.equal(await page.getByRole('separator').count(), 1);
	ok('the layout survives a reload');

	// compact widgets: a pressure readout (labelled), the recording bar
	await page.getByTestId('edit-toggle').click();
	await addWidget('pressure', 'pressure', 0);
	await addWidget('recording');
	await page.getByTestId('pressure-value-pressure-0').waitFor();
	assert.equal(await text('pressure-value-pressure-0'), await text('state-pressure-channels.0.pressure'));
	const pressureId = (await waitView((v) => v.strip.some((w) => w.type === 'pressure'), 'pressure widget')).strip.find((w) => w.type === 'pressure').id;
	await page.getByTestId('strip-' + pressureId).getByLabel('Widget settings').click();
	const settings = page.getByTestId('widget-settings');
	await settings.getByTestId('prop-channel').fill('1.5');
	await settings.getByTestId('settings-save').click();
	assert.match(await settings.getByRole('alert').textContent(), /whole number/); // checked against the widget's declared props
	await settings.getByTestId('prop-channel').fill('0');
	await settings.getByTestId('prop-label').fill('Vorvakuum');
	await settings.getByTestId('settings-save').click();
	await settings.waitFor({ state: 'detached' });
	assert.deepEqual((await waitView((v) => v.strip.find((w) => w.id === pressureId)?.props?.label === 'Vorvakuum', 'label')).strip.find((w) => w.id === pressureId).props, { label: 'Vorvakuum' }); // channel 0 is the default: not stored
	await page.getByTestId('pressure-pressure-0').getByText('Vorvakuum').waitFor();
	script('lab.pressure.set_pressure(0, 0.0789)');
	await waitText('pressure-value-pressure-0', '0.0789');
	ok('pressure widget shows the profile\'s channel, follows it and takes a label');

	await page.getByTestId('edit-toggle').click(); // Done
	await page.getByTestId('record-start').isDisabled().then((d) => assert.ok(d, 'no recording without a name'));
	await page.getByTestId('recording-name').fill('widget_test');
	await page.getByTestId('record-start').click();
	await page.getByTestId('record-stop').waitFor();
	assert.ok(fs.existsSync(path.join(dir, 'data', 'recordings', 'widget_test.yaml')) || fs.readdirSync(path.join(dir, 'data', 'recordings')).some((f) => f.startsWith('widget_test')));
	await page.getByTestId('record-stop').click();
	await page.getByTestId('record-start').waitFor();
	await page.getByTestId('recording-name').fill('widget_snap');
	await page.getByTestId('snapshot').click();
	await page.waitForFunction(() => !document.querySelector('[data-testid="recording-widget"]')?.getAttribute('title'));
	ok('recording bar: record, stop, snapshot');

	// stage and RF generator widgets, with the simulated drivers
	for (const f of ['elliptec.py', 'rs_sma100b.py', 'pfeiffer_turbo_pump.py']) fs.copyFileSync(path.join(root, 'drivers', f), path.join(dir, 'workspace/devices', f));
	const devicesJson = path.join(dir, 'workspace/devices.json');
	const current = JSON.parse(fs.readFileSync(devicesJson, 'utf8'));
	current.devices.stages = { file: 'devices/elliptec.py', config: { simulate: true, channels: [{ type: 'rotation', address: '0' }, { type: 'rotation', address: '1' }] } };
	current.devices.turbo = { file: 'devices/pfeiffer_turbo_pump.py', config: { simulate: true, poll_s: 0.2, pumps: [{ name: 'Turbo 1' }, { name: 'Turbo 2' }] } };
	current.devices.rf = { file: 'devices/rs_sma100b.py', config: { simulate: true } };
	fs.writeFileSync(devicesJson, JSON.stringify(current));
	await page.getByTestId('edit-toggle').click();
	await addWidget('positioner', 'stages', 1);
	await addWidget('frequency', 'rf', 0);
	await addWidget('turbo_pump', 'turbo', 1);
	const positionInput = page.getByTestId('positioner-input-stages-1');
	await positionInput.fill('42.5');
	await positionInput.press('Enter');
	await page.waitForFunction(() => document.querySelector('[data-testid="positioner-input-stages-1"]')?.value === '42.5');
	assert.equal(script("print(lab.stages.state['channels'][1]['target_position'])"), '42.5');
	await page.getByLabel('Step up').click();
	await page.waitForFunction(() => document.querySelector('[data-testid="positioner-input-stages-1"]')?.value === '43.5');
	ok('stage widget: typed position and step buttons move the channel');

	const frequencyInput = page.getByTestId('frequency-input-rf-0');
	await frequencyInput.fill('1.5 MHz');
	await frequencyInput.press('Enter');
	await page.waitForFunction(() => document.querySelector('[data-testid="frequency-input-rf-0"]')?.value === '1.5 MHz');
	assert.equal(script("print(lab.rf.state['channels'][0]['frequency'])"), '1500000.0');
	await page.getByTestId('frequency-on-rf-0').click();
	await page.waitForFunction(() => document.querySelector('[data-testid="frequency-on-rf-0"]')?.getAttribute('aria-pressed') === 'true');
	ok('RF widget: frequency with SI suffix, output on');

	await page.getByTestId('turbo-mode-turbo-1').waitFor();
	assert.match(await text('turbo-mode-turbo-1'), /Stopped/);
	await page.getByTestId('turbo-turbo-1').click();
	const panel = page.getByTestId('pump-panel-turbo-1');
	await panel.getByTestId('pump-speed').fill('400');
	await panel.getByTestId('pump-set-speed').click();
	await panel.getByTestId('pump-start').click();
	await page.waitForFunction(() => /Running/.test(document.querySelector('[data-testid="turbo-mode-turbo-1"]')?.textContent ?? ''));
	await page.waitForFunction(() => Number(document.querySelector('[data-testid="turbo-speed-turbo-1"]')?.textContent?.replace(/[^0-9.]/g, '')) >= 100);
	assert.equal(script("print(lab.turbo.state['channels'][1]['target_speed'], lab.turbo.state['channels'][0]['is_running'])"), '400 False'); // only the chosen pump
	await panel.getByTestId('pump-stop').click();
	await page.waitForFunction(() => /Stopped/.test(document.querySelector('[data-testid="turbo-mode-turbo-1"]')?.textContent ?? ''));
	await page.keyboard.press('Escape');
	await panel.waitFor({ state: 'detached' });
	ok('turbo pump widget: details panel starts, sets the speed and stops only its pump');

	// the oscilloscope is also a frequency generator (a second profile, mounted at "generator"): the ordinary frequency widget works on it
	await addWidget('frequency', 'scope', 0);
	const generator = page.getByTestId('frequency-input-scope-0');
	await generator.fill('250 kHz');
	await generator.press('Enter');
	await page.waitForFunction(() => document.querySelector('[data-testid="frequency-input-scope-0"]')?.value === '250 kHz');
	assert.equal(Number(script("print(lab.scope.state['generator']['channels'][0]['frequency'])")), 250000);
	await page.getByTestId('frequency-on-scope-0').click();
	await page.waitForFunction(() => document.querySelector('[data-testid="frequency-on-scope-0"]')?.getAttribute('aria-pressed') === 'false');
	ok('oscilloscope with generator: the frequency widget controls its generator channel');

	// generic widgets, configured in the picker: a state field, a number with its action, a button
	const pick = async (type) => {
		await openPicker();
		await page.getByTestId(`add-${type}`).click();
		await page.getByTestId('pick-device').selectOption('scope');
	};
	await pick('value');
	await page.getByTestId('custom-path').selectOption('sample_rate');
	await page.getByTestId('custom-label').fill('Rate');
	await page.getByTestId('picker-preview').waitFor();
	await page.getByTestId('custom-create').click();
	await page.getByLabel('Close panel').click();
	await page.getByTestId('value-text-scope-sample_rate').waitFor();
	assert.match(await text('value-text-scope-sample_rate'), /MHz/); // a unit of Hz is shown with an SI prefix
	await pick('number');
	await page.getByTestId('custom-path').selectOption('fft_frequency');
	assert.equal(await page.getByTestId('custom-action').inputValue(), 'set_fft_frequency'); // suggested from the name of the field
	await page.getByTestId('picker-preview').waitFor();
	await page.getByTestId('custom-create').click();
	await page.getByLabel('Close panel').click();
	const top = page.getByTestId('number-input-scope-fft_frequency');
	await top.fill('500 kHz');
	await top.press('Enter');
	await page.waitForFunction(() => document.querySelector('[data-testid="number-input-scope-fft_frequency"]')?.value === '500 kHz');
	assert.equal(Number(script("print(lab.scope.state['fft_frequency'])")), 500000);
	await pick('button');
	await page.getByTestId('custom-action').selectOption('reset_fft_storage');
	await page.getByTestId('picker-preview').waitFor();
	await page.getByTestId('custom-create').click();
	await page.getByLabel('Close panel').click();
	await page.getByTestId('button-scope-reset_fft_storage').click();
	await page.waitForTimeout(300);
	assert.equal(await page.getByTestId('button-scope-reset_fft_storage').locator('..').getAttribute('title'), null); // no error
	const widgetsOfView = readView();
	assert.deepEqual(widgetsOfView.strip.filter((w) => ['value', 'number', 'button'].includes(w.type)).map((w) => w.props), [
		{ path: 'sample_rate', label: 'Rate' },
		{ path: 'fft_frequency', action: 'set_fft_frequency' },
		{ action: 'reset_fft_storage' },
	]);
	ok('generic widgets: value, number (SI input) and button, configured in the picker');

	// runtime widgets: a file in widgets/ becomes a widget of the picker, is styled, reloads when it changes, and its errors stay inside it
	const widgetFile = path.join(dir, 'workspace/widgets/pressure_big.tsx');
	const widgetSource = (version, extra = '') => `import { useDevice, Tile } from '@laborchestra/widget';
import { useState } from 'react';
export const meta = { title: 'Big pressure', size: 'S', profile: 'pressure_sensor', props: [{ name: 'channel', label: 'Gauge', type: 'integer', min: 0, default: 0 }] };
export default function BigPressure({ device, props }: { device: string; props: { channel?: number } }) {
	const d = useDevice(device);
	const [clicks, setClicks] = useState(0);
	${extra}
	const p = d?.state.channels?.[props.channel ?? 0]?.pressure;
	return (
		<Tile label="runtime widget" testId="rw-tile">
			<button data-testid="rw-click" onClick={() => setClicks(clicks + 1)} className="text-left">
				<span data-testid="rw-value" className="text-3xl font-bold text-fuchsia-600">{p}</span>
				<span data-testid="rw-version"> ${version}</span><span data-testid="rw-clicks"> {clicks}</span>
			</button>
		</Tile>
	);
}
`;
	fs.mkdirSync(path.dirname(widgetFile), { recursive: true });
	fs.writeFileSync(widgetFile, widgetSource('v1'));
	await addWidget('ws:pressure_big', 'pressure'); // appears in the picker by itself
	await page.getByTestId('rw-value').waitFor();
	assert.equal(await text('rw-value'), await text('state-pressure-channels.0.pressure').catch(() => text('rw-value'))); // the SDK's useDevice shows the device's state
	await page.waitForFunction(() => document.querySelector('[data-testid="rw-value"]')?.textContent !== '');
	const colour = (id) => page.getByTestId(id).evaluate((el) => getComputedStyle(el).color);
	assert.notEqual(await colour('rw-value'), await colour('rw-version')); // text-fuchsia-600 exists nowhere in the host: the server built the stylesheet
	assert.match(await colour('rw-value'), /322|rgb\(192, 38, 211\)|lab|oklch/);
	await page.getByTestId('rw-click').click();
	await waitText('rw-clicks', ' 1');
	ok('runtime widget: found in the picker, shows the device through the SDK, styled by the server\'s Tailwind build');

	fs.writeFileSync(widgetFile, widgetSource('v2')); // edited while the page is open
	await waitText('rw-version', ' v2');
	await waitText('rw-clicks', ' 0'); // a new version starts afresh
	ok('runtime widget: a change of the file reaches the open page without a reload');

	fs.writeFileSync(widgetFile, widgetSource('v3').replace('const d =', 'const d ==')); // a syntax error
	await page.getByTestId('widget-error-pressure_big').waitFor();
	assert.match(await text('widget-error-pressure_big'), /pressure_big\.tsx|Unexpected|Expected/);
	fs.writeFileSync(widgetFile, widgetSource('v4'));
	await waitText('rw-version', ' v4');
	ok('runtime widget: a build error is shown in place of the widget and goes away when fixed');

	fs.writeFileSync(widgetFile, widgetSource('v5', "if (d) throw new Error('boom in the widget');"));
	await page.getByTestId('widget-crash-pressure_big').waitFor();
	assert.match(await text('widget-crash-pressure_big'), /boom in the widget/);
	await page.getByTestId('edit-toggle').waitFor(); // the rest of the dashboard is still there
	fs.writeFileSync(widgetFile, widgetSource('v6'));
	await waitText('rw-version', ' v6');
	await page.reload();
	await page.getByTestId('rw-value').waitFor(); // the instance is saved in the view like any other
	ok('runtime widget: a crash stays inside the widget; the widget is part of the saved view');
	await page.getByTestId('edit-toggle').click();
	const runtimeId = readView().strip.find((w) => w.type === 'ws:pressure_big').id;
	await page.getByTestId('strip-' + runtimeId).getByLabel('Widget settings').click(); // the widget declares a "Gauge" setting in its meta
	await page.getByTestId('widget-settings').getByLabel('Gauge').fill('1');
	await page.getByTestId('settings-save').click();
	await page.waitForFunction(() => /e-8/.test(document.querySelector('[data-testid="rw-value"]')?.textContent ?? ''));
	await waitView((v) => v.strip.find((w) => w.id === runtimeId).props?.channel === 1, 'the setting in the file');
	ok('settings dialog: props declared by a widget (built-in or from the workspace) are edited and checked');

	// a device from an installed package, added in the device dialog, and the widget the package brings
	await page.getByTestId('edit-toggle').click(); // Done
	await page.getByTestId('nav-devices').click();
	await page.getByTestId('add-device').click();
	const packageDialog = page.getByTestId('device-dialog');
	await packageDialog.getByTestId('kind-package').click();
	await packageDialog.getByTestId('field-package').fill(packageDir);
	await packageDialog.getByTestId('look-inside').click();
	await packageDialog.getByTestId('package-contents').waitFor();
	assert.match(await packageDialog.getByTestId('package-contents').textContent(), /packaged_tile/); // it says which widgets come with it
	await packageDialog.getByTestId('option-step').waitFor(); // the only device of the package was chosen: its options are there
	await packageDialog.getByLabel('step').fill('3');
	await packageDialog.getByTestId('field-id').fill('pkg_counter');
	await packageDialog.getByTestId('save-device').click();
	await packageDialog.waitFor({ state: 'detached' });
	assert.deepEqual({ ...devicesFile().pkg_counter }, { package: packageDir, entry: 'test_counter', config: { step: 3 } });
	await waitText('row-status-pkg_counter', 'ready');
	assert.match(await text('row-pkg_counter'), /package: .*lab_test_pkg \(test_counter\)/);
	ok('device dialog: a package is looked into, its device chosen, its options filled in');
	await page.getByTestId('nav-dashboard').click();
	await page.getByTestId('edit-toggle').click();
	await addWidget('pkg:packaged_tile', 'pkg_counter'); // shipped by the package, not in the workspace
	await page.getByTestId('packaged-count').waitFor();
	assert.equal(await text('packaged-count'), '0');
	script('lab.pkg_counter.increment()');
	await waitText('packaged-count', '3');
	assert.notEqual(await colour('packaged-count'), await colour('rw-version')); // text-lime-600 is in the server's stylesheet as well
	ok('widget shipped by a package: offered for devices, shows the device, styled');

	// "New widget": a file from a template that is built and offered at once (edit mode is on)
	await openPicker();
	await page.getByTestId('new-widget').click();
	await page.getByTestId('widget-template-blank').check();
	await page.getByTestId('new-widget-name').fill('Not Snake');
	await page.getByTestId('create-widget').click();
	assert.match(await text('dialog-error'), /snake_case/);
	await page.getByTestId('new-widget-name').fill('status_tile');
	await page.getByTestId('create-widget').click();
	await page.getByTestId('new-widget-done').waitFor();
	assert.ok(fs.readFileSync(path.join(dir, 'workspace/widgets/status_tile.tsx'), 'utf8').includes('export default function StatusTile('));
	assert.ok(fs.existsSync(path.join(dir, 'workspace/widgets/laborchestra-widget.d.ts')));
	await page.getByTestId('new-widget-dialog').getByRole('button', { name: 'Done' }).click();
	await addWidget('ws:status_tile', 'pressure');
	await page.getByTestId('status_tile').waitFor();
	assert.match(await text('status_tile'), /ready/); // the template shows the status of the device
	ok('new widget from a template appears in the picker and works');

	// several views: duplicate, rename, reorder
	await page.getByTestId('view-duplicate').click();
	await page.getByTestId('view-tab-dashboard_copy').waitFor();
	const copy = JSON.parse(fs.readFileSync(path.join(dir, 'workspace/views/dashboard_copy.json'), 'utf8'));
	assert.equal(copy.title, 'Dashboard (copy)');
	assert.equal(copy.strip.length, readView().strip.length); // the same widgets
	await page.getByTestId('view-rename').click();
	await page.getByTestId('name-input').fill('Second view');
	await page.getByTestId('name-save').click();
	await page.getByTestId('view-tab-dashboard_copy').getByText('Second view').waitFor();
	await page.getByTestId('view-left').click();
	for (let i = 0; i < 50; i++) {
		const order = ['dashboard', 'dashboard_copy'].map((v) => JSON.parse(fs.readFileSync(path.join(dir, `workspace/views/${v}.json`), 'utf8')).order);
		if (order[1] === 0 && order[0] === 1) break;
		await new Promise((r) => setTimeout(r, 100));
	}
	await page.waitForFunction(() => [...document.querySelectorAll('[data-testid^="view-tab-"]')].map((e) => e.dataset.testid).join() === 'view-tab-dashboard_copy,view-tab-dashboard');
	page.once('dialog', (d) => d.accept());
	await page.getByTestId('view-delete').click();
	await page.getByTestId('view-tab-dashboard_copy').waitFor({ state: 'detached' });
	await page.getByTestId('view-tab-dashboard').click();
	ok('views: duplicate, rename, reorder, delete');
	await page.getByTestId('edit-toggle').click(); // Done

	// a hand edit of the file reaches the open page; a missing device gives a placeholder
	view = readView();
	view.strip.push({ id: 'w_gone', type: 'summary', device: 'no_such_device' });
	fs.writeFileSync(viewFile, JSON.stringify(view));
	await page.getByTestId('placeholder-w_gone').waitFor();
	assert.match(await text('placeholder-w_gone'), /does not exist/);
	ok('a changed view file reaches the page; a missing device shows a placeholder');

	if (process.env.E2E_SCREENSHOT) await page.screenshot({ path: process.env.E2E_SCREENSHOT });
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
