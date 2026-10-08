//  authoring extensions shared by the architecture, workflow and
// data-flow renderers:
//
//   - roles       two-level component classification (see roles.mjs)
//   - scenarios   named subsets of one diagram (bundle, market, AB group...)
//                 that the reader can switch between and compare
//   - evidence    how well a relationship is supported by facts
//   - link        drill-down from a node to another diagram page
//
// Everything here is authored data. The viewer runtime only toggles
// presentation state; it never invents topology.

import { throwDiagnosticProblems } from './diagnostics.mjs';
import { applyRoles, presentRoles, roleCollection } from './roles.mjs';

export const EXTENSION_TYPES = new Set(['architecture', 'workflow', 'dataflow']);

export const EVIDENCE_LEVELS = ['confirmed', 'inferred', 'unverified'];

// Defaults say what the level claims, not just its name. A diagram states
// what was actually checked through meta.evidence.levels.
const EVIDENCE_DEFAULTS = {
  confirmed: {
    label: ['Confirmed', '已确认'],
    description: ['Both ends were checked and agree.', '两端已逐项核对，一致。'],
  },
  inferred: {
    label: ['Inferred', '推断'],
    description: ['Follows from indirect facts; not checked end to end.', '由间接事实推得，没有逐项核对。'],
  },
  unverified: {
    label: ['Unverified', '待确认'],
    description: ['Not checked, or the other end was not found.', '没有核对，或没有找到另一端。'],
  },
};
const EVIDENCE_TITLE = ['Evidence', '关联依据'];

// Dash pattern of each level, shared by the diagram, its legend and the viewer.
export const EVIDENCE_DASH = { confirmed: null, inferred: '7 4', unverified: '2 5' };

const RELATIONSHIP_COLLECTIONS = {
  architecture: 'connections',
  workflow: 'edges',
  dataflow: 'flows',
};

// A drill-down target is a sibling page or a plain web URL. Anything that can
// execute in the artifact's origin (javascript:, data:, vbscript:...) is refused.
export function isSafeLink(value) {
  if (typeof value !== 'string') return false;
  const link = value.trim();
  if (!link || /[\u0000-\u001f\u007f<>"'`\\]/.test(link)) return false;
  if (/^https?:\/\//i.test(link)) return true;
  if (/^[a-z][a-z0-9+.-]*:/i.test(link)) return false;
  if (link.startsWith('//')) return false;
  return true;
}

function validateLinks(collection, nodes, problems) {
  nodes.forEach((node, index) => {
    if (node.link !== undefined && !isSafeLink(node.link)) {
      problems.push(`/${collection}/${index}/link must be a relative page path or an http(s) URL`);
    }
  });
}

function validateScenarios(diagram, nodeIds, relationshipIds, problems) {
  const scenarios = diagram.meta?.scenarios;
  if (!scenarios) return;
  const groups = Array.isArray(scenarios.groups) ? scenarios.groups : [];
  const groupIds = new Set();
  groups.forEach((group, index) => {
    if (groupIds.has(group.id)) problems.push(`/meta/scenarios/groups/${index}/id duplicates group id ${JSON.stringify(group.id)}`);
    groupIds.add(group.id);
  });

  const items = Array.isArray(scenarios.items) ? scenarios.items : [];
  const itemIds = new Set();
  items.forEach((item, index) => {
    const base = `/meta/scenarios/items/${index}`;
    if (itemIds.has(item.id)) problems.push(`${base}/id duplicates scenario id ${JSON.stringify(item.id)}`);
    itemIds.add(item.id);
    if (item.group !== undefined && !groupIds.has(item.group)) {
      problems.push(`${base}/group references unknown group ${JSON.stringify(item.group)}`);
    }
    const members = new Set();
    (item.nodes || []).forEach((id, nodeIndex) => {
      if (members.has(id)) problems.push(`${base}/nodes/${nodeIndex} duplicates node id ${JSON.stringify(id)}`);
      members.add(id);
      if (!nodeIds.has(id)) problems.push(`${base}/nodes/${nodeIndex} references unknown node id ${JSON.stringify(id)}`);
    });
    (item.connections || []).forEach((id, connectionIndex) => {
      if (!relationshipIds.has(id)) {
        problems.push(`${base}/connections/${connectionIndex} references unknown relationship id ${JSON.stringify(id)}; give that relationship an "id"`);
      }
    });
    for (const id of Object.keys(item.annotations || {})) {
      if (!members.has(id)) problems.push(`${base}/annotations/${id} annotates a node that is not part of this scenario`);
    }
    if (item.link !== undefined && !isSafeLink(item.link)) {
      problems.push(`${base}/link must be a relative page path or an http(s) URL`);
    }
  });
  items.forEach((item, index) => {
    if (item.compare === undefined) return;
    if (item.compare === item.id) problems.push(`/meta/scenarios/items/${index}/compare must name a different scenario`);
    else if (!itemIds.has(item.compare)) problems.push(`/meta/scenarios/items/${index}/compare references unknown scenario ${JSON.stringify(item.compare)}`);
  });
  if (scenarios.default !== undefined && !itemIds.has(scenarios.default)) {
    problems.push(`/meta/scenarios/default references unknown scenario ${JSON.stringify(scenarios.default)}`);
  }
}

// Runs after JSON Schema validation. Mutates the diagram only to fill a
// missing `type` from its role.
export function validateExtensions(diagramType, diagram) {
  const usesExtensions = Boolean(diagram.meta?.scenarios || diagram.meta?.roles || diagram.meta?.evidence);
  if (!EXTENSION_TYPES.has(diagramType)) {
    if (usesExtensions) {
      throwDiagnosticProblems('Extension validation failed', [
        `meta.scenarios, meta.roles and meta.evidence are supported for ${[...EXTENSION_TYPES].join(', ')} diagrams, not ${diagramType}`,
      ], { code: 'extension/unsupported-type', subject: { diagramType } });
    }
    return;
  }
  const collection = roleCollection(diagramType);
  const relationshipCollection = RELATIONSHIP_COLLECTIONS[diagramType];
  const nodes = Array.isArray(diagram[collection]) ? diagram[collection] : [];
  const relationships = Array.isArray(diagram[relationshipCollection]) ? diagram[relationshipCollection] : [];

  const problems = applyRoles(diagramType, diagram);
  validateLinks(collection, nodes, problems);
  validateScenarios(
    diagram,
    new Set(nodes.map((node) => node.id)),
    new Set(relationships.map((relationship) => relationship.id).filter((id) => id !== undefined && id !== null && id !== '')),
    problems,
  );

  if (problems.length) {
    throwDiagnosticProblems('Extension validation failed', problems, {
      code: 'extension/invalid',
      subject: { diagramType },
    });
  }
}

// The single JSON payload the viewer runtime reads. Returns null when the
// diagram uses none of the extensions, so ordinary artifacts stay byte-stable.
export function buildExtensionData(diagramType, diagram) {
  if (!EXTENSION_TYPES.has(diagramType)) return null;
  const collection = roleCollection(diagramType);
  const relationshipCollection = RELATIONSHIP_COLLECTIONS[diagramType];
  const nodes = Array.isArray(diagram[collection]) ? diagram[collection] : [];
  const relationships = Array.isArray(diagram[relationshipCollection]) ? diagram[relationshipCollection] : [];
  const index = diagram.meta?.locale === 'zh-CN' ? 1 : 0;

  const roles = presentRoles(diagram, nodes);
  const evidenceLevels = presentEvidenceLevels(diagram, relationships);
  const hasLinks = nodes.some((node) => node.link);
  const scenarios = diagram.meta?.scenarios || null;

  // Relationship details are keyed the way the viewer keys a relationship:
  // by its position in the authored collection.
  const details = { nodes: {}, relationships: {} };
  for (const node of nodes) if (node.details?.length) details.nodes[node.id] = node.details;
  relationships.forEach((relationship, position) => {
    if (relationship.details?.length) details.relationships[String(position)] = relationship.details;
  });
  const hasDetails = Object.keys(details.nodes).length > 0 || Object.keys(details.relationships).length > 0;

  if (!scenarios && !evidenceLevels.length && !hasLinks && !hasDetails && !Object.keys(roles).length) return null;

  return {
    version: 1,
    diagramType,
    roles,
    evidence: evidenceLevels.map((level) => ({ id: level.id, label: level.label, description: level.description })),
    evidenceTitle: diagram.meta?.evidence?.title || EVIDENCE_TITLE[index],
    evidenceNote: diagram.meta?.evidence?.note || null,
    details: hasDetails ? details : null,
    scenarios: scenarios
      ? {
        label: scenarios.label || null,
        itemLabel: scenarios.itemLabel || null,
        noDifferenceNote: scenarios.noDifferenceNote || null,
        default: scenarios.default || null,
        groups: scenarios.groups || [],
        items: scenarios.items.map((item) => ({
          id: item.id,
          label: item.label,
          group: item.group || null,
          note: item.note || null,
          nodes: item.nodes,
          connections: item.connections || null,
          annotations: item.annotations || {},
          compare: item.compare || null,
          link: item.link || null,
        })),
      }
      : null,
  };
}

function localeIndex(diagram) {
  return diagram?.meta?.locale === 'zh-CN' ? 1 : 0;
}

export function evidenceLevel(diagram, level) {
  const defaults = EVIDENCE_DEFAULTS[level];
  if (!defaults) return null;
  const authored = diagram?.meta?.evidence?.levels?.[level] || {};
  const index = localeIndex(diagram);
  return {
    id: level,
    label: authored.label || defaults.label[index],
    // An authored label without its own description must not inherit a
    // generic sentence that may not describe what that label means.
    description: authored.description || (authored.label ? '' : defaults.description[index]),
    dash: EVIDENCE_DASH[level],
  };
}

export function presentEvidenceLevels(diagram, relationships) {
  return EVIDENCE_LEVELS
    .filter((level) => (relationships || []).some((relationship) => relationship.evidence === level))
    .map((level) => evidenceLevel(diagram, level));
}

// Legend entries for the evidence levels that occur in the diagram.
export function evidenceLegendEntries(diagram, relationships) {
  if (diagram?.meta?.legend?.mode === 'hidden') return [];
  return presentEvidenceLevels(diagram, relationships).map((level) => ({
    kind: `evidence-${level.id}`,
    evidence: level.id,
    dash: level.dash,
    label: level.label,
    present: true,
    interactive: false,
    swatchWidth: 28,
    swatchGap: 8,
  }));
}
