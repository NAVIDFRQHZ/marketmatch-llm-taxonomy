const FUNC_BUILD_STAMP = 'FUNC_BUILD_STAMP_20260212-165911';
const functions = require('firebase-functions');
const admin = require('firebase-admin');
admin.initializeApp();

function stub(level0, path) {
  const depth = (path || []).length + 1;
  const base = String(level0 || 'root');
  const options = Array.from({ length: 10 }, (_, i) => ({
    id: `${base}-${depth}-${i+1}`,
    label: `${base} option ${depth}.${i+1}`,
    description: `Stub option for ${base} at depth ${depth}.`,
    split_dimension: 'stub',
    confidence: 0.6
  }));
  return {
    mode: 'stub',
    meta: { build: FUNC_BUILD_STAMP },
    warnings: ['Stub fallback active.'],
    step: { level0, path_labels: [] },
    options,
    warnings: ['Stub fallback active.']
  };
}

function extractJsonObject(text) {
  if (!text) return null;
  // try direct JSON
  try { return JSON.parse(text); } catch (_) {}
  // strip ```json fences
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try { return JSON.parse(fenced[1]); } catch (_) {}
  }
  // best-effort: first { ... last }
  const a = text.indexOf('{');
  const b = text.lastIndexOf('}');
  if (a >= 0 && b > a) {
    const slice = text.slice(a, b + 1);
    try { return JSON.parse(slice); } catch (_) {}
  }
  return null;
}

async function callOpenAI(prompt) {
  const cfg = (typeof functions.config === 'function') ? (functions.config() || {}) : {};
  const apiKey = process.env.OPENAI_API_KEY || (cfg.openai && cfg.openai.key) || '';
  const model = process.env.OPENAI_MODEL || (cfg.openai && cfg.openai.model) || 'gpt-4.1-mini';

  if (!apiKey) return { ok: false, error: 'missing_api_key' };

  const url = 'https://api.openai.com/v1/responses';
  const body = {
    text: { format: { type: "json_object" } },
    model,
    input: prompt,
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  const text = await res.text();
  if (!res.ok) return { ok: false, error: `openai_http_${res.status}`, raw: text.slice(0, 600) };

  // responses API format: output_text is easiest when present, otherwise raw parse fallback
  let data = null;
  try { data = JSON.parse(text); } catch (_) {}

  let outText = '';
  if (data && typeof data.output_text === 'string') outText = data.output_text;
  if (!outText) outText = text; // fallback

  return { ok: true, model, outText };
}

exports.api = functions.https.onRequest(async (req, res) => {
  console.log('[build]', FUNC_BUILD_STAMP);
  // CORS for simple hosting calls
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).send('');

  const path = req.path || '';
  if (req.method === 'POST' && path.endsWith('/next-options')) {
    const { level0, path: selPath, max_options } = req.body || {};
    const depth = Array.isArray(selPath) ? selPath.length : 0;

    const prompt = [
      'You are a taxonomy generator.',
      'Return STRICT JSON ONLY (no markdown).',
      'Schema: {"options":[{"id":string,"label":string,"description":string,"split_dimension":string,"confidence":number}]}',
      `Level0: ${level0}`,
      `Current path: ${(selPath || []).join(' > ')}`,
      `Generate up to ${Math.min(Number(max_options)||10, 12)} next subcategories for the next drill step.`,
      'Be concrete, avoid duplicates, keep labels short.'
    ].join('\n');

    try {
      const resp = await callOpenAI(prompt);
      if (!resp.ok) {
        const out = stub(level0, selPath);
        out.warnings = [`Stub fallback active. (${resp.error})` + (resp.raw ? ` | ${String(resp.raw).slice(0,120)}` : '')];
        return res.status(200).json(out);
      }

      const parsed = extractJsonObject(resp.outText);
      if (!parsed || !Array.isArray(parsed.options)) {
        const out = stub(level0, selPath);
        out.warnings = ['Stub fallback active. (model output not valid JSON)'];
        return res.status(200).json(out);
      }

      // normalize
      const options = parsed.options.slice(0, Math.min(Number(max_options)||10, 12)).map((o) => ({
        id: String(o.id || o.label || 'opt'),
        label: String(o.label || o.id || 'Option'),
        description: String(o.description || ''),
        split_dimension: String(o.split_dimension || 'type'),
        confidence: Number(o.confidence || 0.8)
      }));

      return res.status(200).json({
        mode: 'llm',
        meta: { build: FUNC_BUILD_STAMP },
        step: { level0, path_labels: [] },
        options
      });
    } catch (e) {
      const out = stub(level0, selPath);
      out.warnings = ['Stub fallback active. (exception)'];
      return res.status(200).json(out);
    }
  }

  res.status(404).json({ error: 'not_found' });
});
