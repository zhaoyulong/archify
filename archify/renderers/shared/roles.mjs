// Two-level component classification.
//
// `type` stays the tone family (color, viewer kind, legend swatch). `role` is
// the semantic sub-kind inside that family: it selects the sigil, the legend
// wording and the passport label. A role always resolves to exactly one tone,
// so every existing viewer capability that reasons about `data-node-kind`
// keeps working unchanged.
//
// This module must not import utils.mjs (utils imports the sigil shapes).

export const TONES = [
  'frontend',
  'backend',
  'database',
  'cloud',
  'security',
  'messagebus',
  'external',
  'control',
  'compute',
];

// 16x16 stroke icons. `sigil-fill` marks the few solid details.
export const TONE_SIGIL_SHAPE = {
  control: `<rect x="2" y="5" width="12" height="6" rx="3"/>
            <circle cx="11" cy="8" r="1.8" class="sigil-fill"/>`,
  compute: `<rect x="4" y="4" width="8" height="8" rx="1.5"/>
            <path d="M6.5 2v2M9.5 2v2M6.5 12v2M9.5 12v2M2 6.5h2M2 9.5h2M12 6.5h2M12 9.5h2"/>`,
};

export const ROLE_SIGIL_SHAPE = {
  gateway: `<path d="M8 2.2 13 4v3.5c0 3.1-1.8 5.4-5 6.5-3.2-1.1-5-3.4-5-6.5V4Z"/>
            <path d="M5.3 8h5M8.6 6.2 10.4 8l-1.8 1.8"/>`,
  limiter: `<path d="M3 11.5a5 5 0 1 1 10 0"/>
            <path d="M8 11.5 10.6 7.6"/>
            <circle cx="8" cy="11.5" r=".9" class="sigil-fill"/>`,
  service: `<path d="M8 2.5 12.8 5.2v5.6L8 13.5 3.2 10.8V5.2Z"/>
            <circle cx="8" cy="8" r="1.3" class="sigil-fill"/>`,
  engine: `<circle cx="3.6" cy="8" r="1.5"/>
            <circle cx="12.4" cy="4" r="1.5"/>
            <circle cx="12.4" cy="12" r="1.5"/>
            <path d="M5 7.3 11 4.7M5 8.7l6 2.6"/>`,
  operator: `<circle cx="8" cy="8" r="2.2"/>
            <path d="M8 2.5v2M8 11.5v2M2.5 8h2M11.5 8h2M4.1 4.1l1.4 1.4M10.5 10.5l1.4 1.4M4.1 11.9l1.4-1.4M10.5 5.5l1.4-1.4"/>`,
  model: `<circle cx="4" cy="5" r="1.2"/>
            <circle cx="4" cy="11" r="1.2"/>
            <circle cx="8" cy="8" r="1.2" class="sigil-fill"/>
            <circle cx="12" cy="5" r="1.2"/>
            <circle cx="12" cy="11" r="1.2"/>
            <path d="M5 5.7 7 7.3M5 10.3 7 8.7M9 7.3l2-1.6M9 8.7l2 1.6"/>`,
  cache: `<ellipse cx="8" cy="4" rx="5" ry="2"/>
            <path d="M3 4v8c0 1.1 2.2 2 5 2s5-.9 5-2V4"/>
            <path d="M8.9 6.9 6.9 9.7h2.3l-1.9 2.6"/>`,
  featurestore: `<rect x="2.5" y="3" width="11" height="10" rx="1.5"/>
            <path d="M2.5 6.3h11M2.5 9.6h11M6.2 3v10M9.9 3v10"/>`,
  index: `<path d="M2.5 4h7M2.5 7.5h4.4M2.5 11h4"/>
            <circle cx="10.4" cy="9.4" r="2.4"/>
            <path d="m12.2 11.2 1.6 1.6"/>`,
  warehouse: `<path d="M8 2.5 13.5 5 8 7.5 2.5 5Z"/>
            <path d="M2.5 8 8 10.5 13.5 8M2.5 11 8 13.5 13.5 11"/>`,
  topic: `<path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11"/>
            <circle cx="5" cy="4.5" r="1" class="sigil-fill"/>
            <circle cx="10.5" cy="8" r="1" class="sigil-fill"/>
            <circle cx="7" cy="11.5" r="1" class="sigil-fill"/>`,
  config: `<path d="M4 2.5v11M8 2.5v11M12 2.5v11"/>
            <rect x="2.7" y="5" width="2.6" height="2.4" rx=".6" class="sigil-fill"/>
            <rect x="6.7" y="9" width="2.6" height="2.4" rx=".6" class="sigil-fill"/>
            <rect x="10.7" y="4" width="2.6" height="2.4" rx=".6" class="sigil-fill"/>`,
  experiment: `<path d="M2.6 8h3.6M6.2 8c2.2 0 2-3.6 4.2-3.6h3M6.2 8c2.2 0 2 3.6 4.2 3.6h3"/>
            <circle cx="2.8" cy="8" r="1" class="sigil-fill"/>`,
  registry: `<circle cx="8" cy="8" r="5.3"/>
            <circle cx="8" cy="8" r="1.6" class="sigil-fill"/>
            <path d="M8 1.5v2.2M8 12.3v2.2M1.5 8h2.2M12.3 8h2.2"/>`,
  'stream-job': `<path d="M2 6c2-2.6 4 2.6 6 0s4 2.6 6 0M2 10.6c2-2.6 4 2.6 6 0s4 2.6 6 0"/>`,
  'batch-job': `<rect x="2.5" y="5.5" width="8" height="8" rx="1.5"/>
            <path d="M5.5 5.5v-3h8v8h-3"/>`,
  datasource: `<path d="M2.8 3h10.4L9.3 7.7v4.1l-2.6 1.5V7.7Z"/>`,
  client: `<rect x="2" y="3" width="12" height="10" rx="2"/>
            <path d="M2 6.5h12"/>
            <circle cx="4.1" cy="4.8" r=".7" class="sigil-fill"/>
            <circle cx="6.3" cy="4.8" r=".7" class="sigil-fill"/>`,
};

// Built-in role catalog. Labels are [en, zh-CN]. Roles that share a tone
// never share a shape, so two of them are told apart without reading an icon.
export const ROLE_CATALOG = {
  client: { tone: 'frontend', shape: 'pill', label: ['Client', '客户端'] },
  gateway: { tone: 'security', shape: 'shield', label: ['Gateway', '接入网关'] },
  limiter: { tone: 'security', shape: 'octagon', label: ['Limit / degrade', '限流降级'] },
  service: { tone: 'backend', shape: 'rect', label: ['Service', '服务'] },
  engine: { tone: 'backend', shape: 'hexagon', label: ['Graph engine', '图引擎'] },
  operator: { tone: 'backend', shape: 'subroutine', label: ['Operator', '算子'] },
  model: { tone: 'backend', shape: 'octagon', label: ['Model serving', '模型服务'] },
  cache: { tone: 'database', shape: 'cylinder', label: ['Cache / KV', '缓存'] },
  featurestore: { tone: 'database', shape: 'table', label: ['Feature store', '特征存储'] },
  index: { tone: 'database', shape: 'stack', label: ['Index', '索引'] },
  warehouse: { tone: 'database', shape: 'drum', label: ['Warehouse', '数仓存储'] },
  topic: { tone: 'messagebus', shape: 'pipe', label: ['Topic', '消息主题'] },
  config: { tone: 'control', shape: 'document', label: ['Config', '配置'] },
  experiment: { tone: 'control', shape: 'hexagon', label: ['Experiment', 'AB 实验'] },
  registry: { tone: 'control', shape: 'pill', label: ['Registry', '服务发现'] },
  'stream-job': { tone: 'compute', shape: 'parallelogram', label: ['Stream job', '流式作业'] },
  'batch-job': { tone: 'compute', shape: 'stack', label: ['Batch job', '离线作业'] },
  datasource: { tone: 'external', shape: 'trapezoid', label: ['Data source', '数据源'] },
};

export const ROLE_ID_PATTERN = /^[a-z][a-z0-9-]*$/;

const NODE_COLLECTIONS = {
  architecture: 'components',
  workflow: 'nodes',
  dataflow: 'nodes',
};

export function roleCollection(diagramType) {
  return NODE_COLLECTIONS[diagramType] || null;
}

function localeIndex(locale) {
  return locale === 'zh-CN' ? 1 : 0;
}

// Resolve one role id against the diagram's custom roles first, then the
// built-in catalog. Returns null for an unknown id.
export function resolveRole(diagram, roleId) {
  if (typeof roleId !== 'string' || !roleId) return null;
  const custom = diagram?.meta?.roles?.[roleId];
  const builtin = Object.hasOwn(ROLE_CATALOG, roleId) ? ROLE_CATALOG[roleId] : null;
  if (!custom && !builtin) return null;
  const index = localeIndex(diagram?.meta?.locale);
  const tone = custom?.tone || builtin.tone;
  const label = custom?.label || builtin.label[index];
  const sigilId = custom?.sigil || roleId;
  const sigil = Object.hasOwn(ROLE_SIGIL_SHAPE, sigilId) ? sigilId : null;
  // A project role draws like the built-in role whose icon it borrows unless
  // it names its own outline.
  const shape = custom?.shape
    || builtin?.shape
    || (custom?.sigil && Object.hasOwn(ROLE_CATALOG, custom.sigil) ? ROLE_CATALOG[custom.sigil].shape : null)
    || 'rect';
  return { id: roleId, tone, label, sigil, shape, custom: Boolean(custom) };
}

// Outline of one node: its own `shape`, else its role's, else the plain box.
export function nodeShape(diagram, node) {
  if (node?.shape) return node.shape;
  const role = node?.role ? resolveRole(diagram, node.role) : null;
  return role?.shape || 'rect';
}

// Validation + normalization, run once right after schema validation.
// A component may omit `type` when its role supplies the tone; when both are
// authored they must agree, because a mismatched color would misreport the
// family the reader uses to scan the diagram.
export function applyRoles(diagramType, diagram) {
  const problems = [];
  const collection = roleCollection(diagramType);
  const customRoles = diagram?.meta?.roles || {};

  for (const [roleId, role] of Object.entries(customRoles)) {
    if (!ROLE_ID_PATTERN.test(roleId)) {
      problems.push(`/meta/roles/${roleId} must match ${ROLE_ID_PATTERN}`);
    }
    if (role.sigil && !Object.hasOwn(ROLE_SIGIL_SHAPE, role.sigil)) {
      problems.push(`/meta/roles/${roleId}/sigil ${JSON.stringify(role.sigil)} is not a built-in sigil; choose one of ${Object.keys(ROLE_SIGIL_SHAPE).join(', ')}`);
    }
  }
  if (Object.keys(customRoles).length && !collection) {
    problems.push(`/meta/roles is not supported for ${diagramType} diagrams`);
  }
  if (!collection) return problems;

  (Array.isArray(diagram[collection]) ? diagram[collection] : []).forEach((node, index) => {
    if (node.role === undefined) {
      if (node.type === undefined) problems.push(`/${collection}/${index} needs a type or a role`);
      return;
    }
    const role = resolveRole(diagram, node.role);
    if (!role) {
      problems.push(`/${collection}/${index}/role ${JSON.stringify(node.role)} is unknown; use a built-in role (${Object.keys(ROLE_CATALOG).join(', ')}) or declare it in meta.roles`);
      return;
    }
    if (node.type === undefined) {
      node.type = role.tone;
    } else if (node.type !== role.tone) {
      problems.push(`/${collection}/${index} has type ${JSON.stringify(node.type)} but role ${JSON.stringify(node.role)} belongs to tone ${JSON.stringify(role.tone)}; omit type or make them agree`);
    }
  });
  return problems;
}

// Legend model: nodes without a role keep the tone-level entry; each present
// role adds its own entry, ordered by tone then by catalog order.
export function legendKindsWithoutRole(nodes) {
  return new Set((nodes || []).filter((node) => !node.role).map((node) => node.type));
}

export function roleLegendEntries(diagram, nodes) {
  const present = new Map();
  for (const node of nodes || []) {
    if (!node.role || present.has(node.role)) continue;
    const role = resolveRole(diagram, node.role);
    if (role) present.set(node.role, role);
  }
  const order = [...Object.keys(ROLE_CATALOG), ...Object.keys(diagram?.meta?.roles || {})];
  return [...present.values()]
    .sort((left, right) => (
      TONES.indexOf(left.tone) - TONES.indexOf(right.tone)
      || order.indexOf(left.id) - order.indexOf(right.id)
    ))
    .map((role) => ({
      kind: `role-${role.id}`,
      role: role.id,
      tone: role.tone,
      sigil: role.sigil,
      shape: role.shape,
      label: role.label,
      present: true,
      interactive: false,
      swatchWidth: 18,
      swatchGap: 6,
    }));
}

// Compact description embedded for the viewer runtime.
export function presentRoles(diagram, nodes) {
  const result = {};
  for (const entry of roleLegendEntries(diagram, nodes)) {
    result[entry.role] = { tone: entry.tone, label: entry.label, shape: entry.shape };
  }
  return result;
}

// Passport fields a renderer spreads into focusNodeAttrs metadata.
export function rolePassport(diagram, node) {
  const role = node.role ? resolveRole(diagram, node.role) : null;
  return {
    ...(role ? { role: role.id, roleLabel: role.label } : {}),
    ...(node.link ? { link: node.link } : {}),
  };
}
