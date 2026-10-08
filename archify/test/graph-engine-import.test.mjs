import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.resolve(__dirname, '..');
const importer = path.join(skillRoot, 'recipes/graph-engine/import.mjs');
const cli = path.join(skillRoot, 'bin/archify.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archify-graph-engine-'));

// Config Center export shape: every item is a JSON string under full_spec.items.
function namespace(name, items) {
  return {
    states: [{
      id: { project_name: 'demo', name },
      zone: 'global',
      full_spec: { items: Object.fromEntries(Object.entries(items).map(([key, value]) => [key, { key, type: 'JSON', text_value: JSON.stringify(value) }])) },
    }],
  };
}

function graph({ coldStart = false, dump = true } = {}) {
  return {
    dag: {
      prepare: { op: 'PrepareOp', params: { block: { datasource: 'redis_block' } }, outputs: { prepared: { to: 'done' } } },
      recall: { op: 'RecallOp', params: { datasource: 'index_main' }, inputs: { prepared: { to: 'done' } }, outputs: { candidates: { to: 'items' } } },
      ...(coldStart ? { cold: { op: 'RecallOp', params: { datasource: 'index_cold' }, inputs: { prepared: { to: 'done' } }, outputs: { cold_items: { to: 'items' } } } } : {}),
      rank: { op: 'RankOp', params: { datasource: 'model_main', features: { host_datasrc: 'fse_session' } }, inputs: { candidates: { to: 'items' } }, outputs: { ranked: { to: 'items' } } },
      respond: { op: 'ResponseOp', params: {}, inputs: { ranked: { to: 'items' } }, outputs: { response: { to: 'response' } } },
      ...(dump ? { dump: { op: 'RankScoreDumpOp', params: { sink_datasource: 'kafka_dump' }, inputs: { ranked: { to: 'items' } } } } : {}),
    },
  };
}

function write(name, value) {
  const file = path.join(tmp, name);
  fs.writeFileSync(file, JSON.stringify(value));
  return file;
}

const files = {
  bundles: write('bundle.json', namespace('bundle_live_default', {
    home: {
      exp_scene: 'union',
      graph_namespace: 'graph_main',
      graphs: [{
        markets: ['id'],
        groups: {
          new: { request_tag: 'new', graph_name: 'home_new', holdout_graph_name: 'home_holdout' },
          old: { request_tag: 'old', graph_name: 'home_old', holdout_graph_name: 'home_holdout' },
        },
      }],
    },
    detail: {
      graph_namespace: 'graph_main',
      graphs: [{ markets: ['id', 'vn'], groups: { default: { graph_name: 'detail_default' }, lost: { graph_name: 'not_there' } } }],
    },
  })),
  graphs: write('graphs.json', namespace('graph_main_live_default', {
    home_new: graph({ coldStart: true }),
    home_old: graph(),
    home_holdout: graph({ dump: false }),
    detail_default: graph({ dump: false }),
  })),
  datasources: write('datasources.json', namespace('datasource_live_default', {
    redis_block: { source_type: 'redis', config: { url: 'codis.blocklist-live.cache.example' } },
    index_main: { source_type: 'euler' },
    index_cold: { source_type: 'euler' },
    model_main: { source_type: 'rank', config: { service: 'rank.home' } },
    fse_session: { source_type: 'fse', config: { project: 'live', table: 'session_features' } },
    kafka_dump: { source_type: 'kafka_producer', config: { topic: 'rank_score_dump' } },
    unused_store: { source_type: 'redis', config: { url: 'ips.k1x2.elasticredis.example' } },
  })),
  context: write('context.json', {
    service: { id: 'demo', label: 'demo engine' },
    upstream: [{ id: 'gw', label: 'gateway', role: 'gateway' }],
    control: [{ id: 'cc', label: 'Config Center', role: 'config' }, { id: 'ab', label: 'AB platform', role: 'experiment' }],
    flows: [
      {
        id: 'features', label: 'Feature flow', role: 'stream-job', writes: [{ datasource: 'fse_session', evidence: 'confirmed' }],
        jobs: [
          { id: 'SessionFeatureJob', label: 'SessionFeatureJob', writes: [{ datasource: 'fse_session', evidence: 'confirmed' }] },
          { id: 'BlockJob', label: 'BlockJob', writes: [{ datasource: 'redis_block', evidence: 'inferred' }, { datasource: 'unused_store' }] },
          { id: 'ArchiveJob', label: 'ArchiveJob', role: 'batch-job' },
        ],
      },
      { id: 'dump', label: 'Dump flow', role: 'batch-job', reads: [{ datasource: 'kafka_dump', evidence: 'inferred' }] },
      { id: 'orphan', label: 'Orphan flow', writes: [{ datasource: 'unused_store' }] },
    ],
  }),
};

function runImport(extra = []) {
  const out = path.join(tmp, `out-${extra.length}-${Date.now()}.architecture.json`);
  const result = spawnSync(process.execPath, [
    importer,
    '--bundles', files.bundles,
    '--graphs', files.graphs,
    '--datasources', files.datasources,
    '--context', files.context,
    '--out', out,
    ...extra,
  ], { cwd: skillRoot, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return { report: JSON.parse(result.stdout), diagram: JSON.parse(fs.readFileSync(out, 'utf8')), out };
}

test('one scenario per bundle graph, grouped by bundle, with unresolved graphs reported', () => {
  const { report, diagram } = runImport();
  assert.equal(report.bundles, 2);
  assert.equal(report.scenarios, 4);
  assert.equal(report.unresolvedGraphs, 1);
  const ids = diagram.meta.scenarios.items.map((item) => item.id).sort();
  assert.deepEqual(ids, ['detail.detail_default', 'home.home_holdout', 'home.home_new', 'home.home_old']);
  assert.deepEqual(diagram.meta.scenarios.groups.map((group) => group.id).sort(), ['detail', 'home']);
  const holdout = diagram.meta.scenarios.items.find((item) => item.id === 'home.home_holdout');
  assert.match(holdout.label, /holdout/);
  assert.ok(['home.home_new', 'home.home_old'].includes(holdout.compare));
});

test('operators are classified into stages and observation operators are not mistaken for ranking', () => {
  const { report } = runImport();
  assert.deepEqual(report.operatorsByStage.rank, ['RankOp']);
  assert.deepEqual(report.operatorsByStage.observe, ['RankScoreDumpOp']);
  assert.deepEqual(report.operatorsByStage.recall, ['RecallOp']);
  assert.deepEqual(report.stages, ['prepare', 'recall', 'rank', 'output', 'observe']);
});

test('only referenced datasources appear, with roles from their type', () => {
  const { diagram } = runImport();
  const byId = Object.fromEntries(diagram.components.map((component) => [component.id, component]));
  assert.equal(byId.ds_redis_block.role, 'cache');
  assert.equal(byId.ds_index_main.role, 'index');
  assert.equal(byId.ds_model_main.role, 'model');
  assert.equal(byId.ds_fse_session.role, 'featurestore');
  assert.equal(byId.ds_kafka_dump.role, 'topic');
  // Labels name the store; the datasource name moves to the sublabel.
  assert.deepEqual([byId.ds_redis_block.label, byId.ds_redis_block.sublabel], ['blocklist-live', 'redis_block']);
  assert.deepEqual([byId.ds_fse_session.label, byId.ds_fse_session.sublabel], ['session_features', 'fse_session']);
  assert.deepEqual([byId.ds_kafka_dump.label, byId.ds_kafka_dump.sublabel], ['rank_score_dump', 'kafka_dump']);
  assert.deepEqual([byId.ds_model_main.label, byId.ds_model_main.sublabel], ['rank.home', 'model_main']);
  assert.deepEqual([byId.ds_index_main.label, byId.ds_index_main.sublabel], ['index_main', 'euler']);
  assert.equal(byId.ds_unused_store?.label, undefined, 'unreferenced datasources are not drawn');
  assert.equal(byId.ds_unused_store, undefined);
  assert.equal(byId.flow_orphan, undefined);
});

test('scenario membership follows each graph, not the union', () => {
  const { diagram } = runImport();
  const item = (id) => diagram.meta.scenarios.items.find((entry) => entry.id === id);
  assert.ok(item('home.home_new').nodes.includes('ds_index_cold'));
  assert.ok(!item('home.home_old').nodes.includes('ds_index_cold'));
  assert.ok(item('home.home_old').nodes.includes('flow_dump'));
  assert.ok(!item('home.home_holdout').nodes.includes('stage_observe'));
  assert.ok(!item('home.home_holdout').nodes.includes('flow_dump'));
  assert.match(item('home.home_new').annotations.stage_recall, /RecallOp×2/);
  assert.match(item('home.home_new').note, /id\/new\(new\)/);
});

test('lineage keeps direction and evidence', () => {
  const { diagram } = runImport();
  const write = diagram.connections.find((connection) => connection.id === 'write_features_fse_session');
  assert.deepEqual([write.from, write.to, write.evidence], ['flow_features', 'ds_fse_session', 'confirmed']);
  const read = diagram.connections.find((connection) => connection.id === 'read_dump_kafka_dump');
  assert.deepEqual([read.from, read.to, read.evidence], ['ds_kafka_dump', 'flow_dump', 'inferred']);
});

test('--bundle narrows the import and --link-template fills scenario links', () => {
  const { report, diagram } = runImport(['--bundle', 'detail', '--link-template', 'https://graphs.example/view?bundle={bundle}&graph={graph}']);
  assert.equal(report.bundles, 1);
  assert.equal(diagram.meta.scenarios.items[0].link, 'https://graphs.example/view?bundle=detail&graph=detail_default');
});

test('the generated diagram passes validation and renders', () => {
  const { out } = runImport();
  const html = path.join(tmp, 'generated.html');
  const result = spawnSync(process.execPath, [cli, 'render', 'architecture', out, html], { cwd: skillRoot, encoding: 'utf8' });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const rendered = fs.readFileSync(html, 'utf8');
  assert.match(rendered, /id="archify-extensions-data"/);
  assert.match(rendered, /data-node-role="engine"/);
});

test('--expand-flows draws one node per job and keeps jobs nothing online consumes', () => {
  const collapsed = runImport();
  assert.equal(collapsed.report.jobs, 0);
  assert.ok(collapsed.diagram.components.some((component) => component.id === 'flow_features'));

  const { report, diagram, out } = runImport(['--expand-flows']);
  assert.equal(report.jobs, 4);
  assert.equal(report.jobsWithoutOnlineConsumer, 1);
  const byId = Object.fromEntries(diagram.components.map((component) => [component.id, component]));
  assert.equal(byId.flow_features, undefined);
  assert.equal(byId.job_SessionFeatureJob.role, 'stream-job');
  assert.equal(byId.job_ArchiveJob.role, 'batch-job');
  // A flow without a job list is drawn as one unit.
  assert.ok(byId.job_dump);
  // Linked jobs stand next to the channels, the rest to their right.
  assert.ok(byId.job_ArchiveJob.pos[0] > byId.job_SessionFeatureJob.pos[0]);
  assert.equal(byId.job_BlockJob.pos[0], byId.job_SessionFeatureJob.pos[0]);

  const edges = diagram.connections.filter((connection) => /^(write|read)_/.test(connection.id));
  assert.deepEqual(edges.map((edge) => edge.id).sort(), [
    'read_dump_kafka_dump', 'write_BlockJob_redis_block', 'write_SessionFeatureJob_fse_session',
  ]);
  const family = diagram.boundaries.find((boundary) => boundary.label.startsWith('Feature flow'));
  assert.match(family.label, /3 jobs · 1 without a known online consumer/);
  assert.deepEqual(family.wraps.sort(), ['job_ArchiveJob', 'job_BlockJob', 'job_SessionFeatureJob']);

  const item = (id) => diagram.meta.scenarios.items.find((entry) => entry.id === id);
  assert.ok(item('home.home_new').nodes.includes('job_SessionFeatureJob'));
  assert.ok(item('home.home_new').nodes.includes('job_BlockJob'));
  assert.ok(!item('home.home_new').nodes.includes('job_ArchiveJob'));
  assert.ok(!item('home.home_holdout').nodes.includes('job_dump'));

  const html = path.join(tmp, 'expanded.html');
  const result = spawnSync(process.execPath, [cli, 'render', 'architecture', out, html], { cwd: skillRoot, encoding: 'utf8' });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('five collapsed flows keep every channel clear of the flow column', () => {
  const context = JSON.parse(fs.readFileSync(files.context, 'utf8'));
  context.flows = ['redis_block', 'index_main', 'model_main', 'fse_session', 'kafka_dump'].map((datasource, index) => ({
    id: `flow${index}`, label: `Flow ${index}`, writes: [{ datasource, evidence: 'inferred' }],
  }));
  const contextFile = write('five-flows.json', context);
  const out = path.join(tmp, 'five-flows.architecture.json');
  const imported = spawnSync(process.execPath, [
    importer, '--bundles', files.bundles, '--graphs', files.graphs, '--datasources', files.datasources,
    '--context', contextFile, '--out', out,
  ], { cwd: skillRoot, encoding: 'utf8' });
  assert.equal(imported.status, 0, imported.stderr);
  assert.equal(JSON.parse(imported.stdout).flows, 5);
  const rendered = spawnSync(process.execPath, [cli, 'render', 'architecture', out, path.join(tmp, 'five-flows.html')], { cwd: skillRoot, encoding: 'utf8' });
  assert.equal(rendered.status, 0, `${rendered.stdout}\n${rendered.stderr}`);
});

test('a flow that both writes and reads one datasource gets two distinct relationships', () => {
  const context = JSON.parse(fs.readFileSync(files.context, 'utf8'));
  context.flows = [{
    id: 'both', label: 'Both ways',
    writes: [{ datasource: 'redis_block', evidence: 'inferred' }, { datasource: 'redis_block', evidence: 'confirmed' }],
    reads: [{ datasource: 'redis_block', evidence: 'unverified' }],
  }];
  const contextFile = write('both-ways.json', context);
  const out = path.join(tmp, 'both-ways.architecture.json');
  const imported = spawnSync(process.execPath, [
    importer, '--bundles', files.bundles, '--graphs', files.graphs, '--datasources', files.datasources,
    '--context', contextFile, '--out', out,
  ], { cwd: skillRoot, encoding: 'utf8' });
  assert.equal(imported.status, 0, imported.stderr);
  const diagram = JSON.parse(fs.readFileSync(out, 'utf8'));
  const lineage = diagram.connections.filter((connection) => /^(write|read)_both_/.test(connection.id));
  assert.deepEqual(lineage.map((edge) => [edge.id, edge.evidence]).sort(), [
    ['read_both_redis_block', 'unverified'], ['write_both_redis_block', 'inferred'],
  ]);
});

test('details, evidence wording and scenario wording travel from context into the diagram', () => {
  const context = JSON.parse(fs.readFileSync(files.context, 'utf8'));
  context.evidence = { title: 'Lineage basis', levels: { confirmed: { label: 'Key matched', description: 'Same key on both sides.' } } };
  context.scenarioItemLabel = 'graph';
  context.datasources = { fse_session: { details: [{ label: 'Table', value: 'session.features' }] } };
  context.flows[0].writes[0].details = [{ label: 'Key', value: 'session:{id}' }, { label: '', value: 'dropped' }, { label: 'Long', value: 'x'.repeat(500) }];
  const contextFile = write('details.json', context);
  const out = path.join(tmp, 'details.architecture.json');
  const imported = spawnSync(process.execPath, [
    importer, '--bundles', files.bundles, '--graphs', files.graphs, '--datasources', files.datasources,
    '--context', contextFile, '--out', out,
  ], { cwd: skillRoot, encoding: 'utf8' });
  assert.equal(imported.status, 0, imported.stderr);
  const diagram = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(diagram.meta.evidence.title, 'Lineage basis');
  assert.equal(diagram.meta.scenarios.itemLabel, 'graph');
  assert.ok(diagram.meta.scenarios.noDifferenceNote.length > 0);
  const store = diagram.components.find((component) => component.id === 'ds_fse_session');
  assert.deepEqual(store.details, [{ label: 'Table', value: 'session.features' }]);
  const edge = diagram.connections.find((connection) => connection.id === 'write_features_fse_session');
  assert.deepEqual(edge.details.map((row) => row.label), ['Key', 'Long']);
  assert.equal(edge.details[1].value.length, 400);
  const stage = diagram.components.find((component) => component.id === 'stage_recall');
  assert.match(stage.details[0].value, /RecallOp/);
  const rendered = spawnSync(process.execPath, [cli, 'render', 'architecture', out, path.join(tmp, 'details.html')], { cwd: skillRoot, encoding: 'utf8' });
  assert.equal(rendered.status, 0, `${rendered.stdout}\n${rendered.stderr}`);
  const html = fs.readFileSync(path.join(tmp, 'details.html'), 'utf8');
  assert.match(html, /"evidenceTitle":"Lineage basis"/);
  assert.match(html, /"label":"Key matched","description":"Same key on both sides\."/);
});
