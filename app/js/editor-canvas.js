// ── Parser (indentation-based) + Editor ���─────────────────────────────────────────────
// Pure indented tree — no routing syntax. Indentation depth determines structure.
// Level-0 lines are question nodes. Under a question:
//   1 child  → text-response, continues to that child question
//   2+ children → multiple-choice; children are option labels
//     Each option label's children determine its next question:
//       0 children  → option leads to commit
//       1 child     → that child is the next question
//       2+ children → option label is itself a question (recursive)
// Leaf questions (no children) auto-commit.

const LH = 21, PAD = 14;
let _treeSig = '';
let _olUndo = [], _olRedo = [];

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── Parser ─���────────────────────────────────────────────────────────────────────────
function parseIndented(src) {
  const rawLines = (src || '').split('\n');
  const lineItems = []; // { text, level, rawLine }

  rawLines.forEach((raw, i) => {
    const tr = raw.trim();
    if (!tr || tr.startsWith('#')) return;
    const sp = (raw.match(/^(\s*)/) || [''])[0].length;
    lineItems.push({ text: tr, level: Math.floor(sp / 2), rawLine: i });
  });

  if (!lineItems.length) return { nodes: {}, lineTypes: {} };

  // Build parent→children arrays using a stack
  const childList = lineItems.map(() => []);
  const stk = [];
  for (let i = 0; i < lineItems.length; i++) {
    const lv = lineItems[i].level;
    while (stk.length && lineItems[stk[stk.length - 1]].level >= lv) stk.pop();
    if (stk.length) childList[stk[stk.length - 1]].push(i);
    stk.push(i);
  }

  const nodes = {};
  const lineTypes = {}; // rawLine → 'question' | 'option' | 'continuation'

  function processQuestion(idx) {
    const item = lineItems[idx];
    let id = item.text, n = 2;
    while (id in nodes) id = item.text + ' (' + (n++) + ')';
    nodes[id] = null; // reserve slot to detect duplicates
    lineTypes[item.rawLine] = 'question';

    const ch = childList[idx];
    let nodeData;

    if (ch.length === 0) {
      // Leaf → auto-commit
      nodeData = { title: item.text, type: 'text', def: 'done', opts: [], refs: [] };
    } else if (ch.length === 1) {
      // Single child → text response → next question
      lineTypes[lineItems[ch[0]].rawLine] = 'continuation';
      const nextId = processQuestion(ch[0]);
      nodeData = { title: item.text, type: 'text', def: nextId, opts: [], refs: [] };
    } else {
      // Multiple children → option labels (multiple choice)
      const opts = [];
      for (const ci of ch) {
        lineTypes[lineItems[ci].rawLine] = 'option';
        const oc = childList[ci];
        let nextId;
        if (oc.length === 0)      nextId = 'done';
        else if (oc.length === 1) nextId = processQuestion(oc[0]);
        else                      nextId = processQuestion(ci); // option itself becomes a question
        opts.push({ l: lineItems[ci].text, n: nextId, rawLine: lineItems[ci].rawLine });
      }
      nodeData = { title: item.text, type: 'single', opts, def: null, refs: [] };
    }

    nodes[id] = nodeData;
    return id;
  }

  // Process all root-level (level 0) nodes
  lineItems.forEach((item, i) => { if (item.level === 0) processQuestion(i); });

  // Remove null placeholders (unreachable reserved slots)
  Object.keys(nodes).forEach(k => { if (nodes[k] === null) delete nodes[k]; });

  return { nodes, lineTypes };
}

// ── Syntax highlighter ─────────────────────────────────────��────────────────────────
function hiliteIndented(src) {
  const types = window._lineTypes || {};
  return (src || '').split('\n').map((line, i) => {
    const tr = line.trim();
    if (!tr) return '';
    if (tr.startsWith('#')) return '<span class="h-cmt">' + esc(line) + '</span>';
    const t = types[i];
    const isTitle = t === 'question' || (!t && !/^\s/.test(line));
    if (isTitle) return '<span class="h-title">' + esc(line) + '</span>';
    if (t === 'option') return '<span class="h-opt">' + esc(line) + '</span>';
    return '<span class="h-cont">' + esc(line) + '</span>';
  }).join('\n');
}

// ── Editor: textarea + highlight layer ───��──────────────────────────────────────────
function ta() { return document.getElementById('src-ta'); }
function hll() { return document.getElementById('hll'); }
function lnumsEl() { return document.getElementById('lnums'); }
function lhl() { return document.getElementById('lhl'); }

function updateEditor() {
  const t = ta(); if (!t) return;
  const src = t.value;
  const h = hll(); if (h) h.innerHTML = hiliteIndented(src) + '\n';
  const ln = lnumsEl();
  if (ln) {
    const n = src.split('\n').length;
    let out = '';
    for (let i = 0; i < n; i++) out += String(i + 1) + (i < n - 1 ? '\n' : '');
    ln.textContent = out;
  }
  syncScroll();
}

function syncScroll() {
  const t = ta(), h = hll(), ln = lnumsEl();
  if (!t) return;
  if (h) { h.scrollTop = t.scrollTop; h.scrollLeft = t.scrollLeft; }
  if (ln) ln.scrollTop = t.scrollTop;
  if (_hoverLineIdx >= 0) _positionHoverStrip();
}

function bindEditorEvents() {
  const t = ta(); if (!t || t._bound) return; t._bound = true;

  t.addEventListener('scroll', syncScroll);
  t.addEventListener('input', () => window._onSrcChange(true));
  t.addEventListener('click', syncScroll);
  t.addEventListener('keyup', syncScroll);

  t.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const s = t.selectionStart;
      const before = t.value.slice(0, s);
      const lineStart = before.lastIndexOf('\n') + 1;
      const leading = (before.slice(lineStart).match(/^(\s*)/) || [''])[0];
      const ins = '\n' + leading + '  ';
      _pushUndo(t.value);
      t.value = t.value.slice(0, s) + ins + t.value.slice(t.selectionEnd);
      t.selectionStart = t.selectionEnd = s + ins.length;
      window._onSrcChange(true);
    } else if (e.key === 'Backspace' && t.selectionStart === t.selectionEnd) {
      const s = t.selectionStart;
      const before = t.value.slice(0, s);
      const lineStart = before.lastIndexOf('\n') + 1;
      const leading = (before.slice(lineStart).match(/^(\s*)/) || [''])[0];
      const contentStart = lineStart + leading.length;
      if (s === contentStart && leading.length >= 2) {
        e.preventDefault();
        _pushUndo(t.value);
        t.value = t.value.slice(0, contentStart - 2) + t.value.slice(contentStart);
        t.selectionStart = t.selectionEnd = contentStart - 2;
        window._onSrcChange(true);
      }
    } else if (e.key === 'Tab') {
      e.preventDefault();
      const s = t.selectionStart, en = t.selectionEnd;
      _pushUndo(t.value);
      t.value = t.value.slice(0, s) + '  ' + t.value.slice(en);
      t.selectionStart = t.selectionEnd = s + 2;
      window._onSrcChange(true);
    }
  });

  t.addEventListener('mousemove', onEditorMouseMove);
  t.addEventListener('mouseleave', onEditorMouseLeave);
  bindHoverLayer();
}

// ── Undo / redo ─────────────────────────────────────────────────────────────────────
function _pushUndo(src) {
  const prev = _olUndo.length ? _olUndo[_olUndo.length - 1] : null;
  if (prev !== src) { _olUndo.push(src); if (_olUndo.length > 200) _olUndo.shift(); }
  _olRedo.length = 0;
}

function olUndo() {
  const t = ta(); if (!t || !_olUndo.length) return;
  _olRedo.push(t.value);
  t.value = _olUndo.pop();
  window._onSrcChange(true);
  const b = document.getElementById('btn-undo');
  if (b) { b.classList.add('flash'); setTimeout(() => b.classList.remove('flash'), 250); }
}
function olRedo() {
  const t = ta(); if (!t || !_olRedo.length) return;
  _olUndo.push(t.value);
  t.value = _olRedo.pop();
  window._onSrcChange(true);
  const b = document.getElementById('btn-redo');
  if (b) { b.classList.add('flash'); setTimeout(() => b.classList.remove('flash'), 250); }
}

// keyboard shortcut
document.addEventListener('keydown', e => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
    const t = ta(); if (document.activeElement !== t) return;
    e.preventDefault();
    if (e.shiftKey) olRedo(); else olUndo();
  }
});

// ── Version history ──────────────────────────────────────────────────────────────────
function openHistory() {
  const panel = document.getElementById('historyPanel'); if (!panel) return;
  renderHistory(); panel.style.display = '';
}
function closeHistory() {
  const panel = document.getElementById('historyPanel'); if (panel) panel.style.display = 'none';
}
function renderHistory() {
  const list = document.getElementById('historyList'); if (!list) return;
  const hist = (window._getHistory && _activeTreeId) ? window._getHistory(_activeTreeId) : [];
  if (!hist.length) { list.innerHTML = '<div class="hist-empty">no history yet.</div>'; return; }
  list.innerHTML = hist.map((h, i) => {
    const d = new Date(h.ts);
    const lbl = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' ' +
      d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    const preview = h.src.split('\n').find(l => l.trim()) || '(empty)';
    return `<div class="hist-item" onclick="restoreHistory(${i})">` +
      `<div class="hist-ts">${esc(lbl)}</div>` +
      `<div class="hist-prev">${esc(preview.slice(0, 50))}</div></div>`;
  }).join('');
}
function restoreHistory(idx) {
  const hist = (window._getHistory && _activeTreeId) ? window._getHistory(_activeTreeId) : [];
  if (!hist[idx]) return;
  const t = ta(); if (!t) return;
  if (!confirm('Restore this version?')) return;
  _pushUndo(t.value);
  t.value = hist[idx].src;
  window._onSrcChange && window._onSrcChange(true);
  closeHistory();
}

// ── Hover buttons layer (editor) ────────────────────────────────────────────────────
let _hoverLineIdx = -1;
let _hoverStripEl = null;

function bindHoverLayer() {
  const layer = document.getElementById('hoverBtnsLayer');
  if (!layer || layer._bound) return; layer._bound = true;
  layer.addEventListener('mouseleave', e => {
    if (e.relatedTarget && e.relatedTarget.closest && e.relatedTarget.closest('#src-ta')) return;
    _hoverLineIdx = -1;
    layer.innerHTML = '';
    _hoverStripEl = null;
  });
}

function onEditorMouseMove(e) {
  const t = ta(); if (!t) return;
  const rect = t.getBoundingClientRect();
  const y = e.clientY - rect.top + t.scrollTop - PAD;
  const lineIdx = Math.max(0, Math.floor(y / LH));
  if (lineIdx === _hoverLineIdx) return;
  _hoverLineIdx = lineIdx;
  renderHoverBtns();
}

function onEditorMouseLeave(e) {
  const layer = document.getElementById('hoverBtnsLayer');
  if (e.relatedTarget && layer && e.relatedTarget.closest && e.relatedTarget.closest('#hoverBtnsLayer')) return;
  _hoverLineIdx = -1;
  if (layer) { layer.innerHTML = ''; _hoverStripEl = null; }
}

function _positionHoverStrip() {
  if (!_hoverStripEl) return;
  const t = ta(); if (!t) return;
  const top = PAD + _hoverLineIdx * LH - t.scrollTop;
  _hoverStripEl.style.top = top + 'px';
}

function renderHoverBtns() {
  const layer = document.getElementById('hoverBtnsLayer');
  const t = ta();
  if (!layer || !t) return;

  const lines = t.value.split('\n');
  const li = _hoverLineIdx;
  if (li < 0 || li >= lines.length) { layer.innerHTML = ''; _hoverStripEl = null; return; }

  const lineText = (lines[li] || '').trim();
  const lineType = (window._lineTypes || {})[li];
  const isQuestion = lineType === 'question' || (!lineType && !/^\s/.test(lines[li] || ''));

  if (!lineText || !isQuestion) { layer.innerHTML = ''; _hoverStripEl = null; return; }

  const top = PAD + li * LH - t.scrollTop;
  const rect = t.getBoundingClientRect();
  if (top < -LH || top > rect.height + LH) { layer.innerHTML = ''; _hoverStripEl = null; return; }

  layer.innerHTML = '';
  const strip = document.createElement('div');
  strip.className = 'hover-btn-strip';
  strip.style.top = top + 'px';
  _hoverStripEl = strip;

  const recallMap = window._recallMap || {};
  const recalls = recallMap[lineText] || [];

  if (recalls.length > 0) {
    recalls.forEach(sourceId => {
      const btn = document.createElement('button');
      btn.className = 'hover-recall-btn on';
      const label = sourceId.length > 22 ? sourceId.slice(0, 21) + '…' : sourceId;
      btn.textContent = '↩ ' + label;
      btn.title = 'recalling: ' + sourceId + ' · 7 days — click to change';
      btn.addEventListener('mousedown', e => { e.preventDefault(); e.stopPropagation(); });
      btn.addEventListener('click', e => { e.stopPropagation(); openRecallDropdown(lineText, btn, recalls); });
      strip.appendChild(btn);
    });
  } else {
    const btn = document.createElement('button');
    btn.className = 'hover-recall-btn';
    btn.textContent = '↩ recall';
    btn.title = 'show past answers from another question here';
    btn.addEventListener('mousedown', e => { e.preventDefault(); e.stopPropagation(); });
    btn.addEventListener('click', e => { e.stopPropagation(); openRecallDropdown(lineText, btn, recalls); });
    strip.appendChild(btn);
  }

  layer.appendChild(strip);
}

// ── Recall dropdown ─────────────────────────���────────────────────────────────────────
let _recallDropEl = null;

function openRecallDropdown(nodeTitle, anchor, currentRecalls) {
  closeRecallDropdown();
  const allNodes = Object.keys(parsedTree).filter(k => k !== nodeTitle);

  const dd = document.createElement('div');
  dd.className = 'recall-drop';
  dd.id = 'recallDrop';

  if (!allNodes.length) {
    const msg = document.createElement('div');
    msg.className = 'recall-drop-empty';
    msg.textContent = 'no other questions yet';
    dd.appendChild(msg);
  } else {
    const hd = document.createElement('div');
    hd.className = 'recall-drop-hd';
    hd.textContent = 'recall past answers from…';
    dd.appendChild(hd);

    allNodes.forEach(id => {
      const row = document.createElement('button');
      row.className = 'recall-drop-row' + (currentRecalls.includes(id) ? ' on' : '');
      row.textContent = id.length > 38 ? id.slice(0, 37) + '…' : id;
      row.addEventListener('click', e => {
        e.stopPropagation();
        toggleRecall(nodeTitle, id);
        closeRecallDropdown();
        renderHoverBtns();
      });
      dd.appendChild(row);
    });

    if (currentRecalls.length > 0) {
      const sep = document.createElement('div');
      sep.className = 'recall-drop-sep';
      dd.appendChild(sep);
      const clr = document.createElement('button');
      clr.className = 'recall-drop-clear';
      clr.textContent = 'remove all recalls';
      clr.addEventListener('click', e => {
        e.stopPropagation();
        clearRecalls(nodeTitle);
        closeRecallDropdown();
        renderHoverBtns();
      });
      dd.appendChild(clr);
    }
  }

  // Position below anchor
  const anchorRect = anchor.getBoundingClientRect();
  const body = document.getElementById('editorBody') || document.body;
  const bodyRect = body.getBoundingClientRect();
  dd.style.position = 'absolute';
  dd.style.top = (anchorRect.bottom - bodyRect.top + 4) + 'px';
  dd.style.left = (anchorRect.left - bodyRect.left) + 'px';
  body.style.position = 'relative';
  body.appendChild(dd);
  _recallDropEl = dd;

  setTimeout(() => {
    document.addEventListener('click', closeRecallDropdown, { once: true });
  }, 0);
}

function closeRecallDropdown() {
  if (_recallDropEl) { _recallDropEl.remove(); _recallDropEl = null; }
}

function toggleRecall(nodeTitle, sourceId) {
  const map = window._recallMap = window._recallMap || {};
  const cur = map[nodeTitle] || [];
  if (cur.includes(sourceId)) {
    map[nodeTitle] = cur.filter(x => x !== sourceId);
    if (!map[nodeTitle].length) delete map[nodeTitle];
  } else {
    map[nodeTitle] = [...cur, sourceId];
  }
  if (window._writeRecall && _activeTreeId) window._writeRecall(_activeTreeId, map);
}

function clearRecalls(nodeTitle) {
  const map = window._recallMap = window._recallMap || {};
  delete map[nodeTitle];
  if (window._writeRecall && _activeTreeId) window._writeRecall(_activeTreeId, map);
}

// ── _onSrcChange ───────────��─────────────────────────��──────────────────────────────
window._onSrcChange = function (write = true) {
  const t = ta(); const src = t ? t.value : '';
  _activeSrc = src; window._currentSrc = src;

  if (write && window._writeSrc && _activeTreeId) window._writeSrc(_activeTreeId, src);

  // Parse first so lineTypes are ready before the highlighter runs
  const { nodes, lineTypes } = parseIndented(src);
  window._lineTypes = lineTypes;
  parsedTree = nodes;

  // Status bar
  const pst = document.getElementById('pst');
  if (pst) {
    const k = Object.keys(nodes).length;
    pst.textContent = k ? k + (k === 1 ? ' node' : ' nodes') : '—';
    pst.className = 'pstatus' + (k ? ' ok' : '');
  }

  updateEditor();

  // Only redraw when structure actually changes
  const sig = Object.keys(nodes).map(id => {
    const n = nodes[id];
    return id + '|' + n.type + '|' + (n.def || '') + '|' + n.opts.map(o => o.n || '·').join(',');
  }).join(';');
  if (sig !== _treeSig) {
    _treeSig = sig;
    if (typeof onTreeParsed === 'function') onTreeParsed();
  }
};

// Auto-bind as soon as this script loads (DOM is ready since script is at end of body)
(function () {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bindEditorEvents);
  } else {
    bindEditorEvents();
  }
})();
