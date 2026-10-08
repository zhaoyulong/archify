    // ---- Scenarios, evidence, roles, details and drill-down ---------------------
    // Every fact comes from the authored payload in #archify-extensions-data;
    // this script only toggles presentation state and fills detail panels.
    (function () {
      'use strict';
      var dataElement = document.getElementById('archify-extensions-data');
      var svg = document.querySelector('.diagram-container svg');
      var bar = document.getElementById('scenario-bar');
      if (!svg || !bar) return;

      var data = null;
      if (dataElement) {
        try { data = JSON.parse(dataElement.textContent || 'null'); } catch (_) { data = null; }
      }

      var zh = (document.documentElement.getAttribute('lang') || '').toLowerCase().indexOf('zh') === 0;
      var TEXT = zh ? {
        scenario: '场景',
        item: '场景',
        all: '全部（不筛选）',
        compareWith: '与另一个{item}比较',
        none: '不比较',
        reset: '重置',
        open: '打开详情页 ↗',
        annotate: '显示标注',
        counts: '{nodes} 个节点 · {edges} 条连线',
        more: '比 {base} 多用 {count} 个',
        fewer: '少用 {count} 个',
        changed: '另有 {count} 个标注不同',
        noDifference: '在这张图展示的粒度上，两者没有差别。',
        groupAdded: '多用',
        groupRemoved: '少用',
        groupChanged: '标注不同',
        was: '原为',
        openNode: '打开详情',
        allGroups: '全部分组',
        details: '详情',
        basis: '关联依据',
        separator: '，',
        stop: '。'
      } : {
        scenario: 'Scenario',
        item: 'scenario',
        all: 'All (no filter)',
        compareWith: 'compare with another {item}',
        none: 'no comparison',
        reset: 'Reset',
        open: 'Open detail page ↗',
        annotate: 'Annotations',
        counts: '{nodes} nodes · {edges} relationships',
        more: '{count} more than {base}',
        fewer: '{count} fewer',
        changed: '{count} with a different annotation',
        noDifference: 'No difference at the level this diagram shows.',
        groupAdded: 'Only here',
        groupRemoved: 'Only there',
        groupChanged: 'Annotation differs',
        was: 'was',
        openNode: 'Open detail',
        allGroups: 'All groups',
        details: 'Details',
        basis: 'Evidence',
        separator: ', ',
        stop: '.'
      };
      function fill(template, values) {
        return template.replace(/\{(\w+)\}/g, function (_, name) { return values[name] == null ? '' : String(values[name]); });
      }

      var SVG_NS = 'http://www.w3.org/2000/svg';
      var nodeElements = Array.prototype.slice.call(svg.querySelectorAll('[data-node-id]'));
      var edgeElements = Array.prototype.slice.call(svg.querySelectorAll('[data-edge-from][data-edge-to]'));
      var nodeById = {};
      nodeElements.forEach(function (element) { nodeById[element.getAttribute('data-node-id')] = element; });
      function nodeLabel(id) {
        var element = nodeById[id];
        return (element && element.getAttribute('data-node-label')) || id;
      }
      function empty(element) {
        while (element.firstChild) element.removeChild(element.firstChild);
      }
      function activate(element) {
        if (!element) return;
        element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        if (typeof element.focus === 'function') element.focus();
      }

      function safeLink(value) {
        if (typeof value !== 'string') return null;
        var link = value.trim();
        if (!link || /[\u0000-\u001f\u007f<>"'`\\]/.test(link)) return null;
        if (/^https?:\/\//i.test(link)) return link;
        if (/^[a-z][a-z0-9+.-]*:/i.test(link) || link.indexOf('//') === 0) return null;
        return link;
      }

      // A shaped node carries its bounding box on the outline path; a plain
      // node is the rect itself.
      function nodeBox(element) {
        var shaped = element.querySelector('[data-shape-box]');
        var values;
        if (shaped) {
          values = (shaped.getAttribute('data-shape-box') || '').trim().split(/\s+/).map(parseFloat);
        } else {
          var rect = element.querySelector('rect:not(.c-mask)') || element.querySelector('rect');
          if (!rect) return null;
          values = ['x', 'y', 'width', 'height'].map(function (name) { return parseFloat(rect.getAttribute(name)); });
        }
        if (values.length !== 4 || !values.every(isFinite)) return null;
        return { x: values[0], y: values[1], width: values[2], height: values[3] };
      }

      function clearOverlays(kind) {
        Array.prototype.forEach.call(svg.querySelectorAll('[data-extension-overlay="' + kind + '"]'), function (element) {
          element.parentNode.removeChild(element);
        });
      }

      // ---- Drill-down links ----------------------------------------------------
      nodeElements.forEach(function (element) {
        var link = safeLink(element.getAttribute('data-node-link'));
        var box = link ? nodeBox(element) : null;
        if (!box) return;
        var group = document.createElementNS(SVG_NS, 'g');
        group.setAttribute('data-extension-overlay', 'link');
        group.setAttribute('role', 'link');
        group.setAttribute('tabindex', '0');
        group.setAttribute('aria-label', TEXT.openNode + ': ' + (element.getAttribute('data-node-label') || ''));
        group.setAttribute('transform', 'translate(' + (box.x + box.width - 9) + ' ' + (box.y + box.height - 9) + ')');
        var circle = document.createElementNS(SVG_NS, 'circle');
        circle.setAttribute('r', '6.5');
        var arrow = document.createElementNS(SVG_NS, 'path');
        arrow.setAttribute('d', 'M-2.4 2.4 2.4 -2.4M-1 -2.4h3.4v3.4');
        var title = document.createElementNS(SVG_NS, 'title');
        title.textContent = TEXT.openNode + ' → ' + link;
        group.appendChild(title);
        group.appendChild(circle);
        group.appendChild(arrow);
        function open(event) {
          event.preventDefault();
          event.stopPropagation();
          window.location.href = link;
        }
        group.addEventListener('click', open);
        group.addEventListener('pointerdown', function (event) { event.stopPropagation(); });
        group.addEventListener('keydown', function (event) {
          if (event.key === 'Enter' || event.key === ' ') open(event);
        });
        element.appendChild(group);
      });

      // ---- Role legend highlight ----------------------------------------------
      var selectedRole = null;
      function applyRole() {
        nodeElements.forEach(function (element) {
          if (selectedRole && element.getAttribute('data-node-role') !== selectedRole) element.setAttribute('data-role-dim', '');
          else element.removeAttribute('data-role-dim');
        });
        edgeElements.forEach(function (element) {
          if (!selectedRole) { element.removeAttribute('data-role-dim'); return; }
          var from = nodeById[element.getAttribute('data-edge-from')];
          var to = nodeById[element.getAttribute('data-edge-to')];
          var touches = (from && from.getAttribute('data-node-role') === selectedRole)
            || (to && to.getAttribute('data-node-role') === selectedRole);
          if (touches) element.removeAttribute('data-role-dim');
          else element.setAttribute('data-role-dim', '');
        });
        Array.prototype.forEach.call(svg.querySelectorAll('[data-legend-role]'), function (entry) {
          var active = entry.getAttribute('data-legend-role') === selectedRole;
          if (active) entry.setAttribute('data-role-selected', '');
          else entry.removeAttribute('data-role-selected');
          entry.setAttribute('aria-pressed', active ? 'true' : 'false');
        });
      }
      Array.prototype.forEach.call(svg.querySelectorAll('[data-legend-role]'), function (entry) {
        entry.setAttribute('role', 'button');
        entry.setAttribute('tabindex', '0');
        entry.setAttribute('aria-pressed', 'false');
        function toggle(event) {
          event.preventDefault();
          event.stopPropagation();
          var role = entry.getAttribute('data-legend-role');
          selectedRole = selectedRole === role ? null : role;
          applyRole();
        }
        entry.addEventListener('click', toggle);
        entry.addEventListener('keydown', function (event) {
          if (event.key === 'Enter' || event.key === ' ') toggle(event);
        });
      });

      if (!data) return;

      // ---- Evidence: what each level means, and a filter ----------------------
      var DASH = { confirmed: '', inferred: '7 4', unverified: '2 5' };
      var evidenceLevels = Array.isArray(data.evidence) ? data.evidence : [];
      var evidenceById = {};
      evidenceLevels.forEach(function (level) { evidenceById[level.id] = level; });
      function lineSample(level) {
        var sample = document.createElementNS(SVG_NS, 'svg');
        sample.setAttribute('class', 'evidence-sample');
        sample.setAttribute('width', '28');
        sample.setAttribute('height', '8');
        sample.setAttribute('viewBox', '0 0 28 8');
        sample.setAttribute('aria-hidden', 'true');
        var line = document.createElementNS(SVG_NS, 'line');
        line.setAttribute('x1', '1');
        line.setAttribute('x2', '27');
        line.setAttribute('y1', '4');
        line.setAttribute('y2', '4');
        if (DASH[level]) line.setAttribute('stroke-dasharray', DASH[level]);
        sample.appendChild(line);
        return sample;
      }
      var hiddenEvidence = {};
      function applyEvidence() {
        edgeElements.forEach(function (element) {
          var level = element.getAttribute('data-edge-evidence');
          if (level && hiddenEvidence[level]) element.setAttribute('data-evidence-hidden', '');
          else element.removeAttribute('data-evidence-hidden');
        });
      }
      if (evidenceLevels.length) {
        var evidenceRow = document.getElementById('evidence-row');
        var evidenceChips = document.getElementById('evidence-filter');
        var evidenceNote = document.getElementById('evidence-note');
        var evidenceList = document.getElementById('evidence-levels');
        document.getElementById('evidence-title').textContent = data.evidenceTitle || TEXT.basis;
        evidenceLevels.forEach(function (level) {
          var count = edgeElements.filter(function (element) {
            return element.tagName.toLowerCase() === 'path' && element.getAttribute('data-edge-evidence') === level.id;
          }).length;
          var chip = document.createElement('button');
          chip.type = 'button';
          chip.setAttribute('data-evidence-filter', level.id);
          chip.setAttribute('aria-pressed', 'true');
          if (level.description) chip.title = level.description;
          chip.appendChild(lineSample(level.id));
          chip.appendChild(document.createTextNode(level.label + ' ' + count));
          chip.addEventListener('click', function () {
            hiddenEvidence[level.id] = !hiddenEvidence[level.id];
            chip.setAttribute('aria-pressed', hiddenEvidence[level.id] ? 'false' : 'true');
            applyEvidence();
          });
          evidenceChips.appendChild(chip);
          if (level.description) {
            var term = document.createElement('dt');
            term.appendChild(lineSample(level.id));
            term.appendChild(document.createTextNode(level.label));
            var definition = document.createElement('dd');
            definition.textContent = level.description;
            evidenceList.appendChild(term);
            evidenceList.appendChild(definition);
          }
        });
        if (data.evidenceNote) {
          evidenceNote.textContent = data.evidenceNote;
          evidenceNote.hidden = false;
        }
        evidenceList.hidden = !evidenceList.firstChild;
        evidenceRow.hidden = false;
        bar.hidden = false;
      }

      // ---- Details in the passport --------------------------------------------
      // Focus owns the passport. This only fills one slot in it, from authored
      // rows, whenever Focus changes what the passport is about.
      var details = data.details && typeof data.details === 'object' ? data.details : { nodes: {}, relationships: {} };
      var detailsPanel = document.getElementById('focus-details');
      var detailsTitle = document.getElementById('focus-details-title');
      var detailsList = document.getElementById('focus-details-list');
      var focusChip = document.getElementById('focus-chip');
      var focusId = document.getElementById('focus-id');
      function relationshipElement(key) {
        for (var index = 0; index < edgeElements.length; index += 1) {
          var element = edgeElements[index];
          if (element.tagName.toLowerCase() === 'path' && element.getAttribute('data-edge-key') === key) return element;
        }
        return null;
      }
      function renderDetails() {
        if (!detailsPanel || !detailsList) return;
        empty(detailsList);
        var rows = [];
        var title = '';
        var open = focusChip && !focusChip.hidden;
        var pinned = svg.getAttribute('data-relationship-pin-active');
        var edge = open && pinned ? relationshipElement(pinned) : null;
        if (edge) {
          var label = edge.getAttribute('data-edge-label');
          title = nodeLabel(edge.getAttribute('data-edge-from')) + ' → ' + nodeLabel(edge.getAttribute('data-edge-to'))
            + (label ? ' · ' + label : '');
          var level = evidenceById[edge.getAttribute('data-edge-evidence')];
          if (level) {
            rows.push({
              label: data.evidenceTitle || TEXT.basis,
              value: level.label + (level.description ? (zh ? '：' : ': ') + level.description : '')
            });
          }
          rows = rows.concat((details.relationships || {})[pinned] || []);
        } else if (open && focusId) {
          var id = (focusId.textContent || '').trim();
          rows = ((details.nodes || {})[id] || []).slice();
          title = rows.length ? TEXT.details : '';
        }
        if (!rows.length) { detailsPanel.hidden = true; return; }
        detailsTitle.textContent = title;
        rows.forEach(function (row) {
          var term = document.createElement('dt');
          term.textContent = row.label;
          var definition = document.createElement('dd');
          definition.textContent = row.value;
          detailsList.appendChild(term);
          detailsList.appendChild(definition);
        });
        detailsPanel.hidden = false;
      }
      if (detailsPanel && typeof MutationObserver === 'function') {
        var observer = new MutationObserver(renderDetails);
        observer.observe(svg, { attributes: true, attributeFilter: ['data-focus-active', 'data-relationship-pin-active'] });
        if (focusChip) observer.observe(focusChip, { attributes: true, attributeFilter: ['hidden'] });
        if (focusId) observer.observe(focusId, { childList: true, characterData: true, subtree: true });
        renderDetails();
      }

      // ---- Scenarios -----------------------------------------------------------
      var scenarios = data.scenarios && Array.isArray(data.scenarios.items) ? data.scenarios : null;
      if (!scenarios) return;

      var items = scenarios.items;
      var itemById = {};
      items.forEach(function (item) { itemById[item.id] = item; });
      var groups = Array.isArray(scenarios.groups) ? scenarios.groups : [];

      var row = document.getElementById('scenario-row');
      var groupSelect = document.getElementById('scenario-group');
      var scenarioSelect = document.getElementById('scenario-select');
      var compareSelect = document.getElementById('scenario-compare');
      var annotateButton = document.getElementById('scenario-annotate');
      var openButton = document.getElementById('scenario-open');
      var resetButton = document.getElementById('scenario-reset');
      var statElement = document.getElementById('scenario-stat');
      var noteElement = document.getElementById('scenario-note');
      var diffElement = document.getElementById('scenario-diff');
      var annotationList = document.getElementById('scenario-annotations');

      document.getElementById('scenario-title').textContent = scenarios.label || TEXT.scenario;
      var itemLabel = scenarios.itemLabel || TEXT.item;
      // Latin words inside Chinese copy read better with a space on each side.
      if (zh && /^[\x20-\x7e]+$/.test(itemLabel)) itemLabel = ' ' + itemLabel + ' ';
      document.getElementById('scenario-compare-label').textContent = fill(TEXT.compareWith, { item: itemLabel });
      annotateButton.textContent = TEXT.annotate;
      openButton.textContent = TEXT.open;
      resetButton.textContent = TEXT.reset;

      var state = { group: '', scenario: '', compare: '', annotate: true };

      function option(value, label) {
        var element = document.createElement('option');
        element.value = value;
        element.textContent = label;
        return element;
      }

      function itemsInGroup() {
        if (!state.group) return items;
        return items.filter(function (item) { return item.group === state.group; });
      }

      function fillSelect(select, list, emptyLabel, selected) {
        empty(select);
        select.appendChild(option('', emptyLabel));
        list.forEach(function (item) { select.appendChild(option(item.id, item.label)); });
        select.value = list.some(function (item) { return item.id === selected; }) ? selected : '';
      }

      function memberSet(item) {
        var set = {};
        (item.nodes || []).forEach(function (id) { set[id] = true; });
        return set;
      }

      function edgeActive(element, item, members) {
        if (!members[element.getAttribute('data-edge-from')] || !members[element.getAttribute('data-edge-to')]) return false;
        if (!Array.isArray(item.connections)) return true;
        var id = element.getAttribute('data-edge-id');
        return Boolean(id) && item.connections.indexOf(id) !== -1;
      }

      function setDiff(element, inCurrent, inBase, comparing, changed) {
        if (!inCurrent && !(comparing && inBase)) {
          element.setAttribute('data-scenario-state', 'out');
          element.removeAttribute('data-scenario-diff');
          return 'out';
        }
        element.setAttribute('data-scenario-state', 'in');
        if (!comparing) { element.removeAttribute('data-scenario-diff'); return 'in'; }
        var diff = inCurrent && inBase ? (changed ? 'changed' : 'same') : (inCurrent ? 'added' : 'removed');
        element.setAttribute('data-scenario-diff', diff);
        return diff;
      }

      function clearState() {
        nodeElements.concat(edgeElements).forEach(function (element) {
          element.removeAttribute('data-scenario-state');
          element.removeAttribute('data-scenario-diff');
        });
        clearOverlays('annotation');
      }

      function drawAnnotation(element, text) {
        var box = nodeBox(element);
        if (!box) return;
        // Stay inside the node's own width so a badge never covers a neighbor
        // or the route beside it. The full text is in the scenario bar.
        var capacity = Math.max(6, Math.floor((box.width - 12) / 4.4));
        var label = text.length > capacity ? text.slice(0, capacity - 1) + '…' : text;
        var width = Math.min(box.width - 4, Math.max(36, label.length * 4.4 + 10));
        var group = document.createElementNS(SVG_NS, 'g');
        group.setAttribute('data-extension-overlay', 'annotation');
        group.setAttribute('aria-hidden', 'true');
        group.setAttribute('pointer-events', 'none');
        var rect = document.createElementNS(SVG_NS, 'rect');
        rect.setAttribute('x', String(box.x + box.width / 2 - width / 2));
        rect.setAttribute('y', String(box.y + box.height - 3));
        rect.setAttribute('width', String(width));
        rect.setAttribute('height', '11');
        rect.setAttribute('rx', '3');
        var textElement = document.createElementNS(SVG_NS, 'text');
        textElement.setAttribute('x', String(box.x + box.width / 2));
        textElement.setAttribute('y', String(box.y + box.height + 5));
        textElement.setAttribute('text-anchor', 'middle');
        textElement.textContent = label;
        group.appendChild(rect);
        group.appendChild(textElement);
        svg.appendChild(group);
      }

      function chip(id, detail) {
        var button = document.createElement('button');
        button.type = 'button';
        var strong = document.createElement('b');
        strong.textContent = nodeLabel(id);
        button.appendChild(strong);
        if (detail) {
          var small = document.createElement('small');
          small.textContent = ' ' + detail;
          button.appendChild(small);
        }
        button.addEventListener('click', function () { activate(nodeById[id]); });
        return button;
      }

      function renderAnnotations(item) {
        empty(annotationList);
        var ids = item ? Object.keys(item.annotations || {}) : [];
        annotationList.hidden = !ids.length || !state.annotate;
        annotateButton.hidden = !ids.length;
        if (!ids.length || !state.annotate) return;
        ids.forEach(function (id) {
          if (!nodeById[id]) return;
          drawAnnotation(nodeById[id], item.annotations[id]);
          annotationList.appendChild(chip(id, item.annotations[id]));
        });
      }

      function renderDiff(item, base, lists) {
        empty(diffElement);
        diffElement.hidden = true;
        if (!base) return;
        [
          ['added', TEXT.groupAdded, lists.added.map(function (id) { return chip(id, (item.annotations || {})[id]); })],
          ['removed', TEXT.groupRemoved, lists.removed.map(function (id) { return chip(id, (base.annotations || {})[id]); })],
          ['changed', TEXT.groupChanged, lists.changed.map(function (id) {
            return chip(id, (item.annotations || {})[id] + (zh ? '（' : ' (') + TEXT.was + ' ' + (base.annotations || {})[id] + (zh ? '）' : ')'));
          })]
        ].forEach(function (group) {
          if (!group[2].length) return;
          var line = document.createElement('div');
          line.className = 'scenario-diff-group';
          line.setAttribute('data-diff', group[0]);
          var title = document.createElement('span');
          title.textContent = group[1];
          line.appendChild(title);
          group[2].forEach(function (button) { line.appendChild(button); });
          diffElement.appendChild(line);
          diffElement.hidden = false;
        });
      }

      function syncUrl() {
        if (!window.history || typeof window.history.replaceState !== 'function') return;
        try {
          var url = new URL(window.location.href);
          if (state.scenario) url.searchParams.set('scenario', state.scenario); else url.searchParams.delete('scenario');
          if (state.scenario && state.compare) url.searchParams.set('compare', state.compare); else url.searchParams.delete('compare');
          window.history.replaceState(window.history.state, '', url.toString());
        } catch (_) { /* file:// hosts without URL support keep working without deep links */ }
      }

      function span(text, className) {
        var element = document.createElement('span');
        if (className) element.className = className;
        element.textContent = text;
        return element;
      }

      function apply() {
        var item = itemById[state.scenario] || null;
        var base = item && state.compare ? itemById[state.compare] || null : null;
        clearState();
        svg.removeAttribute('data-scenario-active');
        noteElement.hidden = true;
        openButton.hidden = true;
        empty(statElement);
        statElement.hidden = true;
        compareSelect.disabled = !item;
        if (!item) {
          renderAnnotations(null);
          renderDiff(null, null, null);
          syncUrl();
          return;
        }
        svg.setAttribute('data-scenario-active', item.id);
        var members = memberSet(item);
        var baseMembers = base ? memberSet(base) : {};
        var counts = { nodes: 0, edges: 0 };
        var lists = { added: [], removed: [], changed: [] };
        nodeElements.forEach(function (element) {
          var id = element.getAttribute('data-node-id');
          // A node both scenarios run still differs when its annotation does.
          var changed = Boolean(base) && Boolean(members[id]) && Boolean(baseMembers[id])
            && ((item.annotations || {})[id] || '') !== ((base.annotations || {})[id] || '')
            && Boolean((item.annotations || {})[id]) && Boolean((base.annotations || {})[id]);
          var result = setDiff(element, Boolean(members[id]), Boolean(baseMembers[id]), Boolean(base), changed);
          if (members[id]) counts.nodes += 1;
          if (result === 'added') lists.added.push(id);
          if (result === 'removed') lists.removed.push(id);
          if (result === 'changed') lists.changed.push(id);
        });
        edgeElements.forEach(function (element) {
          var inCurrent = edgeActive(element, item, members);
          var inBase = base ? edgeActive(element, base, baseMembers) : false;
          setDiff(element, inCurrent, inBase, Boolean(base), false);
          if (inCurrent && element.tagName.toLowerCase() === 'path') counts.edges += 1;
        });

        statElement.appendChild(span(fill(TEXT.counts, counts)));
        if (base) {
          statElement.appendChild(document.createTextNode(zh ? '。' : '. '));
          if (!lists.added.length && !lists.removed.length && !lists.changed.length) {
            statElement.appendChild(span(scenarios.noDifferenceNote || TEXT.noDifference));
          } else {
            statElement.appendChild(span(fill(TEXT.more, { base: base.label, count: lists.added.length }), 'scenario-added'));
            statElement.appendChild(document.createTextNode(TEXT.separator));
            statElement.appendChild(span(fill(TEXT.fewer, { count: lists.removed.length }), 'scenario-removed'));
            if (lists.changed.length) {
              statElement.appendChild(document.createTextNode(TEXT.separator));
              statElement.appendChild(span(fill(TEXT.changed, { count: lists.changed.length }), 'scenario-changed'));
            }
            statElement.appendChild(document.createTextNode(TEXT.stop));
          }
        }
        statElement.hidden = false;

        if (item.note) {
          noteElement.textContent = item.note;
          noteElement.hidden = false;
        }
        var link = safeLink(item.link);
        if (link) {
          openButton.hidden = false;
          openButton.onclick = function () { window.location.href = link; };
        }
        renderDiff(item, base, lists);
        renderAnnotations(item);
        syncUrl();
      }

      function refreshSelects() {
        var list = itemsInGroup();
        fillSelect(scenarioSelect, list, TEXT.all, state.scenario);
        state.scenario = scenarioSelect.value;
        fillSelect(compareSelect, items.filter(function (item) { return item.id !== state.scenario; }), TEXT.none, state.compare);
        state.compare = compareSelect.value;
      }

      if (groups.length) {
        groupSelect.appendChild(option('', TEXT.allGroups));
        groups.forEach(function (group) { groupSelect.appendChild(option(group.id, group.label)); });
        groupSelect.hidden = false;
        groupSelect.addEventListener('change', function () {
          state.group = groupSelect.value;
          state.scenario = '';
          state.compare = '';
          refreshSelects();
          apply();
        });
      }
      scenarioSelect.addEventListener('change', function () {
        state.scenario = scenarioSelect.value;
        var item = itemById[state.scenario];
        state.compare = item && item.compare ? item.compare : '';
        refreshSelects();
        apply();
      });
      compareSelect.addEventListener('change', function () {
        state.compare = compareSelect.value;
        apply();
      });
      annotateButton.addEventListener('click', function () {
        state.annotate = !state.annotate;
        annotateButton.setAttribute('aria-pressed', state.annotate ? 'true' : 'false');
        apply();
      });
      resetButton.addEventListener('click', function () {
        state.group = '';
        state.scenario = '';
        state.compare = '';
        if (groups.length) groupSelect.value = '';
        refreshSelects();
        apply();
      });

      // Initial state: explicit deep link first, then the authored default.
      var initial = '';
      var initialCompare = '';
      try {
        var params = new URL(window.location.href).searchParams;
        initial = params.get('scenario') || '';
        initialCompare = params.get('compare') || '';
      } catch (_) { /* no URL support: fall back to the authored default */ }
      if (!itemById[initial]) { initial = scenarios.default && itemById[scenarios.default] ? scenarios.default : ''; initialCompare = ''; }
      state.scenario = initial;
      if (initial && groups.length && itemById[initial].group) {
        state.group = itemById[initial].group;
        groupSelect.value = state.group;
      }
      state.compare = itemById[initialCompare] && initialCompare !== initial ? initialCompare : '';
      refreshSelects();
      row.hidden = false;
      bar.hidden = false;
      apply();
    })();
