const APP_BUILD_STAMP = new Date().toISOString();
console.log('[app_build]', APP_BUILD_STAMP);

// ----- UI refs
const elStatus = document.getElementById('status');
const elLevel0 = document.getElementById('level0');
const elPath = document.getElementById('path');
const elOptions = document.getElementById('options');
const elMeta = document.getElementById('meta');
const btnBack = document.getElementById('backBtn');
const btnConfirm = document.getElementById('confirmBtn');
const btnReset = document.getElementById('resetBtn');

const LEVEL0_CHOICES = [
  { id: 'physical-products', label: 'Physical Products' },
  { id: 'services', label: 'Services' },
  { id: 'entertainment', label: 'Entertainment' }
];

// ----- State
const state = {
  level0: null,
  path: [],          // array of selected option ids (or labels), sent to backend
  pathLabels: [],    // for display
  lastResponse: null
};

// ----- Request control (THIS IS THE IMPORTANT PART)
let activeController = null;
let requestSeq = 0;

// ----- Helpers
function setStatus(msg, kind = '') {
  elStatus.textContent = msg || '';
  elStatus.className = 'status' + (kind ? ` ${kind}` : '');
}

function isAbortError(err) {
  const name = String(err?.name || '');
  const msg = String(err?.message || err || '');
  return name === 'AbortError' || msg.includes('AbortError') || msg.includes('signal is aborted');
}

function showReset(show) {
  btnReset.classList.toggle('hidden', !show);
}

function render() {
  // level0 chips
  elLevel0.innerHTML = '';
  for (const c of LEVEL0_CHOICES) {
    const b = document.createElement('button');
    b.className = 'chip' + (state.level0 === c.id ? ' active' : '');
    b.textContent = c.label;
    b.onclick = () => {
      if (state.level0 === c.id) return;
      resetAll();
      state.level0 = c.id;
      requestNext();
      render();
    };
    elLevel0.appendChild(b);
  }

  elPath.textContent = state.pathLabels.length ? state.pathLabels.join(' → ') : '(none)';
  btnBack.disabled = state.path.length === 0;
  btnConfirm.disabled = !state.level0;

  showReset(!!state.level0);
}

function resetAll() {
  // abort any in-flight request
  if (activeController) {
    try { activeController.abort(); } catch (_) {}
    activeController = null;
  }
  state.level0 = null;
  state.path = [];
  state.pathLabels = [];
  state.lastResponse = null;
  elOptions.innerHTML = '';
  elMeta.textContent = '';
  setStatus('');
  render();
}

function resetToLevel0() {
  if (!state.level0) return;
  if (activeController) {
    try { activeController.abort(); } catch (_) {}
    activeController = null;
  }
  state.path = [];
  state.pathLabels = [];
  state.lastResponse = null;
  elOptions.innerHTML = '';
  elMeta.textContent = '';
  setStatus('');
  requestNext();
  render();
}

btnReset.onclick = resetAll;

btnBack.onclick = () => {
  if (state.path.length === 0) return;
  state.path.pop();
  state.pathLabels.pop();
  requestNext();
  render();
};

btnConfirm.onclick = async () => {
  if (!state.level0) return;
  // Confirm just shows the selection key. (Your submit step can be added later.)
  const key = [state.level0, ...state.path].join('>');
  setStatus(`Confirmed: ${key}`, 'ok');
};

// ----- Core request
async function requestNext() {
  if (!state.level0) return;

  const seq = ++requestSeq;

  // Abort previous request (normal behavior)
  if (activeController) {
    try { activeController.abort(); } catch (_) {}
  }
  const controller = new AbortController();
  activeController = controller;

  setStatus('Loading…');

  const payload = { level0: state.level0, path: state.path, max_options: 10 };

  try {
    const r = await fetch('/api/next-options', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
      cache: 'no-store'
    });

    // stale / aborted: ignore
    if (seq !== requestSeq || controller.signal.aborted) return;

    const text = await r.text();
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${text.slice(0, 300)}`);

    const data = JSON.parse(text);
    state.lastResponse = data;

    // stale / aborted: ignore again
    if (seq !== requestSeq || controller.signal.aborted) return;

    // render options
    const opts = Array.isArray(data.options) ? data.options : [];
    elOptions.innerHTML = '';
    for (const o of opts) {
      const div = document.createElement('div');
      div.className = 'opt';
      div.innerHTML = `<div class="name">${escapeHtml(o.label || o.id || 'Option')}</div>
                       <div class="desc">${escapeHtml(o.description || '')}</div>`;
      div.onclick = () => {
        // Selecting an option pushes deeper
        state.path.push(String(o.id || o.label));
        state.pathLabels.push(String(o.label || o.id));
        requestNext();
        render();
      };
      elOptions.appendChild(div);
    }

    // meta
    const mode = data.mode || '(unknown)';
    const warn = Array.isArray(data.warnings) ? data.warnings.join(' | ') : '';
    elMeta.textContent = `Build: ${APP_BUILD_STAMP} | mode: ${mode}` + (warn ? ` | warnings: ${warn}` : '');

    setStatus('');
  } catch (err) {
    // IMPORTANT: aborts are normal. never show UI error for them.
    if (isAbortError(err) || controller.signal.aborted || seq !== requestSeq) return;

    console.error('requestNext failed:', err);
    setStatus('Unable to load options. Please try again.', 'error');
  } finally {
    if (activeController === controller) activeController = null;
  }
}

function escapeHtml(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

// initial
render();
