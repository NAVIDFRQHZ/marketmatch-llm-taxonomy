const functions = require('firebase-functions');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
require('dotenv').config({ path: path.join(__dirname, '.secret.local') });
// (dotenv) Never log secrets. You can log booleans for debugging:
console.log('[env] has OPENAI_API_KEY?', Boolean(process.env.OPENAI_API_KEY));
console.log('[env] OPENAI_MODEL=', process.env.OPENAI_MODEL || '(default)');


const ALLOWED_LEVEL0 = new Set(['physical_products','services','entertainment']);
const MAX_OPTIONS_LIMIT = 60;

const DEFAULT_TARGET_OPTIONS = 24;

// Simple in-memory cache
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const cache = new Map();

function cacheKey(level0,path){
  return level0 + "|" + path.map(p=>p.id).join(">");
}

function getCached(key){
  const v = cache.get(key);
  if(!v) return null;
  if(Date.now()-v.ts > CACHE_TTL_MS){ cache.delete(key); return null; }
  return v.data;
}

function setCached(key,data){
  cache.set(key,{ts:Date.now(),data});
}

// -------- STUB --------
function stub(level0,path){
  const depth = path.length+1;
  const options = Array.from({length:18},(_,i)=>({
    id:`${level0}-${depth}-${i+1}`,
    label:`${level0} option ${depth}.${i+1}`,
    description:`Stub option for ${level0} at depth ${depth}.`,
    split_dimension:"stub",
    confidence:0.6
  }));
  return {
    mode:"stub",
    step:{level0,path_labels:path.map(p=>p.label)},
    options,
    buckets:[{label:"All options",option_ids:options.map(o=>o.id)}],
    can_confirm_here:path.length>=2,
    confirm_reason:"Keep drilling down.",
    warnings:["Stub fallback active."]
  };
}

// -------- OPENAI CALL --------
async function fetchLLM(level0, path, maxOptions) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  const target = Math.min(maxOptions || DEFAULT_TARGET_OPTIONS, DEFAULT_TARGET_OPTIONS);

  const prompt =
`Return ONLY valid JSON.
Generate ${target} taxonomy options for:
Domain: ${level0}
Path: ${path.map(p => p.label).join(" > ") || "(root)"}

Schema:
{
 "options":[
  {"id":"","label":"","description":"","split_dimension":"","confidence":0.0}
 ]
}
`;

  const payload = JSON.stringify({
    model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
    input: prompt,
    // Force JSON-only output in Responses API
    text: { format: { type: "json_object" } },
    max_output_tokens: 900,
    temperature: 0.3
  });

  const https = require("https");

  const data = await new Promise((resolve, reject) => {
    const req = https.request(
      "https://api.openai.com/v1/responses",
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload)
        }
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            console.log("OpenAI HTTP error", body);
            return resolve({ __openai_error: body.slice(0, 400) });
          }
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            console.log("OpenAI JSON parse error", body.slice(0, 200));
            resolve(null);
          }
        });
      }
    );

    req.on("error", (err) => reject(err));
    req.write(payload);
    req.end();
  });

  if (!data) return null;
  // If we captured an OpenAI error body, surface it safely
  if (data.__openai_error) {
    return {
      mode: "stub",
      step: { level0, path_labels: path.map(p => p.label) },
      options: generateStubOptions(level0, path, maxOptions).options,
      buckets: generateStubOptions(level0, path, maxOptions).buckets,
      can_confirm_here: false,
      confirm_reason: "OpenAI error (see warnings).",
      warnings: ["OpenAI request failed.", data.__openai_error]
    };
  }

  const text = (data.output || [])
    .flatMap(o => o.content || [])
    .map(c => c.text || "")
    .join("");

  try {
    const parsed = JSON.parse(text);
    const options = (parsed.options || []).slice(0, maxOptions).map(o => ({
      id: o.id || (o.label ? o.label.toLowerCase().replace(/\s+/g, "-") : "option"),
      label: o.label || "Option",
      description: o.description || "",
      split_dimension: o.split_dimension || "general",
      confidence: Number(o.confidence) || 0.5
    }));

    if (!options.length) return null;

    return {
      mode: "llm",
      step: { level0, path_labels: path.map(p => p.label) },
      options,
      buckets: [{ label: "All options", option_ids: options.map(o => o.id) }],
      can_confirm_here: path.length >= 2,
      confirm_reason: "Review selection.",
      warnings: []
    };
  } catch (e) {
    console.log("Model text not pure JSON", text.slice(0, 200));
    return null;
  }
}

// -------- API --------
exports.api = functions.https.onRequest(async (req,res)=>{
  res.set("Access-Control-Allow-Origin","*");
  if(req.method==="OPTIONS") return res.status(204).send("");

  if(req.path!=="/next-options") return res.status(404).json({error:"Not found"});

  const level0=req.body.level0;
  if(!ALLOWED_LEVEL0.has(level0)) return res.status(400).json({error:"bad level0"});

  const path=Array.isArray(req.body.path)?req.body.path:[];
  const maxOptions=Math.min(Number(req.body.max_options)||DEFAULT_TARGET_OPTIONS,MAX_OPTIONS_LIMIT);

  const key=cacheKey(level0,path);
  const cached=getCached(key);
  if(cached){
    cached.meta={cache_hit:true};
    return res.json(cached);
  }

  let out = await fetchLLM(level0,path,maxOptions);
  if(!out) out=stub(level0,path);

  setCached(key,out);
  out.meta={cache_hit:false};
  res.json(out);
});
