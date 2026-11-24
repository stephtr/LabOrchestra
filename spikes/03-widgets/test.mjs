import { chromium } from 'playwright-core'; import { spawn } from 'child_process'; import fs from 'fs'; import os from 'os'; import path from 'path'; import assert from 'assert';
const win = process.platform === 'win32', dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w-')), f = path.join(dir, 'demo.tsx');
const pkg = `${process.platform}-${process.arch}`; const esb = path.resolve('node_modules/@esbuild', pkg, win ? 'esbuild.exe' : 'bin/esbuild');
const widget = (title, extra = '') => `import { useState } from 'react'; import { useDevice, Button, Slider, Popover } from '@laborchestra/sdk';
export default function W() { const [n, set] = useState<number>(0); const [s, setS] = useState([5]); const d = useDevice('pressure'); ${extra}
  return <div id="w" className="p-2 m-[13px] bg-brand/50 md:pl-[7px]"><h1 id="title">${title}</h1><span id="val">{d.value}</span><Button id="b" onClick={() => set(n + 1)}>{n}</Button>
  <Slider value={s} onValueChange={setS} max={10} /><span id="s">{s[0]}</span><Popover trigger={<Button id="pt">open</Button>}>content</Popover></div>; }`;
fs.writeFileSync(f, widget('one'));
const srv = spawn(path.resolve('bin/Release/net9.0/spike' + (win ? '.exe' : '')), [esb, dir], { stdio: 'inherit' });
let browser, code = 1;
try {
  for (let i = 0; ; i++) { try { await fetch('http://127.0.0.1:5198/errors'); break; } catch { if (i > 150) throw Error('server not up'); await new Promise(r => setTimeout(r, 200)); } }
  browser = await chromium.launch(process.env.CI ? { channel: 'chrome' } : {}); const page = await browser.newPage(); page.on('pageerror', e => console.log('  pageerror', e.message)); page.setDefaultTimeout(8000);
  const txt = s => page.locator(s).textContent(), css = (s, p) => page.locator(s).evaluate((e, p) => getComputedStyle(e)[p], p);
  const ok = m => console.log('ok  ', m);
  await page.goto('http://127.0.0.1:5198/'); await page.waitForSelector('#w');
  await page.click('#b'); await page.click('#b'); assert.equal(await txt('#b'), '2'); ok('hooks work (one React)');
  assert.equal(await txt('#val'), '3.2e-7'); ok('context shared through SDK');
  await page.locator('[role=slider]').press('ArrowRight'); assert.equal(await txt('#s'), '6'); await page.click('#pt'); assert.equal(await txt('#pop'), 'content'); await page.keyboard.press('Escape'); ok('Radix slider + popover from SDK');
  assert.equal(await css('#w', 'marginTop'), '13px'); assert.notEqual(await css('#w', 'backgroundColor'), 'rgba(0, 0, 0, 0)'); assert.equal(await css('#w', 'paddingLeft'), '7px'); ok('widget Tailwind classes');
  assert.equal(await css('#hostbox', 'paddingTop'), '16px'); ok('host md:p-4 not overridden by widget p-2');
  await page.waitForFunction(() => window.bin); const bin = await page.evaluate(() => window.bin); console.log('     bin', JSON.stringify(bin)); assert.equal(bin.type, 'Uint8Array'); assert.equal(bin.sum, 6.5); ok('binary arrives as Uint8Array');
  await page.evaluate(() => { window.marker = 1; }); const t = Date.now(); fs.writeFileSync(f, widget('two').replace('m-[13px]', 'm-[21px]')); await page.waitForFunction(() => document.querySelector('#title')?.textContent === 'two', null, { polling: 5 });
  console.log(`     save -> visible: ${Date.now() - t} ms`); assert.equal(await css('#w', 'marginTop'), '21px'); assert.equal(await page.evaluate(() => window.marker), 1); ok('reload on save, no page reload, new class styled');
  fs.writeFileSync(f, widget('x') + '\nconst = 5;'); await page.waitForSelector('#builderr'); assert.match(await txt('#builderr'), /demo\.tsx:\d+/); assert.equal(await txt('#title'), 'two'); ok('build error shown, old widget stays');
  fs.writeFileSync(f, widget('three', 'if (n > 0) throw new Error("widget bug");')); await page.waitForFunction(() => document.querySelector('#title')?.textContent === 'three'); await page.click('#b'); await page.waitForSelector('#crash');
  assert.equal(await txt('#hostbox'), 'host'); await page.waitForTimeout(300); assert.match(await (await fetch('http://127.0.0.1:5198/errors')).text(), /widget bug/); ok('runtime error contained and reported to server');
  fs.writeFileSync(f, widget('four')); await page.waitForFunction(() => document.querySelector('#title')?.textContent === 'four'); ok('recovers after fix');
  code = 0; console.log('OK');
} catch (e) { console.error(e); } finally { await browser?.close(); srv.kill(); fs.rmSync(dir, { recursive: true, force: true }); process.exit(code); }
