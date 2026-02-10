const functions = require('firebase-functions');

const ALLOWED_LEVEL0 = new Set(['physical_products', 'services', 'entertainment']);

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
  if (!Number.isFinite(parsed)) return 60;
  return Math.max(1, Math.min(60, Math.floor(parsed)));
}

function stub(level0, path, maxOptions) {
  const depth = path.length + 1;
  const n = Math.min(maxOptions, 18);
  const options = Array.from({ length: n }, (_, i) => ({
    id: `${level0}-${depth}-${i + 1}`,
    label: `${level0} option ${depth}.${i + 1}`,
    description: `Stub option for ${level0} at depth ${depth}.`,
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
    warnings: ['Stub mode (no OpenAI key yet).']
  };
}

exports.api = functions.https.onRequest((req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).send('');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!String(req.path || '').endsWith('/next-options')) {
    return res.status(404).json({ error: 'Not found' });
  }

  const level0 = sanitizeLevel0(req.body?.level0);
  if (!level0) return res.status(400).json({ error: 'Invalid level0' });

  const path = sanitizePath(req.body?.path);
  const maxOptions = clampMaxOptions(req.body?.max_options);

  return res.json(stub(level0, path, maxOptions));
});
