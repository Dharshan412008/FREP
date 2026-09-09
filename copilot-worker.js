const TRANSFORMERS_CDN = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.2.0";
const MODEL_ID = "onnx-community/Qwen2.5-0.5B-Instruct";

let generatorPromise = null;
let modelAttempted = false;
const latestRequestBySource = new Map();

const DOMAIN_PHRASES = {
  search: [
    "Need a verified CNC lathe in Peenya under ₹9,000 per day, available next week",
    "Find testing equipment in Coimbatore under ₹4,000 per day with current availability",
    "Looking for warehouse space in Bhosari for 10 days under ₹30,000",
    "Find a skilled operator near Chennai for precision machining next week",
  ],
  planner: [
    "Produce 2,000 aluminium brackets in Coimbatore in 5 days with CNC machining, finishing and inspection, budget ₹80,000",
    "Make 500 stainless steel shafts with turning, heat treatment and quality inspection in 7 days",
    "Build sheet metal enclosures with laser cutting, bending, powder coating and logistics",
  ],
  listing: [
    "List my 5-axis VMC in Bhosari for ₹8,500 per day, available for aluminium machining",
    "Offer a verified CMM inspection machine in Peenya for ₹4,000 per day",
    "List 2,000 square feet of warehouse space in Coimbatore for ₹12,000 per day",
  ],
};

function exactPhraseCompletion(text, source) {
  const normalizedText = text.trimStart().toLowerCase();
  const phrase = (DOMAIN_PHRASES[source] || DOMAIN_PHRASES.search)
    .find((candidate) => candidate.toLowerCase().startsWith(normalizedText));
  return phrase ? phrase.slice(text.trimStart().length) : "";
}

function localDomainCompletion(text, source) {
  const phraseCompletion = exactPhraseCompletion(text, source);
  if (phraseCompletion) return phraseCompletion;
  const lower = text.toLowerCase();
  const clauses = [];
  if (source === "search") {
    if (!/peenya|coimbatore|bhosari|chennai|pune|bengaluru|bangalore|cluster|\bnear\b|\bin\s+[a-z]/i.test(lower)) clauses.push(" in Coimbatore");
    if (!/₹|rs\.?|inr|budget|under|below|per day|\/day/i.test(lower)) clauses.push(" under ₹9,000 per day");
    if (!/verified|approved/i.test(lower)) clauses.push(", verified");
    if (!/available|next week|today|date|deadline/i.test(lower)) clauses.push(" and available next week");
  } else if (source === "planner") {
    if (!/\b\d[\d,]*\s*(unit|piece|part|bracket|shaft|enclosure)/i.test(lower)) clauses.push(" for 2,000 units");
    if (!/aluminium|aluminum|steel|brass|plastic|material/i.test(lower)) clauses.push(" in aluminium");
    if (!/cnc|mill|turn|cut|bend|finish|inspect|process/i.test(lower)) clauses.push(" with CNC machining, finishing and inspection");
    if (!/\b\d+\s*days?|deadline|by\s/i.test(lower)) clauses.push(" in 5 days");
    if (!/₹|rs\.?|inr|budget/i.test(lower)) clauses.push(", budget ₹80,000");
  } else {
    if (!/peenya|coimbatore|bhosari|chennai|pune|bengaluru|bangalore|cluster|\bin\s+[a-z]/i.test(lower)) clauses.push(" in Bhosari");
    if (!/₹|rs\.?|inr|price|rate|per day|\/day/i.test(lower)) clauses.push(" for ₹8,500 per day");
    if (!/available|capacity|capability|machin|inspect|storage/i.test(lower)) clauses.push(", available for precision machining");
  }
  return clauses.join("").slice(0, 220);
}

async function loadGenerator() {
  if (modelAttempted) return generatorPromise;
  modelAttempted = true;
  generatorPromise = (async () => {
    self.postMessage({ type: "model-status", status: "loading", model: MODEL_ID });
    try {
      const { pipeline, env } = await import(TRANSFORMERS_CDN);
      if (env) env.useBrowserCache = true;
      try {
        const generator = await pipeline("text-generation", MODEL_ID, { dtype: "q4", device: "webgpu" });
        self.postMessage({ type: "model-status", status: "ready", device: "webgpu", model: MODEL_ID });
        return generator;
      } catch (webGpuError) {
        const generator = await pipeline("text-generation", MODEL_ID, { dtype: "q4", device: "wasm" });
        self.postMessage({ type: "model-status", status: "ready", device: "wasm", model: MODEL_ID });
        return generator;
      }
    } catch (error) {
      self.postMessage({ type: "model-status", status: "fallback", model: MODEL_ID });
      return null;
    }
  })();
  return generatorPromise;
}

function generatedTextFrom(output, prompt) {
  let generated = output?.[0]?.generated_text ?? output?.generated_text ?? "";
  if (Array.isArray(generated)) generated = generated.at(-1)?.content || "";
  generated = String(generated).replace(prompt, "").replace(/^\s*(Continuation:|Output:)\s*/i, "").trim();
  generated = generated.split(/\r?\n/)[0].replace(/^['"`]|['"`]$/g, "");
  return generated.slice(0, 220);
}

async function generateEnhancement(request) {
  const generator = await loadGenerator();
  if (!generator || latestRequestBySource.get(request.source) !== request.id) return;
  const prompt = `Complete this unfinished factory marketplace request. Return only a short continuation; do not repeat the input and do not invent an action.\nContext: ${request.source}\nInput: ${request.text}\nContinuation:`;
  try {
    const output = await generator(prompt, {
      max_new_tokens: 36,
      do_sample: false,
      repetition_penalty: 1.08,
      return_full_text: false,
    });
    if (latestRequestBySource.get(request.source) !== request.id) return;
    const completion = generatedTextFrom(output, prompt);
    if (completion) self.postMessage({ type: "enhancement", id: request.id, text: request.text, completion, engine: "qwen2.5-0.5b-q4" });
  } catch {
    /* The phrase suggestion was already returned and remains the guaranteed path. */
  }
}

self.addEventListener("message", (event) => {
  const request = event.data || {};
  if (request.type === "warm") {
    void loadGenerator();
    return;
  }
  if (request.type !== "suggest" || !request.id || !request.text) return;
  latestRequestBySource.set(request.source, request.id);
  const completion = localDomainCompletion(String(request.text), request.source);
  self.postMessage({
    type: "suggestion",
    id: request.id,
    text: request.text,
    completion,
    engine: "local-domain-phrases",
  });
  void generateEnhancement(request);
});
