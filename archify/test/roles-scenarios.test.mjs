import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ROLE_CATALOG, ROLE_SIGIL_SHAPE, TONES, applyRoles, nodeShape, resolveRole } from '../renderers/shared/roles.mjs';
import { buildExtensionData, isSafeLink } from '../renderers/shared/extensions.mjs';
import { NODE_SHAPES, renderNodeBody, shapeGeometry, shapeTextWidth } from '../renderers/shared/shapes.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.resolve(__dirname, '..');
const cli = path.join(skillRoot, 'bin/archify.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archify-roles-scenarios-'));
let sequence = 0;

function base() {
  return {
    schema_version: 1,
    diagram_type: 'architecture',
    meta: { title: 'Roles and scenarios', output: 'roles.html', viewBox: [760, 420] },
    components: [
      { id: 'engine', role: 'engine', label: 'Engine', pos: [60, 90], size: [150, 60] },
      { id: 'recall', role: 'operator', label: 'Recall', pos: [320, 90], size: [150, 60] },
      { id: 'cache', role: 'cache', label: 'Index', pos: [320, 250], size: [150, 60] },
      { id: 'plain', type: 'backend', label: 'Plain', pos: [580, 90], size: [150, 60] },
    ],
    connections: [
      { id: 'run', from: 'engine', to: 'recall', label: 'run' },
      { id: 'read', from: 'recall', to: 'cache', label: 'read', evidence: 'inferred', labelDy: 24 },
      { id: 'next', from: 'recall', to: 'plain', label: 'next' },
    ],
  };
}

function run(diagram, type = 'architecture') {
  sequence += 1;
  const input = path.join(tmp, `case-${sequence}.json`);
  const output = path.join(tmp, `case-${sequence}.html`);
  fs.writeFileSync(input, JSON.stringify(diagram));
  const result = spawnSync(process.execPath, [cli, 'render', type, input, output], {
    cwd: skillRoot,
    encoding: 'utf8',
  });
  return {
    status: result.status,
    output: `${result.stdout}\n${result.stderr}`,
    html: result.status === 0 ? fs.readFileSync(output, 'utf8') : '',
  };
}

function diagramSvg(html) {
  const start = html.indexOf('<svg viewBox=');
  return html.slice(start, html.indexOf('</svg>', start));
}

function payload(html) {
  const match = /<script id="archify-extensions-data" type="application\/json">([\s\S]*?)<\/script>/.exec(html);
  return match ? JSON.parse(match[1]) : null;
}

test('every built-in role resolves to a known tone and ships a sigil', () => {
  for (const [role, entry] of Object.entries(ROLE_CATALOG)) {
    assert.ok(TONES.includes(entry.tone), `${role} tone`);
    assert.ok(Object.hasOwn(ROLE_SIGIL_SHAPE, role), `${role} sigil`);
    assert.equal(entry.label.length, 2, `${role} needs en and zh-CN labels`);
  }
});

test('a role supplies the missing type and keeps its own sigil and legend entry', () => {
  const { status, html, output } = run(base());
  assert.equal(status, 0, output);
  const svg = diagramSvg(html);
  assert.match(svg, /data-node-id="cache"[^>]*data-node-kind="database"[^>]*data-node-role="cache"/);
  assert.match(svg, /data-semantic-sigil="database" data-semantic-role="cache"/);
  assert.match(svg, /data-legend-role="engine"/);
  assert.match(svg, /data-legend-role="operator"/);
  // The component without a role keeps the ordinary tone entry.
  assert.match(svg, /data-legend-semantic-kind="backend"/);
  assert.doesNotMatch(svg, /data-legend-semantic-kind="database"/);
});

test('a diagram without extensions renders no extension payload', () => {
  const plain = base();
  plain.components = plain.components.map(({ role, ...rest }) => ({ type: 'backend', ...rest }));
  plain.connections = plain.connections.map(({ evidence, ...rest }) => rest);
  const { status, html, output } = run(plain);
  assert.equal(status, 0, output);
  assert.equal(payload(html), null);
  assert.doesNotMatch(diagramSvg(html), /data-node-role|data-edge-evidence|data-legend-role/);
});

test('type and role must agree, and unknown roles are rejected with the catalog', () => {
  const mismatch = base();
  mismatch.components[0].type = 'database';
  const first = run(mismatch);
  assert.notEqual(first.status, 0);
  assert.match(first.output, /belongs to tone "backend"/);

  const unknown = base();
  unknown.components[0].role = 'teleporter';
  const second = run(unknown);
  assert.notEqual(second.status, 0);
  assert.match(second.output, /role "teleporter" is unknown/);

  const neither = base();
  delete neither.components[3].type;
  const third = run(neither);
  assert.notEqual(third.status, 0);
  assert.match(third.output, /needs a type or a role/);
});

test('meta.roles declares project roles that reuse a built-in sigil', () => {
  const diagram = base();
  diagram.meta.roles = { ranker: { tone: 'backend', label: 'Ranker', sigil: 'model' } };
  diagram.components[1].role = 'ranker';
  assert.deepEqual(resolveRole(diagram, 'ranker'), {
    id: 'ranker', tone: 'backend', label: 'Ranker', sigil: 'model', shape: 'octagon', custom: true,
  });
  const { status, html, output } = run(diagram);
  assert.equal(status, 0, output);
  assert.match(diagramSvg(html), /data-node-role="ranker" data-node-role-label="Ranker"/);
  assert.match(diagramSvg(html), /data-semantic-role="model"/);

  diagram.meta.roles.ranker.sigil = 'nonexistent';
  const broken = run(diagram);
  assert.notEqual(broken.status, 0);
  assert.match(broken.output, /is not a built-in sigil/);
});

test('applyRoles localizes labels and leaves authored types untouched', () => {
  const diagram = base();
  diagram.meta.locale = 'zh-CN';
  assert.deepEqual(applyRoles('architecture', diagram), []);
  assert.equal(diagram.components[0].type, 'backend');
  assert.equal(diagram.components[3].type, 'backend');
  assert.equal(resolveRole(diagram, 'cache').label, '缓存');
});

test('evidence is emitted on the path and its label, and listed in the payload', () => {
  const { status, html, output } = run(base());
  assert.equal(status, 0, output);
  const svg = diagramSvg(html);
  assert.equal((svg.match(/data-edge-id="read" data-edge-evidence="inferred"/g) || []).length, 2);
  assert.doesNotMatch(svg, /data-edge-id="run"[^>]*data-edge-evidence/);
  assert.deepEqual(payload(html).evidence, [{
    id: 'inferred', label: 'Inferred', description: 'Follows from indirect facts; not checked end to end.',
  }]);
  assert.equal(payload(html).evidenceTitle, 'Evidence');
  assert.match(svg, /data-legend-evidence-level="inferred"/);
  assert.match(svg, /data-legend-evidence="inferred"[^>]*style="stroke-dasharray:7 4"/);
});

test('scenarios are validated against nodes, relationships and each other', () => {
  const diagram = base();
  diagram.meta.scenarios = {
    label: 'Bundle',
    default: 'home',
    groups: [{ id: 'g', label: 'Group' }],
    items: [
      { id: 'home', group: 'g', label: 'Home', nodes: ['engine', 'recall', 'cache'], connections: ['run', 'read'], annotations: { recall: 'limit=500' }, compare: 'lite' },
      { id: 'lite', group: 'g', label: 'Lite', nodes: ['engine', 'recall'] },
    ],
  };
  const good = run(diagram);
  assert.equal(good.status, 0, good.output);
  const data = payload(good.html);
  assert.equal(data.scenarios.default, 'home');
  assert.deepEqual(data.scenarios.items.map((item) => item.id), ['home', 'lite']);
  assert.deepEqual(data.scenarios.items[1].connections, null);
  assert.match(good.html, /id="scenario-bar"/);

  const cases = [
    [(d) => { d.meta.scenarios.items[0].nodes.push('ghost'); }, /unknown node id "ghost"/],
    [(d) => { d.meta.scenarios.items[0].connections.push('nope'); }, /unknown relationship id "nope"/],
    [(d) => { d.meta.scenarios.items[0].annotations.plain = 'x'; }, /not part of this scenario/],
    [(d) => { d.meta.scenarios.items[0].compare = 'home'; }, /must name a different scenario/],
    [(d) => { d.meta.scenarios.items[1].compare = 'missing'; }, /unknown scenario "missing"/],
    [(d) => { d.meta.scenarios.items[1].group = 'other'; }, /unknown group "other"/],
    [(d) => { d.meta.scenarios.default = 'missing'; }, /default references unknown scenario/],
    [(d) => { d.meta.scenarios.items[1].id = 'home'; }, /duplicates scenario id "home"/],
  ];
  for (const [mutate, expected] of cases) {
    const broken = JSON.parse(JSON.stringify(diagram));
    mutate(broken);
    const result = run(broken);
    assert.notEqual(result.status, 0, String(expected));
    assert.match(result.output, expected);
  }
});

test('links accept sibling pages and web URLs and refuse executable schemes', () => {
  for (const link of ['detail.html', './bundles/home.html?scenario=a', '../index.html#x', 'https://example.com/graph?id=1']) {
    assert.equal(isSafeLink(link), true, link);
  }
  for (const link of ['javascript:alert(1)', 'JavaScript:alert(1)', 'data:text/html,x', '//evil.example', 'vbscript:x', '', ' ', 'a"b', 'a<b', 'file:///etc/passwd']) {
    assert.equal(isSafeLink(link), false, JSON.stringify(link));
  }
  const diagram = base();
  diagram.components[0].link = 'javascript:alert(1)';
  const refused = run(diagram);
  assert.notEqual(refused.status, 0);
  assert.match(refused.output, /link must be a relative page path or an http\(s\) URL/);

  diagram.components[0].link = 'detail.html';
  const accepted = run(diagram);
  assert.equal(accepted.status, 0, accepted.output);
  assert.match(diagramSvg(accepted.html), /data-node-id="engine"[^>]*data-node-link="detail.html"/);
});

test('workflow and data-flow diagrams carry roles and evidence too', () => {
  const workflow = {
    schema_version: 1,
    diagram_type: 'workflow',
    meta: { title: 'Workflow roles', output: 'workflow-roles.html', viewBox: [720, 360] },
    lanes: [{ id: 'main', label: 'Main' }],
    nodes: [
      { id: 'a', lane: 'main', col: 0, role: 'gateway', label: 'Gateway' },
      { id: 'b', lane: 'main', col: 2, role: 'operator', label: 'Operator' },
    ],
    edges: [{ from: 'a', to: 'b', evidence: 'confirmed' }],
  };
  const first = run(workflow, 'workflow');
  assert.equal(first.status, 0, first.output);
  assert.match(diagramSvg(first.html), /data-node-role="gateway"/);
  assert.match(diagramSvg(first.html), /data-edge-evidence="confirmed"/);
  assert.match(diagramSvg(first.html), /data-legend-role="operator"/);

  const dataflow = {
    schema_version: 1,
    diagram_type: 'dataflow',
    meta: { title: 'Dataflow roles', output: 'dataflow-roles.html' },
    stages: [{ label: 'Input' }, { label: 'Output' }],
    nodes: [
      { id: 'job', role: 'stream-job', label: 'Job', stage: 0, row: 0 },
      { id: 'store', role: 'featurestore', label: 'Store', stage: 1, row: 0 },
    ],
    flows: [{ from: 'job', to: 'store', label: 'write', route: 'straight', evidence: 'unverified' }],
  };
  const second = run(dataflow, 'dataflow');
  assert.equal(second.status, 0, second.output);
  assert.match(diagramSvg(second.html), /data-node-kind="compute"[^>]*data-node-role="stream-job"/);
  assert.match(diagramSvg(second.html), /data-edge-evidence="unverified"/);
});

test('sequence and lifecycle diagrams refuse scenarios instead of ignoring them', () => {
  const data = buildExtensionData('sequence', { meta: { scenarios: { items: [] } }, participants: [] });
  assert.equal(data, null);
  const sequenceDiagram = {
    schema_version: 1,
    diagram_type: 'sequence',
    meta: { title: 'No scenarios here', output: 'no-scenarios.html', viewBox: [720, 560], scenarios: { items: [{ id: 'a', label: 'A', nodes: ['client'] }] } },
    participants: [
      { id: 'client', type: 'frontend', label: 'Client' },
      { id: 'api', type: 'backend', label: 'API' },
    ],
    messages: [{ from: 'client', to: 'api', y: 220, label: 'request' }],
  };
  const result = run(sequenceDiagram, 'sequence');
  assert.notEqual(result.status, 0);
});

test('the bundled example renders every extension together', () => {
  const example = JSON.parse(fs.readFileSync(path.join(skillRoot, 'examples/graph-engine-scenarios.architecture.json'), 'utf8'));
  const { status, html, output } = run(example);
  assert.equal(status, 0, output);
  const data = payload(html);
  assert.equal(data.scenarios.items.length, 3);
  assert.deepEqual(data.evidence.map((entry) => entry.id), ['confirmed', 'inferred', 'unverified']);
  assert.ok(Object.keys(data.roles).includes('ranker'));
});

test('roles that share a tone never share a shape', () => {
  const seen = new Map();
  for (const [role, entry] of Object.entries(ROLE_CATALOG)) {
    assert.ok(NODE_SHAPES.includes(entry.shape), `${role} shape`);
    const key = `${entry.tone}/${entry.shape}`;
    assert.equal(seen.get(key), undefined, `${role} and ${seen.get(key)} would look the same`);
    seen.set(key, role);
  }
});

// Flatten the path commands shapes.mjs emits (M L H V A Q T Z, arcs without
// rotation) into a polyline, so a test can measure how far a point is from
// the drawn outline.
function flatten(outline) {
  const tokens = outline.match(/[MLHVAQTZ]|-?\d+(?:\.\d+)?/g);
  const points = [];
  let index = 0;
  let current = [0, 0];
  let start = [0, 0];
  let control = null;
  const next = () => Number(tokens[index++]);
  const curve = (from, via, to) => {
    for (let step = 1; step <= 24; step += 1) {
      const t = step / 24;
      points.push([
        (1 - t) ** 2 * from[0] + 2 * (1 - t) * t * via[0] + t ** 2 * to[0],
        (1 - t) ** 2 * from[1] + 2 * (1 - t) * t * via[1] + t ** 2 * to[1],
      ]);
    }
  };
  while (index < tokens.length) {
    const command = tokens[index++];
    if (command === 'M') { current = [next(), next()]; start = current; points.push(current); control = null; }
    else if (command === 'L') { current = [next(), next()]; points.push(current); control = null; }
    else if (command === 'H') { current = [next(), current[1]]; points.push(current); control = null; }
    else if (command === 'V') { current = [current[0], next()]; points.push(current); control = null; }
    else if (command === 'Z') { current = start; points.push(current); control = null; }
    else if (command === 'Q') { control = [next(), next()]; const to = [next(), next()]; curve(current, control, to); current = to; }
    else if (command === 'T') { control = [2 * current[0] - control[0], 2 * current[1] - control[1]]; const to = [next(), next()]; curve(current, control, to); current = to; }
    else if (command === 'A') {
      const rx = next(); const ry = next(); next(); const large = next(); const sweep = next();
      const to = [next(), next()];
      // Endpoint to center parameterization, rotation 0.
      const dx = (current[0] - to[0]) / 2; const dy = (current[1] - to[1]) / 2;
      const scale = Math.max(1, Math.sqrt((dx * dx) / (rx * rx) + (dy * dy) / (ry * ry)));
      const ax = rx * scale; const ay = ry * scale;
      const numerator = Math.max(0, ax * ax * ay * ay - ax * ax * dy * dy - ay * ay * dx * dx);
      const factor = (large === sweep ? -1 : 1) * Math.sqrt(numerator / (ax * ax * dy * dy + ay * ay * dx * dx || 1));
      const cxp = factor * (ax * dy) / ay; const cyp = factor * -(ay * dx) / ax;
      const cx = cxp + (current[0] + to[0]) / 2; const cy = cyp + (current[1] + to[1]) / 2;
      const angle = (ux, uy) => Math.atan2(uy, ux);
      const from = angle((dx - cxp) / ax, (dy - cyp) / ay);
      let delta = angle((-dx - cxp) / ax, (-dy - cyp) / ay) - from;
      if (sweep && delta < 0) delta += Math.PI * 2;
      if (!sweep && delta > 0) delta -= Math.PI * 2;
      for (let step = 1; step <= 48; step += 1) {
        const theta = from + (delta * step) / 48;
        points.push([cx + ax * Math.cos(theta), cy + ay * Math.sin(theta)]);
      }
      current = to; control = null;
    }
  }
  return points;
}

function distanceToOutline(outline, [px, py]) {
  const points = flatten(outline);
  let best = Infinity;
  for (let index = 0; index + 1 < points.length; index += 1) {
    const [ax, ay] = points[index];
    const [bx, by] = points[index + 1];
    const length = (bx - ax) ** 2 + (by - ay) ** 2;
    const t = length ? Math.max(0, Math.min(1, ((px - ax) * (bx - ax) + (py - ay) * (by - ay)) / length)) : 0;
    best = Math.min(best, Math.hypot(px - (ax + t * (bx - ax)), py - (ay + t * (by - ay))));
  }
  return best;
}

test('every shape meets its bounding box at the four side midpoints', () => {
  const [x, y, w, h] = [100, 200, 160, 60];
  const midpoints = { left: [x, y + h / 2], right: [x + w, y + h / 2], top: [x + w / 2, y], bottom: [x + w / 2, y + h] };
  for (const shape of NODE_SHAPES.filter((name) => name !== 'rect')) {
    const { outline, sigil, textInset } = shapeGeometry(shape, x, y, w, h);
    assert.match(outline, /^M /, shape);
    assert.match(outline, /Z$/, shape);
    assert.ok(sigil[0] >= 6 && sigil[1] >= 6, `${shape} sigil stays inside`);
    assert.ok(textInset >= 0 && textInset <= 12, `${shape} text inset`);
    for (const [side, point] of Object.entries(midpoints)) {
      assert.ok(distanceToOutline(outline, point) < 0.5, `${shape} leaves its ${side} midpoint by ${distanceToOutline(outline, point).toFixed(2)}px`);
    }
    // Nothing strays more than a few pixels outside the box.
    for (const [px, py] of flatten(outline)) {
      assert.ok(px >= x - 4.5 && px <= x + w + 4.5 && py >= y - 0.5 && py <= y + h + 4.5, `${shape} stays near its box`);
    }
  }
  // Exact checks for the shapes whose midpoint is a vertex or an arc apex.
  assert.match(shapeGeometry('hexagon', x, y, w, h).outline, /L 260 230 /);
  assert.match(shapeGeometry('hexagon', x, y, w, h).outline, /L 100 230 Z$/);
  assert.match(shapeGeometry('shield', x, y, w, h).outline, /L 180 260 /);
  assert.match(shapeGeometry('document', x, y, w, h).outline, /180 260 T 100 260 Z$/);
  const lean = shapeGeometry('parallelogram', x, y, w, h).outline;
  assert.match(lean, /^M 104 200 L 264 200 L 256 260 L 96 260 Z$/);
});

test('a plain node is still two rects and a shaped node carries its box', () => {
  const plain = renderNodeBody({ shape: 'rect', x: 10, y: 20, width: 120, height: 60, fillClass: 'c-backend' });
  assert.equal(plain, `<rect x="10" y="20" width="120" height="60" rx="6" class="c-mask"/>
          <rect x="10" y="20" width="120" height="60" rx="6" class="c-backend" stroke-width="1.5"/>`);
  assert.equal(renderNodeBody({ x: 10, y: 20, width: 120, height: 60, fillClass: 'c-backend' }), plain);

  const shaped = renderNodeBody({ shape: 'cylinder', x: 10, y: 20, width: 120, height: 60, fillClass: 'c-database' });
  assert.match(shaped, /<path d="[^"]+" class="c-mask"\/>/);
  assert.match(shaped, /data-node-shape="cylinder" data-shape-box="10 20 120 60"/);
  assert.match(shaped, /data-node-shape-detail="" d="[^"]+" class="c-database" style="fill:none"/);
  assert.equal(shapeTextWidth('rect', 120, 60), 120);
  assert.ok(shapeTextWidth('subroutine', 120, 60) < 120);
});

test('shape comes from the node, then the role, then falls back to the box', () => {
  const diagram = base();
  assert.equal(nodeShape(diagram, { role: 'cache' }), 'cylinder');
  assert.equal(nodeShape(diagram, { role: 'cache', shape: 'drum' }), 'drum');
  assert.equal(nodeShape(diagram, { type: 'backend' }), 'rect');
  diagram.meta.roles = { vault: { tone: 'database', label: 'Vault', shape: 'pill' } };
  assert.equal(nodeShape(diagram, { role: 'vault' }), 'pill');

  diagram.components[2].role = 'vault';
  diagram.components[3].shape = 'hexagon';
  const { status, html, output } = run(diagram);
  assert.equal(status, 0, output);
  const svg = diagramSvg(html);
  assert.match(svg, /data-node-id="cache"[\s\S]*?data-node-shape="pill"/);
  assert.match(svg, /data-node-id="plain"[\s\S]*?data-node-shape="hexagon"/);
  assert.match(svg, /data-legend-shape="subroutine"/);

  diagram.components[3].shape = 'blob';
  const refused = run(diagram);
  assert.notEqual(refused.status, 0);
  assert.match(refused.output, /shape/);
});

test('a shape narrows the text budget that validation enforces', () => {
  const diagram = base();
  diagram.components[1] = { id: 'recall', type: 'backend', label: 'Recall', sublabel: 'x'.repeat(38), pos: [320, 90], size: [150, 60] };
  assert.equal(run(diagram).status, 0);
  diagram.components[1].shape = 'pipe';
  const narrowed = run(diagram);
  assert.notEqual(narrowed.status, 0);
  assert.match(narrowed.output, /legible minimum/);
});

test('a diagram states what its evidence levels mean', () => {
  const diagram = base();
  diagram.meta.evidence = {
    title: 'Lineage basis',
    note: 'Read from code.',
    levels: { inferred: { label: 'Same cluster only', description: 'Keys were not compared.' } },
  };
  diagram.connections[0].evidence = 'confirmed';
  diagram.connections[2].evidence = 'unverified';
  const { status, html, output } = run(diagram);
  assert.equal(status, 0, output);
  const data = payload(html);
  assert.equal(data.evidenceTitle, 'Lineage basis');
  assert.equal(data.evidenceNote, 'Read from code.');
  assert.deepEqual(data.evidence.map((level) => [level.id, level.label]), [
    ['confirmed', 'Confirmed'], ['inferred', 'Same cluster only'], ['unverified', 'Unverified'],
  ]);
  assert.equal(data.evidence[1].description, 'Keys were not compared.');
  assert.match(diagramSvg(html), />Same cluster only</);

  // A renamed level without its own description does not borrow the generic one.
  diagram.meta.evidence.levels.inferred = { label: 'Renamed' };
  assert.equal(payload(run(diagram).html).evidence[1].description, '');

  diagram.meta.evidence.levels.guessed = { label: 'Nope' };
  const refused = run(diagram);
  assert.notEqual(refused.status, 0);
  assert.match(refused.output, /guessed/);
});

test('details are embedded for nodes and relationships, keyed the way the viewer keys them', () => {
  const diagram = base();
  diagram.components[2].details = [{ label: 'Keys', value: 'stream::{region}|top::item' }, { label: 'Structure', value: 'ZSET' }];
  diagram.connections[1].details = [{ label: 'Key', value: '<script>alert(1)</script>' }];
  const { status, html, output } = run(diagram);
  assert.equal(status, 0, output);
  const data = payload(html);
  assert.deepEqual(Object.keys(data.details.nodes), ['cache']);
  assert.deepEqual(data.details.nodes.cache.map((row) => row.label), ['Keys', 'Structure']);
  assert.deepEqual(Object.keys(data.details.relationships), ['1']);
  assert.match(diagramSvg(html), /data-edge-key="1" data-edge-id="read"/);
  // Authored text never becomes markup.
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.equal(data.details.relationships['1'][0].value, '<script>alert(1)</script>');
  assert.match(html, /id="focus-details"/);

  for (const broken of [
    [{ label: '', value: 'x' }],
    [{ label: 'x', value: '' }],
    [{ label: 'x', value: 'y', extra: true }],
    Array.from({ length: 17 }, (_, index) => ({ label: `r${index}`, value: 'v' })),
    [{ label: 'x', value: 'v'.repeat(401) }],
  ]) {
    const copy = JSON.parse(JSON.stringify(diagram));
    copy.components[2].details = broken;
    assert.notEqual(run(copy).status, 0, JSON.stringify(broken).slice(0, 60));
  }
});

test('scenario wording for the item and for "no difference" reaches the viewer', () => {
  const diagram = base();
  diagram.meta.scenarios = {
    itemLabel: 'graph',
    noDifferenceNote: 'They differ in parameters only.',
    items: [{ id: 'a', label: 'A', nodes: ['engine'] }],
  };
  const { status, html, output } = run(diagram);
  assert.equal(status, 0, output);
  assert.equal(payload(html).scenarios.itemLabel, 'graph');
  assert.equal(payload(html).scenarios.noDifferenceNote, 'They differ in parameters only.');
});
