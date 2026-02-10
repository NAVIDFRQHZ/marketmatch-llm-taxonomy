const level0Choices = document.getElementById('level0-choices');
const drilldownCard = document.getElementById('drilldown-card');
const optionsContainer = document.getElementById('options-container');
const pathSummary = document.getElementById('path-summary');
const backButton = document.getElementById('back-button');
const confirmButton = document.getElementById('confirm-button');
const warningsEl = document.getElementById('warnings');
const confirmationCard = document.getElementById('confirmation-card');
const confirmationSummary = document.getElementById('confirmation-summary');
const startOverButton = document.getElementById('start-over');

const state = { level0: null, path: [], options: [], buckets: [], canConfirm: false, confirmReason: '', warnings: [] };

function setStatus(msg, isError=false) {
  warningsEl.textContent = msg || '';
  warningsEl.classList.toggle('error', Boolean(isError));
}

function formatLevel0(level0) {
  if (level0 === 'physical_products') return 'Physical Products';
  if (level0 === 'services') return 'Services';
  if (level0 === 'entertainment') return 'Entertainment';
  return '';
}

function renderPath() {
  const labels = state.path.map(p => p.label);
  pathSummary.textContent = labels.length
    ? `Top-level domain: ${formatLevel0(state.level0)} · Path: ${labels.join(' → ')}`
    : `Top-level domain: ${formatLevel0(state.level0)}. Choose a category below.`;
}

function renderOptions() {
  optionsContainer.innerHTML = '';
  if (!state.options.length) {
    optionsContainer.innerHTML = '<p class="empty">No options returned.</p>';
    return;
  }
  const optionById = new Map(state.options.map(o => [o.id, o]));
  const buckets = state.buckets?.length ? state.buckets : [{ label: 'All options', option_ids: state.options.map(o => o.id) }];

  for (const bucket of buckets) {
    const section = document.createElement('section');
    section.className = 'bucket';

    const h = document.createElement('h3');
    h.textContent = bucket.label;
    section.appendChild(h);

    const list = document.createElement('div');
    list.className = 'bucket-options';

    for (const id of (bucket.option_ids || [])) {
      const option = optionById.get(id);
      if (!option) continue;

      const card = document.createElement('button');
      card.className = 'option-card';
      card.type = 'button';

      const title = document.createElement('span');
      title.className = 'option-title';
      title.textContent = option.label;

      const desc = document.createElement('span');
      desc.className = 'option-description';
      desc.textContent = option.description || '';

      const meta = document.createElement('span');
      meta.className = 'option-meta';
      const conf = Number.isFinite(option.confidence) ? option.confidence : 0.5;
      meta.textContent = `Split: ${option.split_dimension || 'N/A'} · Confidence: ${conf.toFixed(2)}`;

      card.append(title, desc, meta);
      card.addEventListener('click', () => {
        state.path = [...state.path, { id: option.id, label: option.label }];
        fetchOptions();
      });

      list.appendChild(card);
    }

    section.appendChild(list);
    optionsContainer.appendChild(section);
  }
}

function updateControls() {
  backButton.disabled = state.path.length === 0;
  confirmButton.disabled = !state.canConfirm;
}

async function fetchOptions() {
  setStatus('Loading options…');
  optionsContainer.innerHTML = '';
  try {
    const resp = await fetch('/api/next-options', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ level0: state.level0, path: state.path, max_options: 60 }),
    });
    if (!resp.ok) throw new Error(`Request failed: ${resp.status}`);
    const payload = await resp.json();

    state.options = payload.options || [];
    state.buckets = payload.buckets || [];
    state.canConfirm = Boolean(payload.can_confirm_here);
    state.confirmReason = payload.confirm_reason || '';
    state.warnings = payload.warnings || [];

    renderPath();
    renderOptions();
    updateControls();
    setStatus(state.warnings.length ? state.warnings.join(' ') : '');
  } catch (e) {
    console.error(e);
    setStatus('Unable to load options. Please try again.', true);
  }
}

backButton.addEventListener('click', () => {
  if (!state.path.length) return;
  state.path = state.path.slice(0, -1);
  fetchOptions();
});

confirmButton.addEventListener('click', () => {
  confirmationCard.classList.remove('hidden');
  drilldownCard.classList.add('hidden');
  const labels = state.path.map(p => p.label);
  confirmationSummary.textContent = `You confirmed: ${formatLevel0(state.level0)}${labels.length ? ' → ' + labels.join(' → ') : ''}. ${state.confirmReason}`;
});

startOverButton.addEventListener('click', () => {
  state.level0 = null;
  state.path = [];
  confirmationCard.classList.add('hidden');
  drilldownCard.classList.add('hidden');
  document.getElementById('step0-card').classList.remove('hidden');
  setStatus('');
});

level0Choices.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-level0]');
  if (!btn) return;
  state.level0 = btn.dataset.level0;
  state.path = [];
  document.getElementById('step0-card').classList.add('hidden');
  drilldownCard.classList.remove('hidden');
  confirmationCard.classList.add('hidden');
  fetchOptions();
});
