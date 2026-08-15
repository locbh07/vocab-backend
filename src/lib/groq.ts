export type GroqJsonOptions = {
  systemInstruction?: string;
  prompt: string;
  model?: string;
  temperature?: number;
  timeoutMs?: number;
};

export type GroqJsonResult = {
  json: unknown;
  model: string;
  rawText: string;
};

type GroqChatResponse = {
  choices?: Array<{ message?: { content?: string } }>;
};

// Free-tier fallback for generateGeminiJson (see gemini.ts) — used when Gemini itself fails
// (quota/billing/outage). Groq's free tier is a separate account entirely, so it stays up
// when Gemini's shared key is down for the rest of the app. Mirrors generateGeminiJson's
// shape so callers can try one then the other without branching logic.
export async function generateGroqJson(options: GroqJsonOptions): Promise<GroqJsonResult> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    const error = new Error('GROQ_API_KEY is not configured') as Error & { status?: number };
    error.status = 503;
    throw error;
  }

  const model = String(options.model || process.env.GROQ_MODEL || 'openai/gpt-oss-120b').trim();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1_000, options.timeoutMs || 30_000));

  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        messages: [
          ...(options.systemInstruction ? [{ role: 'system', content: options.systemInstruction }] : []),
          { role: 'user', content: options.prompt },
        ],
        temperature: options.temperature ?? 0.2,
        response_format: { type: 'json_object' },
      }),
    });

    if (!response.ok) {
      const detail = await response.text();
      const error = new Error(`Groq request failed (${response.status}): ${detail}`) as Error & {
        status?: number;
      };
      error.status = response.status;
      throw error;
    }

    const data = (await response.json()) as GroqChatResponse;
    const rawText = String(data?.choices?.[0]?.message?.content || '').trim();
    if (!rawText) throw new Error('Groq returned empty content');

    return { json: parseJsonText(rawText), model, rawText };
  } finally {
    clearTimeout(timeout);
  }
}

function parseJsonText(input: string): unknown {
  const text = String(input || '').trim();
  if (!text) throw new Error('Cannot parse empty JSON text');
  try {
    return JSON.parse(text);
  } catch (_error) {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
    if (fenced) return JSON.parse(fenced);
    const first = text.indexOf('{');
    const last = text.lastIndexOf('}');
    if (first >= 0 && last > first) return JSON.parse(text.slice(first, last + 1));
    throw _error;
  }
}
