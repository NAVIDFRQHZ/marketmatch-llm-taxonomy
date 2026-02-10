const functions = require('firebase-functions');

const ALLOWED_LEVEL0 = new Set(['physical_products', 'services', 'entertainment']);
const MAX_OPTIONS_LIMIT = 60;

// Cost controls
const DEFAULT_TARGET_OPTIONS = 30;
const MIN_OPTIONS = 12;

// Cache controls (in-memory)
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const CACHE_MAX_ENTRIES = 500;

const cache = new Map();     // key -> { ts, value }
const inflight = new Map();  // key -> Promise

function now() { return Date.now(); }

function pruneCache() {
  const t = now();
  for (const [k, v] of cache.entries()) {
    if (!v || (t - v.ts) > CACHE_TTL_MS) cache.delete(k);
  }
  while (cache.size > CACHE_MAX_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    cache.delete(oldestKey);
  }
}

function sanitizeLevel0(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return ALLOWED_LEVEL0.has(normalized) ? normalized : null;
}

function sanitizePath(path) {
  if (!Array.isArray(path)) return [];
  return path
    .filter((item) => item && typeof item === 'object')
    .map((item) => ({
      id: typeof item.id === 'string' ? item.id.slice(0, 80) : '',
      label: typeof item.label === 'string' ? item.label.slice(0, 120) : '',
    }))
    .filter((item) => item.id && item.label);
}

function clampMaxOptions(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return MAX_OPTIONS_LIMIT;
  return Math.max(1, Math.min(MAX_OPTIONS_LIMIT, Math.floor(parsed)));
}

function formatLevel0(level0) {
  switch (level0) {
    case 'physical_products': return 'Physical Products';
    case 'services': return 'Services';
    case 'entertainment': return 'Entertainment';
    default: return 'Unknown';
  }
}

function makeCacheKey(level0, path, maxOptions) {
  const labels = path.map(p => p.label);
  return `${level0}::${maxOptions}::${labels.join('>')}`;
}

function stub(level0, path, maxOptions, extraWarnings = []) {
  const depth = path.length + 1;
  const n = Math.min(maxOptions, 18);
  const options = Array.from({ length: n }, (_, i) => ({
    id: `${level0}-${depth}-${i + 1}`,
    label: `${formatLevel0(level0)} option ${depth}.${i + 1}`,
    description: `Stub option for ${formatLevel0(level0)} at depth ${depth}.`,
    split_dimension: 'stub',
    confidence: 0.6
  }));

  return {
    mode: 'stub',
    step: { level0, path_labels: path.map(p => p.label) },
    options,
    buckets: [{ label: 'All options', option_ids: options.map(o => o.id) }],
    can_confirm_here: path.length >= 2,
    confirm_reason: path.length >= 2 ? 'Meaningful depth reached.' : 'Keep drilling down.',
    warnings: [...(extraWarnings || []), 'Stub fallback active.'],
  };
}

function normalizeOptions(payload, maxOptions) {
  const warnings = [];
  const raw = Array.isArray(payload?.options) ? payload.options : [];
  const out = [];
  const seen = new Set();

  for (const opt of raw) {
    if (!opt || typeof opt !== 'object') continue;
    const id = typeof opt.id === 'string' ? opt.id.trim() : '';
    const label = typeof opt.label === 'string' ? opt.label.trim() : '';
    if (!id || !label || seen.has(id)) continue;
    seen.add(id);

    out.push({
      id,
      label,
      description: typeof opt.description === 'string' ? opt.description : '',
      split_dimension: typeof opt.split_dimension === 'string' ? opt.split_dimension : 'N/A',
      confidence: Number.isFinite(opt.confidence) ? opt.confidence : 0.5,
    });
  }

  if (out.length > maxOptions) {
    warnings.push(`Truncated options to ${maxOptions}.`);
    out.splice(maxOptions);
  }
  if (out.length < MIN_OPTIONS) warnings.push(`Fewer than ${MIN_OPTIONS} options were provided.`);
  return { options: out, warnings };
}

function normalizeBuckets(payload, options) {
  const optionIds = new Set(options.map(o => o.id));
  const raw = Array.isArray(payload?.buckets) ? payload.buckets : [];

  const sanitized = raw
    .filter(b => b && typeof b === 'object')
    .map(b => ({
      label: typeof b.label === 'string' ? b.label : 'Bucket',
      option_ids: Array.isArray(b.option_ids) ? b.option_ids.filter(id => optionIds.has(id)) : [],
    }))
    .filter(b => b.option_ids.length > 0);

  if (!sanitized.length) {
    return [{ label: 'All options', option_ids: options.map(o => o.id) }];
  }
  return sanitized;
}

async function fetchOpenAiOptions({ level0, path, maxOptions }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return { ok: false, kind: 'no_key', details: 'OPENAI_API_KEY not set' };

  const model = process.env.OPENAI_MODEL || 'gpt-4.1-mini';
  const target = Math.max(MIN_OPTIONS, Math.min(DEFAULT_TARGET_OPTIONS, maxOptions));

  const input = [
    { role: 'system', content: 'Return JSON only (no markdown). You generate taxonomy drilldown options.' },
    {
      role: 'user',
      content: JSON.stringify({
        task: 'Generate the NEXT drilldown options for the user to pick from.',
        level0,
        path_labels: path.map(p => p.label),
        max_options: maxOptions,
        target_options: target,
        rules: [
          `Return between ${MIN_OPTIONS} and ${maxOptions} options. Aim for ~${target}.`,
          'Each option must be mutually-distinct and navigable.',
          'Keep descriptions SHORT (<= 12 words).',
          'Use stable, deterministic ids (slug-like) derived from label.',
          'Provide buckets (6–12) to group options meaningfully.'
        ],
        response_schema: {
          options: [{ id:'string', label:'string', description:'string', split_dimension:'string', confidence:0.0 }],
          buckets: [{ label:'string', option_ids:['string'] }],
          can_confirm_here: 'boolean',
          confirm_reason: 'string',
          warnings: ['string']
        }
      })
    }
  ];

  const resp = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      input,
      temperature: 0.35,
      max_output_tokens: 900
    })
  });

  const text = await resp.text();
  if (!resp.ok) {
    return { ok: false, kind: 'http_error', details: `OpenAI HTTP ${resp.status}: ${text.slice(0, 240).replace(/\s+/g,' ')}` };
  }

  let data;
  try { data = JSON.parse(text); }
  catch { return { ok: false, kind: 'bad_json', details: `Non-JSON from OpenAI: ${text.slice(0, 200)}` }; }

  const outputText =
    (typeof data.output_text === 'string' && data.output_text.trim()) ||
    (Array.isArray(data.output)
      ? data.output.flatMap(item => item.content || []).map(c => c.text || '').join('')
      : '');

  if (!outputText) return { ok: false, kind: 'empty_output', details: 'OpenAI response had no output text.' };

  try {
    return { ok: true, payload: JSON.parse(outputText) };
  } catch {
    return { ok: false, kind: 'json_parse', details: `Model did not return pure JSON. Starts: ${outputText.slice(0, 200)}` };
  }
}

async function getNextOptions({ level0, path, maxOptions }) {
  pruneCache();
  const key = makeCacheKey(level0, path, maxOptions);

  const cached = cache.get(key);
  if (cached && (now() - cached.ts) <= CACHE_TTL_MS) {
    return { payload: cached.value, cache_hit: true };
  }

  if (inflight.has(key)) {
    return { payload: await inflight.get(key), cache_hit: true };
  }

  const promise = (async () => {
    const result = await fetchOpenAiOptions({ level0, path, maxOptions });
    let out;

    if (!result.ok) {
      out = stub(level0, path, maxOptions, [
        'OpenAI failed; returned stub fallback.',
        `Debug: ${result.kind} — ${result.details}`
      ]);
    } else {
      const normalized = normalizeOptions(result.payload, maxOptions);
      const buckets = normalizeBuckets(result.payload, normalized.options);
      out = {
        mode: 'llm',
        step: { level0, path_labels: path.map(p => p.label) },
        options: normalized.options,
        buckets,
        can_confirm_here: Boolean(result.payload.can_confirm_here),
        confirm_reason: result.payload.confirm_reason || 'Review your selection.',
        warnings: [...(result.payload.warnings || []), ...normalized.warnings],
      };
    }

    cache.set(key, { ts: now(), value: out });
    return out;
  })();

  inflight.set(key, promise);
  try {
    const payload = await promise;
    return { payload, cache_hit: false };
  } finally {
    inflight.delete(key);
  }
}

exports.api = functions.https.onRequest(async (req, res) => {
    const t0 = now();

    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(204).send('');
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    if (!String(req.path || '').endsWith('/next-options')) return res.status(404).json({ error: 'Not found' });

    const level0 = sanitizeLevel0(req.body?.level0);
    if (!level0) return res.status(400).json({ error: 'Invalid level0' });

    const path = sanitizePath(req.body?.path);
    const maxOptions = clampMaxOptions(req.body?.max_options);

    const { payload, cache_hit } = await getNextOptions({ level0, path, maxOptions });

    const latency_ms = now() - t0;
    payload.meta = {
      ...(payload.meta || {}),
      cache_hit: Boolean(cache_hit),
      requested_max: maxOptions,
      returned_count: Array.isArray(payload.options) ? payload.options.length : 0,
      latency_ms
    };

    return res.json(payload);
  });
