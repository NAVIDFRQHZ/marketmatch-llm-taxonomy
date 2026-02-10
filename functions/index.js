const functions = require('firebase-functions');

const ALLOWED_LEVEL0 = new Set(['physical_products', 'services', 'entertainment']);
const MAX_OPTIONS_LIMIT = 60;

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

function stub(level0, path, maxOptions) {
  const depth = path.length + 1;
  const n = Math.min(maxOptions, 18);
  const options = Array.from({ length: n }, (_, i) => ({
    id: `${level0}-${depth}-${i + 1}`,
    label: `${formatLevel0(level0)} option ${depth}.${i + 1}`,
    description: `Stub option for ${formatLevel0(level0)} at depth ${depth}.`,
    examples: [`example ${i + 1}`],
    split_dimension: 'stub',
    confidence: 0.6
  }));

  return {
    step: { level0, path_labels: path.map(p => p.label) },
    options,
    buckets: [{ label: 'All options', option_ids: options.map(o => o.id) }],
    can_confirm_here: path.length >= 2,
    confirm_reason: path.length >= 2 ? 'Meaningful depth reached (stub).' : 'Keep drilling down (stub).',
    warnings: ['Stub mode (no OpenAI key).']
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
      examples: Array.isArray(opt.examples) ? opt.examples.slice(0, 5) : [],
      split_dimension: typeof opt.split_dimension === 'string' ? opt.split_dimension : 'N/A',
      confidence: Number.isFinite(opt.confidence) ? opt.confidence : 0.5,
    });
  }

  if (out.length > maxOptions) {
    warnings.push(`Truncated options to ${maxOptions}.`);
    out.splice(maxOptions);
  }
  if (out.length < 12) warnings.push('Fewer than 12 options were provided.');
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
  if (!apiKey) return null;

  const input = [
    { role: 'system', content: 'You generate taxonomy drilldown options. Return JSON only (no markdown).' },
    {
      role: 'user',
      content: JSON.stringify({
        task: 'Generate the next taxonomy options and buckets.',
        level0,
        path,
        max_options: maxOptions,
        requirements: {
          options_count: `Between 12 and ${maxOptions} if possible`,
          unique_ids: true,
          include_description: true,
          include_split_dimension: true,
          include_confidence: true,
          buckets_count: 'Aim for 6-12 buckets if possible'
        },
        response_schema: {
          options: [{ id:'string', label:'string', description:'string', examples:['string'], split_dimension:'string', confidence:0.0 }],
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
      model: 'gpt-4.1-mini',
      input,
      temperature: 0.4,
      max_output_tokens: 1200
    })
  });

  if (!resp.ok) throw new Error(`OpenAI request failed: ${resp.status}`);
  const data = await resp.json();

  const outputText = Array.isArray(data.output)
    ? data.output.flatMap(item => item.content || []).map(c => c.text || '').join('')
    : '';

  if (!outputText) throw new Error('OpenAI response was empty.');
  return JSON.parse(outputText);
}

exports.api = functions.https.onRequest(async (req, res) => {
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

  try {
    const openAiPayload = await fetchOpenAiOptions({ level0, path, maxOptions });
    if (!openAiPayload) return res.json(stub(level0, path, maxOptions));

    const normalized = normalizeOptions(openAiPayload, maxOptions);
    const buckets = normalizeBuckets(openAiPayload, normalized.options);

    return res.json({
      step: { level0, path_labels: path.map(p => p.label) },
      options: normalized.options,
      buckets,
      can_confirm_here: Boolean(openAiPayload.can_confirm_here),
      confirm_reason: openAiPayload.confirm_reason || 'Review your selection.',
      warnings: [...(openAiPayload.warnings || []), ...normalized.warnings],
    });
  } catch (e) {
    console.error(e);
    const fallback = stub(level0, path, maxOptions);
    fallback.warnings = ['OpenAI failed; returned stub fallback.'];
    return res.json(fallback);
  }
});
