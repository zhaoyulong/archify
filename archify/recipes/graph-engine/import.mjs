#!/usr/bin/env node
// Graph-engine importer.
//
// Turns the configuration of a config-driven DAG service into one 
// architecture diagram:
//
//   stage spine      operators of every graph, grouped into ordered stages
//   datasource rows  each datasource beside the stage that uses it most
//   offline flows    optional lineage: which flow writes which datasource
//   scenarios        one per (bundle, graph); switch and compare in the viewer
//
// The exact per-node DAG stays in the service's own graph tool. This diagram
// answers the level above it: what a bundle runs, what it reads, and which
// offline flow feeds that.
//
// Usage:
//   node recipes/graph-engine/import.mjs \
//     --bundles bundle.json --graphs graph_a.json graph_b.json \
//     [--datasources datasource.json] [--context context.json] [--stages stages.json] \
//     [--bundle NAME ...] [--title TEXT] [--locale zh-CN] [--link-template URL] \
//     --out service.architecture.json
//
// Input files are Config Center exports ({"states":[{"zone","full_spec":{"items":{...}}}]})
// or plain JSON maps of name -> object. See recipes/graph-engine/README.md.

import fs from 'node:fs';
import path from 'node:path';
import { textUnits } from '../../renderers/shared/utils.mjs';

// ---------------------------------------------------------------- arguments
function parseArgs(argv) {
  const multi = new Set(['graphs', 'bundle']);
  const args = { graphs: [], bundle: [] };
  let key = null;
  for (const token of argv) {
    if (token.startsWith('--')) {
      key = token.slice(2);
      if (!multi.has(key)) args[key] = true;
      continue;
    }
    if (!key) throw new Error(`unexpected argument ${JSON.stringify(token)}`);
    if (multi.has(key)) args[key].push(token);
    else { args[key] = token; key = null; }
  }
  return args;
}

function fail(message) {
  console.error(`graph-engine import: ${message}`);
  process.exit(1);
}

// ------------------------------------------------------------------ loading
function parseMaybeJson(value) {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return null; }
}

// Returns { name, items: Map<string, object> } for one namespace export.
function loadNamespace(file, zone = 'global') {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const items = new Map();
  let name = path.basename(file).replace(/\.json$/i, '');
  if (Array.isArray(raw.states)) {
    const state = raw.states.find((entry) => entry.zone === zone) || raw.states[0];
    if (state?.id?.name) name = state.id.name;
    for (const [key, item] of Object.entries(state?.full_spec?.items || {})) {
      const parsed = parseMaybeJson(item?.text_value ?? item);
      if (parsed && typeof parsed === 'object') items.set(key, parsed);
    }
  } else {
    for (const [key, value] of Object.entries(raw)) {
      const parsed = parseMaybeJson(value);
      if (parsed && typeof parsed === 'object') items.set(key, parsed);
    }
  }
  return { name, items };
}

// ------------------------------------------------------------------- stages
// Ordered. The first rule whose pattern matches the operator type wins.
const DEFAULT_STAGES = [
  { id: 'prepare', label: ['Prepare', '准备'], match: ['^Prepare', 'UserEmb', 'ContextFeature', 'Profile'] },
  { id: 'recall', label: ['Recall', '召回'], match: ['Recall', '^Join'] },
  { id: 'filter', label: ['Filter / strategy', '过滤 / 策略'], match: ['Strategy', 'Dedup', 'Imp', 'View', 'Filter', 'Column'] },
  { id: 'rank', label: ['Rank', '排序'], match: ['Rank', 'Score', 'Fusion', 'Quantile', 'Ltr'] },
  { id: 'mix', label: ['Mix / quota', '混排 / 配额'], match: ['Mix', 'Quota', 'Reorder', 'Shuffle', 'Merge', 'Limit', 'Sort'] },
  { id: 'ads', label: ['Ads', '广告'], match: ['Ads', 'Bidding', 'Deduction'] },
  { id: 'output', label: ['Output', '输出'], match: ['Response', 'Fill', 'Result'] },
  { id: 'observe', label: ['Dump / trace', 'Dump / 追踪'], match: ['Dump', 'Trace', 'Log', 'TrafficCount'] },
];

// Observation operators match "Rank" or "Ads" in their names too, so they are
// tested first. Ads operators are tested before the generic recall/rank rules.
const MATCH_PRIORITY = ['observe', 'ads', 'prepare', 'recall', 'filter', 'rank', 'mix', 'output'];

const DEFAULT_DATASOURCE_ROLES = {
  redis: 'cache',
  fse: 'featurestore',
  solar_feature: 'featurestore',
  euler: 'index',
  rank: 'model',
  kafka_producer: 'topic',
};

function compileStages(stages, priority) {
  const compiled = stages.map((stage) => ({
    ...stage,
    patterns: (stage.match || []).map((pattern) => new RegExp(pattern)),
  }));
  const order = priority && priority.length
    ? priority.map((id) => compiled.find((stage) => stage.id === id)).filter(Boolean)
    : compiled;
  const rest = compiled.filter((stage) => !order.includes(stage));
  const tests = [...order, ...rest];
  return {
    list: compiled,
    classify(opType) {
      const hit = tests.find((stage) => stage.patterns.some((pattern) => pattern.test(opType)));
      return hit ? hit.id : 'other';
    },
  };
}

// ----------------------------------------------------------------- analysis
function collectDatasources(value, known, found) {
  if (Array.isArray(value)) value.forEach((entry) => collectDatasources(entry, known, found));
  else if (value && typeof value === 'object') Object.values(value).forEach((entry) => collectDatasources(entry, known, found));
  else if (typeof value === 'string' && known.has(value)) found.add(value);
}

function analyzeGraph(graph, stages, knownDatasources) {
  const dag = graph.dag && typeof graph.dag === 'object' ? graph.dag : graph;
  const nodeStage = new Map();
  const stageOps = new Map();          // stage -> Map<opType, count>
  const datasourceStages = new Map();  // datasource -> Map<stage, count>
  const producers = new Map();
  const consumers = new Map();

  for (const [name, node] of Object.entries(dag)) {
    if (!node || typeof node !== 'object' || typeof node.op !== 'string') continue;
    const stage = stages.classify(node.op);
    nodeStage.set(name, stage);
    if (!stageOps.has(stage)) stageOps.set(stage, new Map());
    stageOps.get(stage).set(node.op, (stageOps.get(stage).get(node.op) || 0) + 1);

    const used = new Set();
    collectDatasources(node.params, knownDatasources, used);
    for (const datasource of used) {
      if (!datasourceStages.has(datasource)) datasourceStages.set(datasource, new Map());
      const counts = datasourceStages.get(datasource);
      counts.set(stage, (counts.get(stage) || 0) + 1);
    }
    for (const key of Object.keys(node.outputs || {})) {
      if (!producers.has(key)) producers.set(key, []);
      producers.get(key).push(name);
    }
    for (const key of Object.keys(node.inputs || {})) {
      if (!consumers.has(key)) consumers.set(key, []);
      consumers.get(key).push(name);
    }
  }

  const stageEdges = new Map();        // "a>b" -> count
  for (const [key, targets] of consumers) {
    for (const source of producers.get(key) || []) {
      for (const target of targets) {
        const from = nodeStage.get(source);
        const to = nodeStage.get(target);
        if (!from || !to || from === to) continue;
        const edge = `${from}>${to}`;
        stageEdges.set(edge, (stageEdges.get(edge) || 0) + 1);
      }
    }
  }
  return { nodeCount: nodeStage.size, stageOps, datasourceStages, stageEdges };
}

// "RecallOp×2" reads as "two kinds" to some readers. It counts nodes: this
// graph has two nodes whose operator type is RecallOp. Chinese output spells
// that out; the cards explain the notation for English output.
function summarizeOps(ops, limit = 4, chinese = false) {
  const sorted = [...ops.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
  const shown = sorted.slice(0, limit).map(([op, count]) => (
    chinese ? `${op} ${count} 个` : (count > 1 ? `${op}×${count}` : op)
  ));
  const hidden = sorted.length - shown.length;
  return hidden > 0 ? `${shown.join(', ')} +${hidden}` : shown.join(', ');
}

// --------------------------------------------------------------------- main
const args = parseArgs(process.argv.slice(2));
if (args.help || !args.bundles || !args.graphs.length || !args.out) {
  console.log('usage: import.mjs --bundles FILE --graphs FILE... [--datasources FILE] [--context FILE] [--stages FILE] [--bundle NAME...] [--expand-flows] [--title TEXT] [--locale en|zh-CN] [--link-template URL] --out FILE');
  process.exit(args.help ? 0 : 1);
}

const locale = args.locale === 'zh-CN' ? 'zh-CN' : 'en';
const L = locale === 'zh-CN' ? 1 : 0;
const text = (pair) => (Array.isArray(pair) ? pair[L] ?? pair[0] : pair);

const stageConfig = args.stages ? JSON.parse(fs.readFileSync(args.stages, 'utf8')) : {};
const stages = compileStages(stageConfig.stages || DEFAULT_STAGES, stageConfig.priority || (stageConfig.stages ? null : MATCH_PRIORITY));
const datasourceRoles = { ...DEFAULT_DATASOURCE_ROLES, ...(stageConfig.datasourceRoles || {}) };
const context = args.context ? JSON.parse(fs.readFileSync(args.context, 'utf8')) : {};

const bundles = loadNamespace(args.bundles).items;
const graphNamespaces = args.graphs.map((file) => loadNamespace(file));
const datasourceItems = args.datasources ? loadNamespace(args.datasources).items : new Map();
const knownDatasources = new Set(datasourceItems.keys());

function namespaceFor(prefix) {
  if (!prefix) return null;
  return graphNamespaces.find((namespace) => namespace.name === prefix)
    || graphNamespaces.find((namespace) => namespace.name.startsWith(`${prefix}_`) && !namespace.name.startsWith(`${prefix}_nonid`))
    || graphNamespaces.find((namespace) => namespace.name.startsWith(`${prefix}_`))
    || null;
}

function namespacePrefixFor(bundle, markets) {
  const mapping = bundle.graph_namespace_mapping;
  if (mapping && typeof mapping === 'object') {
    const wanted = new Set((markets || []).map((market) => String(market).toLowerCase()));
    for (const [prefix, rule] of Object.entries(mapping)) {
      if ((rule?.markets || []).some((market) => wanted.has(String(market).toLowerCase()))) return prefix;
    }
  }
  return bundle.graph_namespace || null;
}

// (bundle, graph) -> usage
const selected = new Set(args.bundle);
const usages = new Map();
const missing = [];
for (const [bundleName, bundle] of bundles) {
  if (selected.size && !selected.has(bundleName)) continue;
  for (const entry of Array.isArray(bundle.graphs) ? bundle.graphs : []) {
    const prefix = namespacePrefixFor(bundle, entry.markets);
    const namespace = namespaceFor(prefix);
    for (const [groupName, group] of Object.entries(entry.groups || {})) {
      const variants = [
        { graph: group?.graph_name, holdout: false },
        { graph: group?.holdout_graph_name, holdout: true },
      ].filter((variant) => typeof variant.graph === 'string' && variant.graph);
      for (const variant of variants) {
        const graph = namespace?.items.get(variant.graph)
          || graphNamespaces.map((candidate) => candidate.items.get(variant.graph)).find(Boolean);
        if (!graph) { missing.push(`${bundleName}/${variant.graph}`); continue; }
        const key = `${bundleName}\u0000${variant.graph}`;
        if (!usages.has(key)) {
          usages.set(key, {
            bundle: bundleName,
            graphName: variant.graph,
            holdout: variant.holdout,
            namespace: namespace?.name || prefix || '',
            expScene: bundle.exp_scene || null,
            users: [],
            analysis: analyzeGraph(graph, stages, knownDatasources),
            primary: null,
          });
        }
        const usage = usages.get(key);
        usage.users.push({ markets: entry.markets || [], group: groupName, tag: group?.request_tag || '' });
        if (variant.holdout && group?.graph_name) usage.primary = group.graph_name;
      }
    }
  }
}
if (!usages.size) fail('no graph could be resolved; check --bundles, --graphs and --bundle');

// ------------------------------------------------------------ union model
const stageIds = [...stages.list.map((stage) => stage.id), 'other'];
const presentStages = stageIds.filter((id) => [...usages.values()].some((usage) => usage.analysis.stageOps.has(id)));
const stageLabel = (id) => {
  const stage = stages.list.find((entry) => entry.id === id);
  return stage ? text(stage.label) : (L ? '其他' : 'Other');
};

const datasourceTotals = new Map();  // datasource -> Map<stage, count> across graphs
for (const usage of usages.values()) {
  for (const [datasource, counts] of usage.analysis.datasourceStages) {
    if (!datasourceTotals.has(datasource)) datasourceTotals.set(datasource, new Map());
    const total = datasourceTotals.get(datasource);
    for (const [stage, count] of counts) total.set(stage, (total.get(stage) || 0) + count);
  }
}
const primaryStage = new Map();
for (const [datasource, counts] of datasourceTotals) {
  const ranked = [...counts.entries()].sort((left, right) => (
    right[1] - left[1] || presentStages.indexOf(left[0]) - presentStages.indexOf(right[0])
  ));
  primaryStage.set(datasource, ranked[0][0]);
}

// Offline flows. A flow either writes a datasource the service reads, or reads
// one the service produces (for example a dump topic). Both directions are
// lineage. Links to datasources no imported graph references are dropped.
//
// With --expand-flows a flow that lists `jobs` is drawn job by job. A job
// without any remaining link is kept: showing that nothing online is known to
// consume it is the point of expanding.
const expandFlows = Boolean(args['expand-flows']);
function lineageLinks(entity) {
  const seen = new Set();
  return [
    ...(entity.writes || []).map((link) => ({ ...link, direction: 'write' })),
    ...(entity.reads || []).map((link) => ({ ...link, direction: 'read' })),
  ].filter((link) => {
    // One relationship per datasource and direction; the first one wins.
    const key = `${link.direction}\u0000${link.datasource}`;
    if (!datasourceTotals.has(link.datasource) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
const flows = (context.flows || []).map((flow) => {
  const jobs = expandFlows && Array.isArray(flow.jobs) && flow.jobs.length
    ? flow.jobs.map((job) => ({ ...job, links: lineageLinks(job) }))
    : null;
  const jobNames = Array.isArray(flow.jobs) ? flow.jobs.map((job) => job.label || job.id) : null;
  return { ...flow, writes: lineageLinks(flow), jobs, jobNames };
}).filter((flow) => (flow.jobs ? flow.jobs.length : flow.writes.length));
const expanded = flows.some((flow) => flow.jobs);

// ------------------------------------------------------------------ layout
// Vertical spine on the left, datasources to the right of their stage, flows
// in the rightmost column.
//
//   x:  [callers] [engine + stages] | trunk | [datasource x3] | channels | [flows]
//
// Every stage owns a horizontal band. Inside a band each datasource line has a
// bus 12px above it; a vertical trunk joins the stage to those buses. Flow
// routes run under a datasource line, one lane per flow, then up a private
// channel next to the flow column. No route shares a lane with another stage
// or another flow.
const JOB_W = 252;
const JOB_H = 38;
const JOB_PITCH = 48;
// What a datasource physically is, read from its definition: a table, a
// topic, a cluster (the first host label that is not a transport prefix such
// as `codis.` or `ips.`) or a service name. Null when the definition names
// nothing recognisable.
const HOST_PREFIXES = new Set(['codis', 'ips', 'redis']);
function storeName(definition) {
  const config = definition.config && typeof definition.config === 'object' ? definition.config : definition;
  const text = (key) => (typeof config[key] === 'string' && config[key].trim() ? config[key].trim() : null);
  if (text('table')) return text('table');
  if (text('topic')) return text('topic');
  const host = text('url') || text('host') || text('address') || text('endpoint');
  if (host) {
    const labels = host.replace(/^[a-z]+:\/\//i, '').split(/[/:,]/)[0].split('.');
    while (labels.length > 1 && HOST_PREFIXES.has(labels[0])) labels.shift();
    return labels[0];
  }
  return text('service') || text('name') || null;
}

const JOB_GAP_X = 16;
const JOB_CHANNEL_GAP = 10;
const X_CALLER = 30;
const X_STAGE = 250;
const NODE_W = 170;
const NODE_H = 56;
const X_TRUNK = X_STAGE + NODE_W + 35;
const X_DS = 490;
// Datasource nodes share one width: the default, or wider when the widest
// store label needs it: the validator's estimate plus the sigil on each side of the centred text.
const storeLabel = (datasource) => (
  context.datasources?.[datasource]?.label || storeName(datasourceItems.get(datasource) || {}) || datasource
);
const DS_W = Math.max(210, ...[...datasourceTotals.keys()].map((datasource) => Math.ceil(textUnits(storeLabel(datasource)) * 6.6 + 48)));
const DS_GAP = 14;
const DS_PER_LINE = 3;
const DS_H = 46;
const DS_H_TAGGED = 58;
const LINE_PITCH = 112;
const FLOW_W = 150;
const X_CHANNEL = X_DS + DS_PER_LINE * (DS_W + DS_GAP) + 4;
const X_FLOW = X_CHANNEL + 44;  // the strip between holds the flow channels
const VIEW_WIDTH = X_FLOW + FLOW_W + 40;  // room for the flow boundary frame
let viewWidth = VIEW_WIDTH;
const CHANNEL_GAP = 11;
const TOP_Y = 56;
const FIRST_BAND_Y = TOP_Y + NODE_H + 84;


const id = (prefix, value) => `${prefix}_${String(value).replace(/[^a-zA-Z0-9_-]/g, '_')}`;

// Detail rows shown when the reader opens a node or a relationship. Authored
// rows come first; the schema allows 16 rows of 400 characters.
function detailRows(...groups) {
  const rows = [];
  for (const group of groups) {
    for (const row of group || []) {
      const label = String(row?.label ?? '').trim().slice(0, 40);
      let value = String(row?.value ?? '').trim();
      if (!label || !value) continue;
      if (value.length > 400) value = `${value.slice(0, 399)}…`;
      rows.push({ label, value });
    }
  }
  return rows.length ? { details: rows.slice(0, 16) } : {};
}
const dsX = (column) => X_DS + column * (DS_W + DS_GAP);

const components = [];
const connections = [];
const boundaries = [];

// Top row: callers, the engine itself, then control-plane nodes.
const callers = (context.upstream || []).slice(0, 1).map((node) => ({ ...node, role: node.role || 'gateway' }));
const controls = (context.control || []).slice(0, DS_PER_LINE).map((node) => ({ ...node, role: node.role || 'config' }));
const engineId = id('engine', context.service?.id || 'engine');
components.push({
  id: engineId, role: 'engine',
  label: context.service?.engineLabel || (L ? '图引擎运行时' : 'Graph engine runtime'),
  sublabel: L ? `${usages.size} 个 graph · 按 bundle 选图` : `${usages.size} graphs · one per bundle group`,
  ...detailRows(context.service?.details, [
    { label: L ? 'bundle 数' : 'Bundles', value: String(new Set([...usages.values()].map((usage) => usage.bundle)).size) },
    { label: L ? 'graph 数' : 'Graphs', value: String(usages.size) },
    { label: L ? 'graph 命名空间' : 'Graph namespaces', value: graphNamespaces.map((namespace) => namespace.name).join(', ') },
  ]),
  pos: [X_STAGE, TOP_Y], size: [NODE_W, NODE_H],
});
callers.forEach((node) => {
  components.push({
    id: id('ctx', node.id), role: node.role, label: node.label,
    ...(node.sublabel ? { sublabel: node.sublabel } : {}),
    ...(node.link ? { link: node.link } : {}),
    ...detailRows(node.details),
    pos: [X_CALLER, TOP_Y], size: [NODE_W, NODE_H],
  });
  connections.push({
    id: id('ctx_edge', node.id), from: id('ctx', node.id), to: engineId,
    variant: 'emphasis',
  });
});
controls.forEach((node, index) => {
  components.push({
    id: id('ctx', node.id), role: node.role, label: node.label,
    ...(node.sublabel ? { sublabel: node.sublabel } : {}),
    ...(node.link ? { link: node.link } : {}),
    ...detailRows(node.details),
    pos: [dsX(index), TOP_Y + (NODE_H - DS_H) / 2], size: [DS_W, DS_H],
  });
  // The first control node faces the engine. Later ones loop over the row.
  const loopY = TOP_Y - 14 - (index - 1) * 9;
  connections.push({
    id: id('ctx_edge', node.id), from: id('ctx', node.id), to: engineId,
    variant: 'security',
    ...(index === 0
      ? {}
      : {
        fromSide: 'top',
        toSide: 'top',
        via: [[dsX(index) + DS_W / 2, loopY], [X_STAGE + NODE_W / 2, loopY]],
      }),
  });
});
const topNodes = [...callers, ...controls];

// Datasource stacks per stage, most used first.
const stacks = new Map(presentStages.map((stageId) => [stageId, []]));
for (const [datasource, stage] of primaryStage) stacks.get(stage)?.push(datasource);
const usageCount = (datasource) => [...datasourceTotals.get(datasource).values()].reduce((sum, count) => sum + count, 0);

const stagePosition = new Map();
const datasourcePosition = new Map();
let cursorY = FIRST_BAND_Y;
presentStages.forEach((stageId) => {
  const stack = stacks.get(stageId).sort((left, right) => usageCount(right) - usageCount(left) || left.localeCompare(right));
  const lines = Math.max(1, Math.ceil(stack.length / DS_PER_LINE));
  stagePosition.set(stageId, { y: cursorY, lines });

  const opTypes = new Set();
  for (const usage of usages.values()) for (const op of usage.analysis.stageOps.get(stageId)?.keys() || []) opTypes.add(op);
  components.push({
    id: id('stage', stageId), role: 'operator', label: stageLabel(stageId),
    sublabel: L ? `${opTypes.size} 种算子` : `${opTypes.size} operator types`,
    ...detailRows([
      { label: L ? `算子类型（${opTypes.size} 种）` : `Operator types (${opTypes.size})`, value: [...opTypes].sort().join(', ') },
      { label: L ? '出现在' : 'Present in', value: `${[...usages.values()].filter((usage) => usage.analysis.stageOps.has(stageId)).length} / ${usages.size} graph` },
      { label: L ? '直接使用的数据源' : 'Datasources beside it', value: stack.join(', ') },
    ]),
    pos: [X_STAGE, cursorY], size: [NODE_W, NODE_H],
  });

  stack.forEach((datasource, index) => {
    const line = Math.floor(index / DS_PER_LINE);
    const column = index % DS_PER_LINE;
    const definition = datasourceItems.get(datasource) || {};
    const type = definition.source_type || definition.type || '';
    const others = [...datasourceTotals.get(datasource).keys()].filter((stage) => stage !== stageId);
    const height = others.length ? DS_H_TAGGED : DS_H;
    const x = dsX(column);
    const y = cursorY + line * LINE_PITCH;
    datasourcePosition.set(datasource, { x, y, height, column, stage: stageId });
    // The node shows the store itself; the datasource name stays as the
    // sublabel because that is what graph params and the service's config
    // call it.
    const label = storeLabel(datasource);
    components.push({
      id: id('ds', datasource), role: datasourceRoles[type] || 'service', label,
      ...(label !== datasource ? { sublabel: datasource } : type ? { sublabel: type } : {}),
      ...(others.length ? { tag: `+ ${others.map(stageLabel).join(' · ')}`.slice(0, 34) } : {}),
      ...detailRows(context.datasources?.[datasource]?.details, context.datasources?.[datasource]?.details ? [] : [
        { label: L ? 'datasource 配置名' : 'Datasource', value: datasource },
        { label: L ? '类型' : 'Type', value: type },
        { label: L ? '使用它的阶段' : 'Used by stages', value: [...datasourceTotals.get(datasource).keys()].map(stageLabel).join(', ') },
      ]),
      pos: [x, y], size: [DS_W, height],
    });
    const busY = y - 12;
    connections.push({
      id: id('use', `${stageId}_${datasource}`),
      from: id('stage', stageId),
      to: id('ds', datasource),
      fromSide: 'right',
      toSide: 'top',
      via: [[X_TRUNK, cursorY + NODE_H / 2], [X_TRUNK, busY], [x + DS_W / 2, busY]],
    });
  });
  cursorY += lines * LINE_PITCH + 18;
});
const contentBottom = cursorY - 18 - LINE_PITCH + DS_H_TAGGED;

boundaries.push({
  kind: 'security-group',
  label: context.service?.label || (L ? '图引擎' : 'Graph engine'),
  wraps: [engineId, ...presentStages.map((stageId) => id('stage', stageId))],
  pad: 14,
});

// Spine: engine, then consecutive stages in configured order.
const spine = [engineId, ...presentStages.map((stageId) => id('stage', stageId))];
for (let index = 0; index + 1 < spine.length; index += 1) {
  connections.push({
    id: id('spine', `${index}_${index + 1}`),
    from: spine[index],
    to: spine[index + 1],
    variant: 'emphasis',
  });
}

// Lineage units: what a scenario switches on and off. One per flow, or one
// per job when flows are expanded.
const units = [];
const flowBottoms = [];

function lineageEdge(unit, link, route) {
  const edgeId = id(link.direction === 'read' ? 'read' : 'write', `${unit.key}_${link.datasource}`);
  connections.push({
    id: edgeId,
    variant: 'dashed',
    evidence: link.evidence || 'unverified',
    ...detailRows(link.details),
    ...(link.direction === 'read'
      ? { from: id('ds', link.datasource), to: unit.nodeId, fromSide: 'bottom', toSide: 'left', via: [...route].reverse() }
      : { from: unit.nodeId, to: id('ds', link.datasource), fromSide: 'left', toSide: 'bottom', via: route }),
  });
  unit.links.push({ datasource: link.datasource, edgeId });
}

if (!expanded) {
  // One box per flow in the right column, near what it touches.
  flows.forEach((flow, flowIndex) => {
    const targets = flow.writes.map((link) => datasourcePosition.get(link.datasource));
    const wanted = targets.reduce((sum, target) => sum + target.y, 0) / targets.length;
    let y = Math.max(FIRST_BAND_Y, Math.round(wanted));
    for (const slot of flowBottoms) {
      if (y < slot + 40) y = slot + 40;
    }
    flowBottoms.push(y + NODE_H);
    const unit = { key: flow.id, nodeId: id('flow', flow.id), links: [] };
    units.push(unit);
    components.push({
      id: unit.nodeId, role: flow.role || 'stream-job', label: flow.label,
      ...(flow.sublabel ? { sublabel: flow.sublabel } : {}),
      ...(flow.link ? { link: flow.link } : {}),
      ...detailRows(flow.details, flow.jobs ? [] : [], Array.isArray(flow.jobNames) ? [{ label: 'jobs', value: flow.jobNames.join(', ') }] : []),
      pos: [X_FLOW, y], size: [FLOW_W, NODE_H],
    });
    // Channels share the strip between the datasource grid and the flow
    // column; more flows means narrower spacing, never a channel under a box.
    const channelGap = Math.min(CHANNEL_GAP, (X_FLOW - X_CHANNEL - 10) / Math.max(1, flows.length - 1));
    const channelX = X_CHANNEL + flowIndex * channelGap;
    flow.writes.forEach((link) => {
      const target = datasourcePosition.get(link.datasource);
      const laneY = target.y + DS_H_TAGGED + 10 + flowIndex * 8;
      // Ports sit at the middle of a side, so routes of one flow share their
      // first stub and routes into one datasource share their last stub.
      lineageEdge(unit, link, [[channelX, y + NODE_H / 2], [channelX, laneY], [target.x + DS_W / 2, laneY]]);
    });
  });
  if (flows.length) {
    boundaries.push({
      kind: 'region',
      label: context.flowsLabel || (L ? '离线 / 近实时数据流' : 'Offline and streaming flows'),
      wraps: flows.map((flow) => id('flow', flow.id)),
      pad: 14,
    });
  }
} else {
  // Expanded: one box per job. Jobs that touch a datasource stand in the
  // first column, next to the channels; the rest stand to their right.
  //
  // Every datasource that is touched owns one vertical channel and one lane
  // under its row. All jobs touching it join that channel, so the lineage of
  // one datasource reads as a tree instead of a bundle of parallel lines.
  // A flow that lists no jobs is drawn as a single job of its own.
  const jobsOf = (flow) => flow.jobs || [{ id: flow.id, label: flow.label, role: flow.role, links: flow.writes }];
  const touched = [];
  for (const flow of flows) {
    for (const job of jobsOf(flow)) {
      for (const link of job.links) if (!touched.includes(link.datasource)) touched.push(link.datasource);
    }
  }
  // Left-most datasources take the inner channels and the lowest lanes, so a
  // route entering one datasource never crosses the lane of another in its row.
  touched.sort((left, right) => (
    datasourcePosition.get(right).column - datasourcePosition.get(left).column
    || datasourcePosition.get(left).y - datasourcePosition.get(right).y
  ));
  const channelOf = new Map(touched.map((datasource, index) => [datasource, X_CHANNEL + 6 + index * JOB_CHANNEL_GAP]));
  const laneOf = (datasource) => {
    const target = datasourcePosition.get(datasource);
    return target.y + DS_H_TAGGED + 8 + (DS_PER_LINE - 1 - target.column) * 8;
  };
  const xLinked = X_CHANNEL + 6 + touched.length * JOB_CHANNEL_GAP + 18;
  const xRest = xLinked + JOB_W + JOB_GAP_X;

  let bandY = FIRST_BAND_Y;
  const allJobNodes = [];
  for (const flow of flows) {
    const jobs = jobsOf(flow);
    const linked = jobs.filter((job) => job.links.length);
    const rest = jobs.filter((job) => !job.links.length);
    const wraps = [];
    const place = (job, x, row) => {
      const unit = { key: job.id, nodeId: id('job', job.id), links: [] };
      const y = bandY + row * JOB_PITCH;
      units.push(unit);
      wraps.push(unit.nodeId);
      allJobNodes.push(unit.nodeId);
      components.push({
        id: unit.nodeId, role: job.role || flow.role || 'stream-job', label: job.label || job.id,
        ...(job.sublabel ? { sublabel: job.sublabel } : {}),
        ...(job.tag ? { tag: job.tag } : {}),
        ...(job.link ? { link: job.link } : {}),
        ...detailRows(job.details),
        pos: [x, y], size: [JOB_W, JOB_H],
      });
      for (const link of job.links) {
        const target = datasourcePosition.get(link.datasource);
        const channelX = channelOf.get(link.datasource);
        lineageEdge(unit, link, [[channelX, y + JOB_H / 2], [channelX, laneOf(link.datasource)], [target.x + DS_W / 2, laneOf(link.datasource)]]);
      }
    };
    linked.forEach((job, row) => place(job, xLinked, row));
    rest.forEach((job, row) => place(job, xRest, row));
    const rows = Math.max(linked.length, rest.length, 1);
    flowBottoms.push(bandY + (rows - 1) * JOB_PITCH + JOB_H);
    boundaries.push({
      kind: 'security-group',
      label: `${flow.label} · ${jobs.length} jobs${rest.length ? (L ? ` · ${rest.length} 个无已知在线消费方` : ` · ${rest.length} without a known online consumer`) : ''}`,
      wraps,
      pad: 10,
    });
    bandY += rows * JOB_PITCH + 44;
  }
  boundaries.push({
    kind: 'region',
    label: context.flowsLabel || (L ? '离线 / 近实时数据流' : 'Offline and streaming flows'),
    wraps: allJobNodes,
    pad: 26,
  });
  viewWidth = xRest + JOB_W + 60;
}
const layoutBottom = Math.max(contentBottom, ...flowBottoms);

// ---------------------------------------------------------------- scenarios
const contextNodeIds = [engineId, ...topNodes.map((node) => id('ctx', node.id))];
const contextEdgeIds = topNodes.map((node) => id('ctx_edge', node.id));
const groupsSeen = new Map();
const items = [];
const scenarioId = (usage) => `${usage.bundle}.${usage.graphName}`;

for (const usage of [...usages.values()].sort((left, right) => (
  left.bundle.localeCompare(right.bundle) || Number(left.holdout) - Number(right.holdout) || left.graphName.localeCompare(right.graphName)
))) {
  if (!groupsSeen.has(usage.bundle)) groupsSeen.set(usage.bundle, { id: usage.bundle, label: usage.bundle });
  const activeStages = presentStages.filter((stageId) => usage.analysis.stageOps.has(stageId));
  const activeDatasources = [...usage.analysis.datasourceStages.keys()].filter((datasource) => datasourcePosition.has(datasource));
  const activeUnits = units.filter((unit) => unit.links.some((link) => activeDatasources.includes(link.datasource)));

  const nodes = [
    ...contextNodeIds,
    ...activeStages.map((stageId) => id('stage', stageId)),
    ...activeDatasources.map((datasource) => id('ds', datasource)),
    ...activeUnits.map((unit) => unit.nodeId),
  ];
  const active = new Set(contextEdgeIds);
  const activeSpine = new Set([engineId, ...activeStages.map((stageId) => id('stage', stageId))]);
  for (let index = 0; index + 1 < spine.length; index += 1) {
    if (activeSpine.has(spine[index]) && activeSpine.has(spine[index + 1])) active.add(id('spine', `${index}_${index + 1}`));
  }
  const annotations = {};
  for (const stageId of activeStages) {
    annotations[id('stage', stageId)] = summarizeOps(usage.analysis.stageOps.get(stageId), 4, Boolean(L)).slice(0, 240);
  }
  for (const datasource of activeDatasources) {
    const stagesUsing = [...usage.analysis.datasourceStages.get(datasource).keys()];
    if (stagesUsing.includes(primaryStage.get(datasource))) active.add(id('use', `${primaryStage.get(datasource)}_${datasource}`));
    annotations[id('ds', datasource)] = `${L ? '使用方' : 'used by'}: ${stagesUsing.map(stageLabel).join(' · ')}`.slice(0, 240);
  }
  for (const unit of activeUnits) {
    for (const link of unit.links) {
      if (activeDatasources.includes(link.datasource)) active.add(link.edgeId);
    }
  }

  const who = usage.users.map((user) => `${(user.markets || []).join(',') || '*'}/${user.group}${user.tag ? `(${user.tag})` : ''}`);
  const uniqueWho = [...new Set(who)];
  const note = [
    `${L ? '命名空间' : 'namespace'} ${usage.namespace}`,
    `${usage.analysis.nodeCount} ${L ? '个算子节点' : 'operator nodes'}`,
    usage.expScene ? `exp_scene ${usage.expScene}` : '',
    `${L ? '使用方' : 'used by'} ${uniqueWho.slice(0, 8).join(' ')}${uniqueWho.length > 8 ? ` +${uniqueWho.length - 8}` : ''}`,
  ].filter(Boolean).join(' · ').slice(0, 280);

  const item = {
    id: scenarioId(usage),
    group: usage.bundle,
    label: `${usage.graphName}${usage.holdout ? ' · holdout' : ''}`.slice(0, 80),
    note,
    nodes,
    connections: connections.map((connection) => connection.id).filter((edgeId) => active.has(edgeId)),
    annotations,
  };
  if (usage.holdout && usage.primary && usages.has(`${usage.bundle}\u0000${usage.primary}`)) {
    item.compare = `${usage.bundle}.${usage.primary}`;
  }
  if (typeof args['link-template'] === 'string') {
    item.link = args['link-template']
      .replaceAll('{bundle}', encodeURIComponent(usage.bundle))
      .replaceAll('{graph}', encodeURIComponent(usage.graphName))
      .replaceAll('{namespace}', encodeURIComponent(usage.namespace));
  }
  items.push(item);
}

// -------------------------------------------------------------------- cards
const cards = [
  {
    dot: 'cyan',
    title: L ? '怎么读这张图' : 'How to read this diagram',
    items: L ? [
      '阶段行是全部 graph 的算子按类型聚合的结果，顺序来自阶段规则',
      '每个数据源放在引用它最多的阶段右侧，其余使用方写在节点标签和场景标注里',
      '切换场景会按该 graph 的真实配置点亮阶段、数据源和数据流',
      '阶段下方的标注如“RecallOp 2 个”，表示该 graph 里有 2 个类型为 RecallOp 的节点，不是 2 种算子',
      '点击节点或连线可以看到详情：数据源上是写进它的 key 和数据结构，连线上是判断依据',
      'holdout 场景默认与其主 graph 对比，新增与移除的节点会高亮',
    ] : [
      'The stage row groups the operators of every graph by type; order comes from the stage rules',
      'Each datasource sits beside the stage that references it most; other users are listed on the node and in scenario annotations',
      'Switching a scenario lights up what that graph really configures',
      'An annotation such as "RecallOp×2" counts nodes: that graph has two nodes of operator type RecallOp',
      'Open a node or a relationship for details: keys and structures on a datasource, the basis on a relationship',
      'Holdout scenarios compare against their primary graph by default',
    ],
  },
  {
    dot: 'emerald',
    title: L ? '数据来源' : 'Inputs',
    items: [
      `${L ? 'bundle' : 'bundles'}: ${groupsSeen.size} · ${L ? '场景' : 'scenarios'}: ${items.length}`,
      `${L ? 'graph 命名空间' : 'graph namespaces'}: ${graphNamespaces.map((namespace) => namespace.name).join(', ')}`,
      `${L ? '被引用的数据源' : 'referenced datasources'}: ${datasourcePosition.size} / ${knownDatasources.size}`,
      ...(missing.length ? [`${L ? '未找到的 graph' : 'unresolved graphs'}: ${[...new Set(missing)].slice(0, 6).join(', ')}${missing.length > 6 ? ' …' : ''}`] : []),
    ],
  },
  ...(flows.length ? [{
    dot: 'amber',
    title: L ? '离线数据流' : 'Offline flows',
    items: flows.map((flow) => {
      if (!flow.jobs) {
        return `${flow.label}: ${flow.writes.map((link) => `${link.direction === 'read' ? '← ' : '→ '}${link.datasource} (${link.evidence || 'unverified'})`).join(', ')}`.slice(0, 300);
      }
      const linked = flow.jobs.filter((job) => job.links.length).length;
      const stores = [...new Set(flow.jobs.flatMap((job) => job.links.map((link) => link.datasource)))];
      return `${flow.label}: ${flow.jobs.length} jobs, ${linked} ${L ? '个关联到' : 'linked to'} ${stores.join(', ') || '-'}`.slice(0, 300);
    }),
  }] : []),
];

const height = layoutBottom + 120;
const diagram = {
  schema_version: 1,
  diagram_type: 'architecture',
  meta: {
    title: args.title || context.service?.label || 'Graph engine',
    // The HTML lives next to the JSON, named after it.
    output: `${path.basename(args.out).replace(/\.architecture\.json$|\.json$/i, '')}.html`,
    locale,
    quality_profile: 'standard',
    viewBox: [viewWidth, height],
    scenarios: {
      label: 'Bundle',
      itemLabel: context.scenarioItemLabel || 'graph',
      noDifferenceNote: context.noDifferenceNote || (L
        ? '这两个 graph 用到的阶段和数据源相同，算子数量也一致。差异只在算子参数里。'
        : 'Both graphs run the same stages, stores and operator counts. They differ in operator parameters only.'),
      groups: [...groupsSeen.values()],
      items,
    },
    ...(context.evidence ? { evidence: context.evidence } : {}),
  },
  components,
  boundaries,
  connections,
  cards,
};

fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
fs.writeFileSync(args.out, `${JSON.stringify(diagram, null, 2)}\n`);
const operatorsByStage = {};
for (const stageId of presentStages) {
  const seen = new Set();
  for (const usage of usages.values()) for (const op of usage.analysis.stageOps.get(stageId)?.keys() || []) seen.add(op);
  operatorsByStage[stageId] = [...seen].sort();
}
console.log(JSON.stringify({
  out: path.resolve(args.out),
  operatorsByStage,
  bundles: groupsSeen.size,
  scenarios: items.length,
  stages: presentStages,
  datasources: datasourcePosition.size,
  flows: flows.length,
  jobs: expanded ? units.length : 0,
  jobsWithoutOnlineConsumer: expanded ? units.filter((unit) => !unit.links.length).length : 0,
  unresolvedGraphs: [...new Set(missing)].length,
}, null, 2));
