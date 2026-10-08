# Graph-engine importer

Generates one architecture diagram from the configuration of a config-driven
DAG service: a service where each bundle (scene) selects a graph, and each
graph is a set of operator nodes wired by named inputs and outputs.

The exact per-node DAG belongs to the service's own graph tool. This diagram
shows the level above it:

- which stages a bundle runs,
- which datasources each stage reads or writes,
- which offline or streaming flow feeds each datasource, and how sure we are,
- how two graphs of one bundle differ (user groups, holdout).

## Run

```bash
node recipes/graph-engine/import.mjs \
  --bundles bundle.json \
  --graphs graph_inflow.json graph_outflow.json \
  --datasources datasource.json \
  --context context.json \
  --locale zh-CN \
  --out service.architecture.json

node bin/archify.mjs deliver architecture service.architecture.json service.html --json
```

The importer prints a JSON report: scenario count, stages, the operator types
in each stage, and how many graphs a bundle names that no input file contains.

| Flag | Meaning |
|---|---|
| `--bundles FILE` | Bundle namespace. Required. |
| `--graphs FILE...` | One or more graph namespaces. Required. |
| `--datasources FILE` | Datasource namespace. Without it no datasource is drawn. |
| `--context FILE` | Callers, control plane and offline flows. See below. |
| `--stages FILE` | Replace the stage rules and datasource role mapping. |
| `--bundle NAME` | Import only this bundle. Repeatable. |
| `--expand-flows` | Draw every job of a flow instead of one box per flow. |
| `--link-template URL` | Per-scenario link. `{bundle}`, `{graph}`, `{namespace}` are substituted. |
| `--title`, `--locale` | Diagram title and `en` or `zh-CN`. |
| `--out FILE` | Output JSON. Required. |

## Input shape

Each file is either a Config Center export or a plain JSON map.

```json
{ "states": [{ "zone": "global", "id": { "name": "graph_outflow_live_default" },
               "full_spec": { "items": { "home_new": { "text_value": "{\"dag\":{...}}" } } } }] }
```

Bundle:

```json
{
  "graph_namespace": "graph_outflow",
  "graph_namespace_mapping": { "graph_outflow_nonid": { "markets": ["vn"] } },
  "exp_scene": "union",
  "graphs": [{ "markets": ["id"], "groups": {
    "new": { "request_tag": "new", "graph_name": "home_new", "holdout_graph_name": "home_holdout" }
  } }]
}
```

Graph: `{ "dag": { "<node>": { "op", "params", "inputs", "outputs" } } }`. The
keys of `inputs` and `outputs` are graph-level data names; a node that outputs
a name feeds every node that lists it as an input.

A datasource is referenced when any string inside a node's `params` equals a
datasource name. The key holding it does not matter.

## Context

```json
{
  "service": { "id": "engine", "label": "engine" },
  "upstream": [{ "id": "gw", "label": "gateway", "role": "gateway" }],
  "control": [{ "id": "cc", "label": "Config Center", "role": "config" }],
  "flows": [{
    "id": "features", "label": "Feature flow", "role": "stream-job",
    "writes": [{ "datasource": "fse_session", "evidence": "confirmed" }],
    "reads":  [{ "datasource": "kafka_dump", "evidence": "inferred" }]
  }]
}
```

A flow may list its jobs. Each job has the same `writes` and `reads` fields:

```json
{ "id": "features", "label": "Feature flow", "jobs": [
  { "id": "SessionFeatureJob", "label": "SessionFeatureJob",
    "writes": [{ "datasource": "fse_session", "evidence": "confirmed" }] },
  { "id": "ArchiveJob", "label": "ArchiveJob", "role": "batch-job" }
] }
```

A job may also carry `sublabel`, `tag`, `link` and `details`, exactly like a
flow.

Without `--expand-flows` the job list is ignored and the flow is one box.
With it, every job is a node. Jobs that touch a referenced datasource stand in
the first column, the rest in the second. Each datasource owns one channel, so
all jobs that touch it join one tree. A job with no remaining link is kept and
counted in the group title: that nothing online is known to consume it is what
the expanded view is for.

A flow is drawn only when it touches a datasource that some imported graph
references, or, when expanded, when it lists at least one job. `evidence` should state what was actually checked:

| Level | Use when |
|---|---|
| `confirmed` | the key pattern, table or topic matches on both sides |
| `inferred` | only the cluster or host matches |
| `unverified` | the consumer has not been found |

### Details and wording

Every entity in the context may carry `details`: `upstream`, `control`,
`flows`, their `jobs`, and each `writes` or `reads` link. Rows on a link are
shown when the reader opens that relationship.

```json
{
  "evidence": { "title": "...", "note": "...", "levels": { "confirmed": { "label": "...", "description": "..." } } },
  "scenarioItemLabel": "graph",
  "noDifferenceNote": "Both graphs run the same stages. They differ in operator parameters.",
  "datasources": { "fse_session": { "label": "session_features", "details": [{ "label": "Table", "value": "livestream.session_features" }] } }
}
```

`datasources` adds rows to a datasource node. Without it the importer writes
the type and the stages that use it. Stage nodes always list their operator
types.

Two graphs of one bundle often run the same stages and stores. The importer
annotates each stage with its operator counts, so a comparison still reports
the stages whose counts differ.

## Stage rules

Operators are classified by the first matching rule. Observation operators
are tested first because names such as `RankScoreDumpOp` also match `Rank`.
Pass `--stages` to replace the rules:

```json
{
  "priority": ["observe", "rank"],
  "stages": [
    { "id": "rank", "label": ["Rank", "排序"], "match": ["Rank", "Score"] },
    { "id": "observe", "label": ["Dump", "Dump"], "match": ["Dump", "Trace"] }
  ],
  "datasourceRoles": { "redis": "cache", "fse": "featurestore" }
}
```

Stage order is the order of `stages`. It is a reading order, not a claim that
every graph runs the stages in that sequence.

## What the diagram does not claim

- A datasource is placed beside the stage that references it most. Other
  stages that use it are listed on the node and in scenario annotations, not
  drawn as extra routes.
- The spine joins consecutive stages. Graph-level skips, such as recall
  feeding mixing directly, are not drawn.
- Parameters overridden at request time by an experiment platform are not in
  the configuration and therefore not in the diagram.

### Datasource labels

A datasource node is labelled with what it physically is, read from its
definition: `table`, `topic`, the cluster of `url`/`host`/`address`/`endpoint`
(first host label that is not a transport prefix such as `codis.` or `ips.`), or `service`/`name`, looked up in
`config` or at the top level. The datasource name becomes the sublabel, since
that is how graph params refer to it. `datasources.<name>.label` in the context
overrides the derived label, for a topic or table the definition does not name.
A definition that names nothing keeps the datasource name as label.
