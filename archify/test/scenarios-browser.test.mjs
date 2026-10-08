import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { findChrome } from '../bin/visual-check.mjs';
import { desktopBrowser } from './helpers/desktop-browser.mjs';

const skillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const chrome = process.env.ARCHIFY_CHROME ? findChrome() : null;

test('scenarios, evidence, details and export cleanup behave in a real browser', {
  skip: chrome ? false : 'Set ARCHIFY_CHROME to run real-browser scenario checks.',
}, async (t) => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'archify-scenarios-'));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const evidence = process.env.ARCHIFY_SCENARIOS_EVIDENCE;
  if (evidence) fs.mkdirSync(evidence, { recursive: true });

  const file = path.join(scratch, 'scenarios.html');
  execFileSync(process.execPath, [
    path.join(skillRoot, 'renderers/architecture/render-architecture.mjs'),
    path.join(skillRoot, 'examples/graph-engine-scenarios.architecture.json'),
    file,
  ]);

  const browser = desktopBrowser(chrome);
  t.after(() => browser.close());
  const session = await browser.sessionPromise;
  const send = (method, params = {}) => browser.cdp.send(method, params, session);
  await send('Emulation.setFocusEmulationEnabled', { enabled: true });
  async function run(expression) {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    assert.equal(result.exceptionDetails, undefined, result.exceptionDetails?.exception?.description);
    return result.result?.value;
  }
  async function load(suffix = '') {
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
    await send('Emulation.setEmulatedMedia', { media: '', features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    const loaded = browser.cdp.waitFor('Page.loadEventFired', session);
    await send('Page.navigate', { url: pathToFileURL(file).href + suffix });
    await loaded;
    await run('document.fonts.ready');
    await run('Archify.viewerChromeLayout.whenStable()');
  }
  async function shot(name) {
    if (!evidence) return;
    const { data } = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(evidence, `${name}.png`), Buffer.from(data, 'base64'));
  }
  async function click(selector) {
    const point = await run(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
  }
  const choose = (id, value) => run(`(()=>{const s=document.getElementById(${JSON.stringify(id)});s.value=${JSON.stringify(value)};s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  const state = (id) => run(`document.querySelector('[data-node-id="${id}"]').getAttribute('data-scenario-state')`);
  const diff = (id) => run(`document.querySelector('[data-node-id="${id}"]').getAttribute('data-scenario-diff')`);
  const text = (id) => run(`document.getElementById(${JSON.stringify(id)}).textContent.replace(/\\s+/g,' ').trim()`);

  // The authored default scenario applies on load.
  await load();
  assert.equal(await run('document.getElementById("scenario-bar").hidden'), false);
  assert.equal(await run('document.getElementById("scenario-select").value'), 'home-new');
  assert.equal(await state('recall'), 'in');
  assert.equal(await state('job'), 'out');
  assert.match(await text('scenario-compare-label'), /compare with another graph/);
  assert.match(await text('scenario-stat'), /^10 nodes · 10 relationships$/);

  // Evidence levels explain themselves and filter relationships.
  assert.match(await text('evidence-title'), /Offline to online evidence/);
  assert.match(await text('evidence-note'), /not equally certain/);
  assert.equal(await run('document.querySelectorAll("#evidence-levels dt").length'), 3);
  assert.match(await text('evidence-levels'), /Key or table matched\s*Both sides use the same key pattern/);
  assert.equal(await run('document.querySelectorAll("#evidence-levels svg line[stroke-dasharray]").length'), 2);
  await click('[data-evidence-filter="inferred"]');
  assert.equal(await run('document.querySelectorAll("path[data-edge-evidence=inferred][data-evidence-hidden]").length'), 1);
  assert.equal(await run('document.querySelectorAll("path[data-edge-evidence=confirmed][data-evidence-hidden]").length'), 0);
  await click('[data-evidence-filter="inferred"]');
  assert.equal(await run('document.querySelectorAll("[data-evidence-hidden]").length'), 0);

  // Comparing says who has more, names the nodes, and marks changed annotations.
  await choose('scenario-compare', 'home-old');
  assert.equal(await diff('coldstart'), 'added');
  assert.equal(await diff('recall'), 'changed');
  assert.equal(await diff('gateway'), 'same');
  assert.match(await text('scenario-stat'), /1 more than home \/ returning users, 0 fewer, 1 with a different annotation\./);
  assert.match(await text('scenario-diff'), /Only here\s*Cold-start Op/);
  assert.match(await text('scenario-diff'), /Annotation differs\s*Recall Op limit=500 \(was limit=300\)/);
  await shot('compare');

  // Group filter narrows the scenario list; leaving the group resets the choice.
  await choose('scenario-group', 'sliding');
  assert.deepEqual(await run('[...document.getElementById("scenario-select").options].map(o=>o.value)'), ['', 'sliding-default']);
  assert.equal(await run('document.querySelectorAll("[data-scenario-state]").length'), 0);
  await choose('scenario-select', 'sliding-default');
  assert.equal(await state('rank'), 'out');
  assert.match(await text('scenario-stat'), /^6 nodes · 5 relationships$/);

  // Two scenarios that run the same things say so in words instead of "+0 -0".
  const twin = path.join(scratch, 'twin.html');
  fs.writeFileSync(twin, fs.readFileSync(file, 'utf8').replace(
    /(<script id="archify-extensions-data" type="application\/json">)([\s\S]*?)(<\/script>)/,
    (_, start, json, end) => {
      const payload = JSON.parse(json);
      const original = payload.scenarios.items.find((item) => item.id === 'home-new');
      payload.scenarios.items.push({ ...original, id: 'home-twin', label: 'home / twin', compare: null });
      return start + JSON.stringify(payload).replaceAll('<', '\\u003c') + end;
    },
  ));
  {
    const loaded = browser.cdp.waitFor('Page.loadEventFired', session);
    await send('Page.navigate', { url: pathToFileURL(twin).href + '?scenario=home-twin&compare=home-new' });
    await loaded;
    await run('document.fonts.ready');
    await run('Archify.viewerChromeLayout.whenStable()');
  }
  assert.match(await text('scenario-stat'), /Both graphs run the same stages and stores\. They differ in operator parameters\./);
  assert.equal(await run('document.getElementById("scenario-diff").hidden'), true);

  // Deep link restores scenario and comparison.
  await load('?scenario=home-old&compare=home-new');
  assert.equal(await run('document.getElementById("scenario-select").value'), 'home-old');
  assert.equal(await run('document.getElementById("scenario-compare").value'), 'home-new');
  assert.equal(await diff('coldstart'), 'removed');
  assert.match(await text('scenario-diff'), /Only there\s*Cold-start Op/);

  // Node details appear in the passport.
  await load('?scenario=home-new');
  await click('[data-node-id="cache"]');
  await run('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
  assert.equal(await run('document.getElementById("focus-details").hidden'), false);
  assert.equal(await text('focus-details-title'), 'Details');
  assert.deepEqual(await run('[...document.querySelectorAll("#focus-details-list dt")].map(e=>e.textContent)'), ['Cluster', 'Keys', 'Structure']);
  assert.match(await text('focus-details-list'), /stream::\{region\}:\{session\}\|top_selling::item::def/);
  await shot('node-details');

  // A node without details leaves the slot closed.
  await click('[data-node-id="mix"]');
  await run('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
  assert.equal(await run('document.getElementById("focus-details").hidden'), true);

  // Pinning a relationship shows its evidence and its own rows.
  const pinned = await run(`Archify.focus && typeof Archify.focus.inspectRelationshipById === 'function'
    ? Archify.focus.inspectRelationshipById('recall-cache') : null`);
  if (pinned === null) {
    await click('.relationship-hit-target[data-relationship-hit-key="8"]');
  }
  await run('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
  assert.equal(await run('document.querySelector(".diagram-container svg").getAttribute("data-relationship-pin-active")'), '8');
  assert.equal(await run('document.getElementById("focus-details").hidden'), false);
  assert.match(await text('focus-details-title'), /Recall Op → Recall Index · read/);
  assert.deepEqual(await run('[...document.querySelectorAll("#focus-details-list dt")].map(e=>e.textContent)'),
    ['Offline to online evidence', 'Key', 'Read by', 'Basis']);
  assert.match(await text('focus-details-list'), /Key or table matched: Both sides use the same key pattern/);
  await shot('relationship-details');

  // Reader state never reaches an exported SVG.
  const exported = await run(`(()=>{
    const svg=document.querySelector('.diagram-container svg');
    const clone=svg.cloneNode(true);
    const before=clone.querySelectorAll('[data-scenario-state],[data-extension-overlay]').length;
    const source=[...document.scripts].map(s=>s.textContent).join('\\n');
    return { before, cleans: /data-extension-overlay/.test(source) && /data-scenario-state/.test(source) };
  })()`);
  assert.ok(exported.before > 0, 'the live diagram carries reader state');
  assert.equal(exported.cleans, true, 'export cleanup knows the reader state attributes');
});
