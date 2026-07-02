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

const LH = 21,
  PAD = 14;
let _olUndo = [],
  _olRedo = [];

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// ── Parser ─���────────────────────────────────────────────────────────────────────────
// ── Parser ───────────────────────────────────────────────────────────────────────────
function parseIndented(src) {
  const rawLines = (src || "").split("\n");
  const lineItems = []; // { text, level, rawLine }
  const globalNodes = new Set();

  // 1. Populate lineItems first
  rawLines.forEach((raw, i) => {
    const tr = raw.trim();
    if (!tr || tr.startsWith("#")) return;
    const sp = (raw.match(/^(\s*)/) || [""])[0].length;
    lineItems.push({ text: tr, level: Math.floor(sp / 2), rawLine: i });
  });

  if (!lineItems.length) return { nodes: {}, lineTypes: {}, errors: [] };

  // 2. Now collect global root nodes (safe because lineItems now contains data!)
  lineItems.forEach((item) => {
    if (item.level === 0) {
      globalNodes.add(item.text);
    }
  });

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
  const errors = []; // { rawLine, text, kind: 'number-title' }

  function processQuestion(idx) {
    const item = lineItems[idx];
    if (item.level > 0 && globalNodes.has(item.text)) {
      return item.text;
    }

    // question titles can't start with a number — flag it instead of silently
    // letting it through into the tree.
    if (/^\d/.test(item.text)) {
      errors.push({ rawLine: item.rawLine, text: item.text, kind: "number-title" });
    }

    let id = item.text,
      n = 2;
    while (id in nodes) id = item.text + " (" + n++ + ")";
    nodes[id] = null;
    lineTypes[item.rawLine] = "question";
    const ch = childList[idx];
    let nodeData;

    if (ch.length === 0) {
      // Leaf → auto-commit
      nodeData = {
        title: item.text,
        type: "text",
        def: "done",
        opts: [],
        refs: [],
      };
    } else if (ch.length === 1) {
      // Single child → text response → next question
      lineTypes[lineItems[ch[0]].rawLine] = "continuation";
      const nextId = processQuestion(ch[0]);
      nodeData = {
        title: item.text,
        type: "text",
        def: nextId,
        opts: [],
        refs: [],
      };
    } else {
      // Multiple children → option labels (multiple choice)
      const opts = [];
      for (const ci of ch) {
        const optChildren = childList[ci];
        let nextId;

        if (optChildren.length === 0) {
          nextId = "done";
          lineTypes[lineItems[ci].rawLine] = "option";
        } else if (optChildren.length === 1) {
          nextId = processQuestion(optChildren[0]);
          lineTypes[lineItems[ci].rawLine] = "option";
        } else {
          nextId = processQuestion(ci);
          lineTypes[lineItems[ci].rawLine] = "option";
        }

        opts.push({
          l: lineItems[ci].text,
          n: nextId,
          rawLine: lineItems[ci].rawLine,
        });
      }

      nodeData = {
        title: item.text,
        type: "single",
        opts,
        def: null,
        refs: [],
      };
    }

    nodes[id] = nodeData;
    return id;
  }

  // Process all root-level (level 0) nodes
  lineItems.forEach((item, i) => {
    if (item.level === 0) processQuestion(i);
  });

  // Remove null placeholders (unreachable reserved slots)
  Object.keys(nodes).forEach((k) => {
    if (nodes[k] === null) delete nodes[k];
  });

  return { nodes, lineTypes, errors };
}

// ── Syntax highlighter ─────────────────────────────────────��────────────────────────
function hiliteIndented(src) {
  const types = window._lineTypes || {};
  const errLines = window._parseErrorLines || null;
  return (src || "")
    .split("\n")
    .map((line, i) => {
      const tr = line.trim();
      if (!tr) return "";
      if (tr.startsWith("#"))
        return '<span class="h-cmt">' + esc(line) + "</span>";
      if (errLines && errLines.has(i))
        return '<span class="h-error">' + esc(line) + "</span>";
      const t = types[i];
      const isTitle = t === "question" || (!t && !/^\s/.test(line));
      if (isTitle) return '<span class="h-title">' + esc(line) + "</span>";
      if (t === "option") return '<span class="h-opt">' + esc(line) + "</span>";
      return '<span class="h-cont">' + esc(line) + "</span>";
    })
    .join("\n");
}

// ── Editor: textarea + highlight layer ───��──────────────────────────────────────────
function ta() {
  return document.getElementById("src-ta");
}
function hll() {
  return document.getElementById("hll");
}
function lnumsEl() {
  return document.getElementById("lnums");
}
function lhl() {
  return document.getElementById("lhl");
}

function updateEditor() {
  const t = ta();
  if (!t) return;
  const src = t.value;
  const h = hll();
  if (h) h.innerHTML = hiliteIndented(src) + "\n";
  const ln = lnumsEl();
  if (ln) {
    const n = src.split("\n").length;
    let out = "";
    for (let i = 0; i < n; i++) out += String(i + 1) + (i < n - 1 ? "\n" : "");
    ln.textContent = out;
  }
  syncScroll();
}

function syncScroll() {
  const t = ta(),
    h = hll(),
    ln = lnumsEl();
  if (!t) return;
  if (h) {
    h.scrollTop = t.scrollTop;
    h.scrollLeft = t.scrollLeft;
  }
  if (ln) ln.scrollTop = t.scrollTop;
  if (_hoverLineIdx >= 0) _positionHoverStrip();
}

function bindEditorEvents() {
  const t = ta();
  if (!t || t._bound) return;
  t._bound = true;

  t.addEventListener("scroll", syncScroll);
  t.addEventListener("input", () => window._onSrcChange(true));
  t.addEventListener("click", syncScroll);
  t.addEventListener("keyup", syncScroll);

  t.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const s = t.selectionStart;
      const before = t.value.slice(0, s);
      const lineStart = before.lastIndexOf("\n") + 1;
      const leading = (before.slice(lineStart).match(/^(\s*)/) || [""])[0];
      const ins = "\n" + leading + "  ";
      _pushUndo(t.value);
      t.value = t.value.slice(0, s) + ins + t.value.slice(t.selectionEnd);
      t.selectionStart = t.selectionEnd = s + ins.length;
      window._onSrcChange(true);
    } else if (e.key === "Backspace" && t.selectionStart === t.selectionEnd) {
      const s = t.selectionStart;
      const before = t.value.slice(0, s);
      const lineStart = before.lastIndexOf("\n") + 1;
      const leading = (before.slice(lineStart).match(/^(\s*)/) || [""])[0];
      const contentStart = lineStart + leading.length;
      if (s === contentStart && leading.length >= 2) {
        e.preventDefault();
        _pushUndo(t.value);
        t.value =
          t.value.slice(0, contentStart - 2) + t.value.slice(contentStart);
        t.selectionStart = t.selectionEnd = contentStart - 2;
        window._onSrcChange(true);
      }
    } else if (e.key === "Tab") {
      e.preventDefault();
      const s = t.selectionStart,
        en = t.selectionEnd;
      _pushUndo(t.value);
      t.value = t.value.slice(0, s) + "  " + t.value.slice(en);
      t.selectionStart = t.selectionEnd = s + 2;
      window._onSrcChange(true);
    }
  });

  // Attach hover tracking over both the textarea code-field and gutter column
  t.addEventListener("mousemove", onEditorMouseMove);
  t.addEventListener("mouseleave", onEditorMouseLeave);

  const ln = lnumsEl();
  if (ln) {
    ln.addEventListener("mousemove", onEditorMouseMove);
    ln.addEventListener("mouseleave", onEditorMouseLeave);
  }
  bindHoverLayer();
}

// ── Undo / redo ─────────────────────────────────────────────────────────────────────
function _pushUndo(src) {
  const prev = _olUndo.length ? _olUndo[_olUndo.length - 1] : null;
  if (prev !== src) {
    _olUndo.push(src);
    if (_olUndo.length > 200) _olUndo.shift();
  }
  _olRedo.length = 0;
}

function olUndo() {
  const t = ta();
  if (!t || !_olUndo.length) return;
  _olRedo.push(t.value);
  t.value = _olUndo.pop();
  window._onSrcChange(true);
  const b = document.getElementById("btn-undo");
  if (b) {
    b.classList.add("flash");
    setTimeout(() => b.classList.remove("flash"), 250);
  }
}
function olRedo() {
  const t = ta();
  if (!t || !_olRedo.length) return;
  _olUndo.push(t.value);
  t.value = _olRedo.pop();
  window._onSrcChange(true);
  const b = document.getElementById("btn-redo");
  if (b) {
    b.classList.add("flash");
    setTimeout(() => b.classList.remove("flash"), 250);
  }
}

// keyboard shortcut
document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
    const t = ta();
    if (document.activeElement !== t) return;
    e.preventDefault();
    if (e.shiftKey) olRedo();
    else olUndo();
  }
});

// ── Version history ──────────────────────────────────────────────────────────────────
function openHistory() {
  const panel = document.getElementById("historyPanel");
  if (!panel) return;
  renderHistory();
  panel.style.display = "";
}
function closeHistory() {
  const panel = document.getElementById("historyPanel");
  if (panel) panel.style.display = "none";
}
function renderHistory() {
  const list = document.getElementById("historyList");
  if (!list) return;
  const hist =
    window._getHistory && typeof _activeTreeId !== "undefined"
      ? window._getHistory(_activeTreeId)
      : [];
  if (!hist.length) {
    list.innerHTML = '<div class="hist-empty">no history yet.</div>';
    return;
  }
  list.innerHTML = hist
    .map((h, i) => {
      const d = new Date(h.ts);
      const lbl =
        d.toLocaleDateString("en-US", { month: "short", day: "numeric" }) +
        " " +
        d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
      const preview = h.src.split("\n").find((l) => l.trim()) || "(empty)";
      return (
        `<div class="hist-item" onclick="restoreHistory(${i})">` +
        `<div class="hist-ts">${esc(lbl)}</div>` +
        `<div class="hist-prev">${esc(preview.slice(0, 50))}</div></div>`
      );
    })
    .join("");
}
function restoreHistory(idx) {
  const hist =
    window._getHistory && typeof _activeTreeId !== "undefined"
      ? window._getHistory(_activeTreeId)
      : [];
  if (!hist[idx]) return;
  const t = ta();
  if (!t) return;
  if (!confirm("Restore this version?")) return;
  _pushUndo(t.value);
  t.value = hist[idx].src;
  window._onSrcChange && window._onSrcChange(true);
  closeHistory();
}

// ── Hover buttons layer (editor) ────────────────────────────────────────────────────
// ── Hover & Touch Recall Layer (Desktop + Mobile) ───────────────────────────────────
// ── Hover & Touch Recall Layer (Desktop + Mobile) ───────────────────────────────────
let _hoverLineIdx = -1;
let _hoverStripEl = null;
let _firstNodeCleared = false; // Tracks if the user intentionally turned off the default first node recall

function initRecallListeners() {
  const lnums = document.getElementById("lnums");
  if (!lnums) return;

  // Mobile/Direct Click: Tapping the line number gutter triggers the recall button action immediately
  lnums.removeEventListener("click", onGutterClick);
  lnums.addEventListener("click", onGutterClick);
}

function onGutterClick(e) {
  const t = ta();
  if (!t) return;
  const rect = t.getBoundingClientRect();
  const y = e.clientY - rect.top + t.scrollTop - PAD;
  const lineIdx = Math.max(0, Math.floor(y / LH));

  _hoverLineIdx = lineIdx;
  renderHoverBtns(true); // Force open/click evaluation immediately for mobile
}

function onEditorMouseMove(e) {
  if (e.pointerType === "touch") return; // Let touch events handle mobile routing

  const t = ta();
  const lnums = document.getElementById("lnums");
  if (!t || !lnums) return;

  const lnumsRect = lnums.getBoundingClientRect();
  const isOverGutter =
    e.clientX >= lnumsRect.left &&
    e.clientX <= lnumsRect.right &&
    e.clientY >= lnumsRect.top &&
    e.clientY <= lnumsRect.bottom;

  if (!isOverGutter) {
    clearActiveGutterState();
    return;
  }

  const rect = t.getBoundingClientRect();
  const y = e.clientY - rect.top + t.scrollTop - PAD;
  const lineIdx = Math.max(0, Math.floor(y / LH));
  if (lineIdx === _hoverLineIdx) return;

  clearActiveGutterState();
  _hoverLineIdx = lineIdx;
  renderHoverBtns(false);
}

function onEditorMouseLeave(e) {
  if (
    e.relatedTarget &&
    (e.relatedTarget.closest("#hoverBtnsLayer") ||
      e.relatedTarget.closest("#lnums") ||
      e.relatedTarget.closest("#src-ta"))
  ) {
    return;
  }
  clearActiveGutterState();
}

function clearActiveGutterState() {
  _hoverLineIdx = -1;
  const layer = document.getElementById("hoverBtnsLayer");
  if (layer) layer.innerHTML = "";
  _hoverStripEl = null;

  // Restore line number visibility instantly when mouse leaves or moves away
  const lnums = document.getElementById("lnums");
  if (lnums) {
    Array.from(lnums.children).forEach((child) => {
      child.style.visibility = "visible";
    });
  }
}

function renderHoverBtns(isExplicitClick = false) {
  let layer = document.getElementById("hoverBtnsLayer");
  const t = ta();
  if (!t) return;

  const edBody =
    t.closest(".editor-body") ||
    document.getElementById("editorBody") ||
    document.body;
  if (!layer) {
    layer = document.createElement("div");
    layer.id = "hoverBtnsLayer";
    edBody.appendChild(layer);
  } else if (layer.parentElement !== edBody) {
    edBody.appendChild(layer);
  }

  layer.style.position = "absolute";
  layer.style.inset = "0";
  layer.style.pointerEvents = "none";
  layer.style.zIndex = "10";

  bindHoverLayer();

  const lines = t.value.split("\n");
  const li = _hoverLineIdx;
  if (li < 0 || li >= lines.length) {
    clearActiveGutterState();
    return;
  }

  const lineText = (lines[li] || "").trim();
  const lineType = (window._lineTypes || {})[li];
  const isQuestion =
    lineType === "question" || (!lineType && !/^\s/.test(lines[li] || ""));

  if (!lineText || !isQuestion) {
    clearActiveGutterState();
    return;
  }

  // Hide the matching numerical line list item underneath the button
  const lnums = document.getElementById("lnums");
  if (lnums && lnums.children[li]) {
    lnums.children[li].style.visibility = "hidden";
  }

  const top = PAD + li * LH - t.scrollTop;
  const rect = t.getBoundingClientRect();
  if (top < -LH || top > rect.height + LH) {
    clearActiveGutterState();
    return;
  }

  layer.innerHTML = "";
  const strip = document.createElement("div");
  strip.className = "hover-btn-strip";
  strip.style.top = top + "px";
  strip.style.height = LH + "px";
  strip.style.position = "absolute";
  strip.style.pointerEvents = "auto";
  _hoverStripEl = strip;

  if (lnums) {
    const layerRect = layer.getBoundingClientRect();
    const lnumsRect = lnums.getBoundingClientRect();
    strip.style.left = lnumsRect.left - layerRect.left + "px";
    strip.style.width = lnumsRect.width - 1 + "px";
  } else {
    strip.style.left = "0px";
    strip.style.width = "39px";
  }

  const recallMap = window._recallMap || {};
  let recalls = recallMap[lineText] || [];

  // Rule: If it's the first line node, default to active unless explicitly cleared by the user
  if (li === 0 && !recallMap.hasOwnProperty(lineText) && !_firstNodeCleared) {
    recalls = ["Default Node Context"];
    recallMap[lineText] = recalls;
  }

  const btn = document.createElement("button");
  btn.style.pointerEvents = "auto";
  btn.style.width = "18px";
  btn.style.height = "18px";
  btn.style.borderRadius = "4px";
  btn.style.cursor = "pointer";
  btn.style.display = "flex";
  btn.style.alignItems = "center";
  btn.style.justifyContent = "center";
  btn.style.fontFamily = "var(--fmono)";
  btn.style.fontSize = "11px";
  btn.style.margin = "1px auto 0 auto";
  btn.style.transition = "all 0.1s";
  btn.innerHTML = "↻";

  const isOn = recalls.length > 0;

  if (isOn) {
    btn.className = "hover-recall-btn on";
    btn.title = `Recalling answers from: ${recalls.join(", ")}`;
    btn.style.background = "var(--accent-bg, #181b00)";
    btn.style.color = "var(--accent-h, #f4ff5e)";
    btn.style.border = "1px solid var(--accent-dim, #ee0000)";
  } else {
    btn.className = "hover-recall-btn";
    btn.title = "Recall past answers from another question";
    btn.style.background = "var(--surf2, #1a1a1a)";
    btn.style.color = "var(--muted2, #888)";
    btn.style.border = "1px solid var(--border3, #444)";
  }

  btn.addEventListener("mousedown", (e) => {
    e.preventDefault();
    e.stopPropagation();
  });

  const handleAction = (e) => {
    if (e && e.stopPropagation) e.stopPropagation();
    if (isOn) {
      // Turning it OFF
      if (li === 0) _firstNodeCleared = true; // Block default re-activation on redraw

      if (window.clearRecalls) {
        window.clearRecalls(lineText);
      } else {
        delete recallMap[lineText];
      }
      renderHoverBtns(false);
    } else {
      // Turning it ON: Open node picking interface
      openRecallDropdown(lineText, btn, recalls);
    }
  };

  btn.addEventListener("click", handleAction);
  strip.appendChild(btn);
  layer.appendChild(strip);

  if (isExplicitClick) {
    handleAction();
  }
}

function bindHoverLayer() {
  const layer = document.getElementById("hoverBtnsLayer");
  if (!layer || layer._bound) return;
  layer._bound = true;
  layer.addEventListener("mouseleave", (e) => {
    if (
      e.relatedTarget &&
      (e.relatedTarget.closest("#lnums") || e.relatedTarget.closest("#src-ta"))
    ) {
      return;
    }
    clearActiveGutterState();
  });
}

setTimeout(initRecallListeners, 200);

// ── Recall dropdown ─────────────────────────────────────────────────────────────────
let _recallDropEl = null;

function openRecallDropdown(nodeTitle, anchor, currentRecalls) {
  closeRecallDropdown();
  const allNodes = Object.keys(
    typeof parsedTree !== "undefined" ? parsedTree : {},
  ).filter((k) => k !== nodeTitle);

  const dd = document.createElement("div");
  dd.className = "recall-drop";
  dd.id = "recallDrop";

  if (!allNodes.length) {
    const msg = document.createElement("div");
    msg.className = "recall-drop-empty";
    msg.textContent = "no other questions yet";
    dd.appendChild(msg);
  } else {
    const hd = document.createElement("div");
    hd.className = "recall-drop-hd";
    hd.textContent = "recall past answers from…";
    dd.appendChild(hd);

    allNodes.forEach((id) => {
      const row = document.createElement("button");
      row.className =
        "recall-drop-row" + (currentRecalls.includes(id) ? " on" : "");
      row.textContent = id.length > 38 ? id.slice(0, 37) + "…" : id;
      row.addEventListener("click", (e) => {
        e.stopPropagation();
        toggleRecall(nodeTitle, id);
        closeRecallDropdown();
        renderHoverBtns();
      });
      dd.appendChild(row);
    });

    if (currentRecalls.length > 0) {
      const sep = document.createElement("div");
      sep.className = "recall-drop-sep";
      dd.appendChild(sep);
      const clr = document.createElement("button");
      clr.className = "recall-drop-clear";
      clr.textContent = "remove all recalls";
      clr.addEventListener("click", (e) => {
        e.stopPropagation();
        clearRecalls(nodeTitle);
        closeRecallDropdown();
        renderHoverBtns();
      });
      dd.appendChild(clr);
    }
  }

  const anchorRect = anchor.getBoundingClientRect();
  const body = document.getElementById("editorBody") || document.body;
  const bodyRect = body.getBoundingClientRect();
  dd.style.position = "absolute";
  dd.style.top = anchorRect.bottom - bodyRect.top + 4 + "px";
  dd.style.left = anchorRect.left - bodyRect.left + "px";
  body.style.position = "relative";
  body.appendChild(dd);
  _recallDropEl = dd;

  setTimeout(() => {
    document.addEventListener("click", closeRecallDropdown, { once: true });
  }, 0);
}

function closeRecallDropdown() {
  if (_recallDropEl) {
    _recallDropEl.remove();
    _recallDropEl = null;
  }
}

function toggleRecall(nodeTitle, sourceId) {
  const map = (window._recallMap = window._recallMap || {});
  const cur = map[nodeTitle] || [];
  if (cur.includes(sourceId)) {
    map[nodeTitle] = cur.filter((x) => x !== sourceId);
    if (!map[nodeTitle].length) delete map[nodeTitle];
  } else {
    map[nodeTitle] = [...cur, sourceId];
  }
  if (window._writeRecall && typeof _activeTreeId !== "undefined")
    window._writeRecall(_activeTreeId, map);
}

function clearRecalls(nodeTitle) {
  const map = (window._recallMap = window._recallMap || {});
  delete map[nodeTitle];
  if (window._writeRecall && typeof _activeTreeId !== "undefined")
    window._writeRecall(_activeTreeId, map);
}

// ── _onSrcChange ─────────────────────────────────────────────────────────────────────
window._onSrcChange = function (write = true) {
  const t = ta();
  const src = t ? t.value : "";
  if (typeof _activeSrc !== "undefined") _activeSrc = src;
  window._currentSrc = src;

  if (write && window._writeSrc && typeof _activeTreeId !== "undefined")
    window._writeSrc(_activeTreeId, src);

  const { nodes, lineTypes, errors } = parseIndented(src);
  window._lineTypes = lineTypes;
  window._parseErrors = errors || [];
  window._parseErrorLines = new Set((errors || []).map((e) => e.rawLine));
  if (typeof parsedTree !== "undefined") parsedTree = nodes;

  const pst = document.getElementById("pst");
  if (pst) {
    if (window._parseErrors.length) {
      const first = window._parseErrors[0];
      const shown = first.text.length > 40 ? first.text.slice(0, 40) + "…" : first.text;
      pst.textContent =
        "⚠ question titles can't start with a number: \"" +
        shown +
        '"' +
        (window._parseErrors.length > 1
          ? " (+" + (window._parseErrors.length - 1) + " more)"
          : "");
      pst.className = "pstatus err";
    } else {
      const k = Object.keys(nodes).length;
      pst.textContent = k ? k + (k === 1 ? " prompt" : " prompts") : "—";
      pst.className = "pstatus" + (k ? " ok" : "");
    }
  }

  updateEditor();
};

(function () {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bindEditorEvents);
  } else {
    bindEditorEvents();
  }
})();
