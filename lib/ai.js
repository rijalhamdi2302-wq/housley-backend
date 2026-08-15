/**
 * Housely — server-side AI client (Groq, OpenAI-compatible API).
 * The API key lives ONLY in backend/.env (GROQ_API_KEY) and is never sent
 * to the app — the phone talks to Housely's own routes, which call Groq.
 *
 * Models (overridable via env):
 *   - GROQ_VISION_MODEL (default qwen/qwen3.6-27b) — reads receipt photos
 *   - GROQ_TEXT_MODEL    (default llama-3.3-70b-versatile) — text/JSON tasks
 */

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const KEY = String(process.env.GROQ_API_KEY || '').trim();
const TIMEOUT_MS = 90 * 1000; // vision + long receipts can be slow

const MODELS = {
  vision: process.env.GROQ_VISION_MODEL || 'qwen/qwen3.6-27b',
  text: process.env.GROQ_TEXT_MODEL || 'llama-3.3-70b-versatile',
};

/** True when GROQ_API_KEY is configured. */
function enabled() {
  return Boolean(KEY);
}

/**
 * One chat completion. Returns the raw text content.
 * - images: array of base64 data URLs (used with a vision model)
 * - json:   request JSON mode (the prompt must mention "json")
 */
async function chat({ model, system, user, images = [], json = false, maxTokens = 1600, temperature = 0.2 }) {
  if (!KEY) {
    const err = new Error('AI is not configured on the server (missing GROQ_API_KEY).');
    err.status = 503;
    throw err;
  }
  const content = [{ type: 'text', text: user }];
  for (const img of images) content.push({ type: 'image_url', image_url: { url: img } });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(GROQ_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content },
        ],
        ...(json ? { response_format: { type: 'json_object' } } : {}),
        max_tokens: maxTokens,
        temperature,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      let msg = `AI request failed (${res.status})`;
      try {
        const d = await res.json();
        if (d?.error?.message) msg = d.error.message;
      } catch {
        /* non-JSON error body */
      }
      const err = new Error(msg);
      err.status = 502;
      throw err;
    }
    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content;
    if (!text) {
      const err = new Error('The AI returned an empty answer. Try again.');
      err.status = 502;
      throw err;
    }
    return text;
  } catch (err) {
    if (err.name === 'AbortError') {
      const e = new Error('The AI took too long. Try a smaller image or try again.');
      e.status = 504;
      throw e;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Robust JSON extraction from an AI answer: strips markdown fences and grabs
 * the first balanced {...} block. Returns null when nothing parses.
 */
function parseJSON(text) {
  if (!text) return null;
  let t = String(text).trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  try {
    return JSON.parse(t);
  } catch {
    /* fall through to brace-slicing */
  }
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(t.slice(start, end + 1));
    } catch {
      /* give up */
    }
  }
  return null;
}

module.exports = { enabled, chat, parseJSON, MODELS };
