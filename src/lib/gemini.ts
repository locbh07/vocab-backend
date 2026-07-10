export type GeminiJsonOptions = {
  systemInstruction?: string;
  prompt: string;
  model?: string;
  temperature?: number;
  timeoutMs?: number;
};

export type GeminiJsonResult = {
  json: unknown;
  model: string;
  rawText: string;
};

type GeminiGenerateResponse = {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string }>;
    };
  }>;
};

export async function generateGeminiJson(options: GeminiJsonOptions): Promise<GeminiJsonResult> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    const error = new Error('GEMINI_API_KEY is not configured') as Error & { status?: number };
    error.status = 503;
    throw error;
  }

  const model = String(options.model || process.env.GEMINI_MODEL || 'gemini-2.5-flash').trim();
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    model,
  )}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1_000, options.timeoutMs || 45_000));

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        ...(options.systemInstruction
          ? { systemInstruction: { parts: [{ text: options.systemInstruction }] } }
          : {}),
        contents: [
          {
            role: 'user',
            parts: [{ text: options.prompt }],
          },
        ],
        generationConfig: {
          temperature: options.temperature ?? 0.2,
          responseMimeType: 'application/json',
        },
      }),
    });

    if (!response.ok) {
      const detail = await response.text();
      const error = new Error(`Gemini request failed (${response.status}): ${detail}`) as Error & {
        status?: number;
      };
      error.status = response.status;
      throw error;
    }

    const data = (await response.json()) as GeminiGenerateResponse;
    const rawText = String(
      data?.candidates?.[0]?.content?.parts
        ?.map((part) => part.text || '')
        .join('')
        .trim() || '',
    );
    if (!rawText) throw new Error('Gemini returned empty content');

    return {
      json: parseJsonText(rawText),
      model,
      rawText,
    };
  } finally {
    clearTimeout(timeout);
  }
}

export type GeminiGroundedTextOptions = {
  systemInstruction?: string;
  prompt: string;
  model?: string;
  temperature?: number;
  timeoutMs?: number;
};

export type GeminiGroundedTextResult = {
  text: string;
  model: string;
  grounded: boolean;
};

// Search-grounded generation: lets Gemini consult real web results instead of relying only
// on its own recall, for cases where content must be sourced rather than guessed.
// NOTE: the Gemini API does not support combining the google_search tool with
// responseMimeType:"application/json" in one call, so this returns free text — pair it with
// a second generateGeminiJson() call to structure the result into a patch.
export async function generateGeminiGroundedText(
  options: GeminiGroundedTextOptions,
): Promise<GeminiGroundedTextResult> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    const error = new Error('GEMINI_API_KEY is not configured') as Error & { status?: number };
    error.status = 503;
    throw error;
  }

  const model = String(options.model || process.env.GEMINI_MODEL || 'gemini-2.5-flash').trim();
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    model,
  )}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1_000, options.timeoutMs || 45_000));

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        ...(options.systemInstruction
          ? { systemInstruction: { parts: [{ text: options.systemInstruction }] } }
          : {}),
        contents: [
          {
            role: 'user',
            parts: [{ text: options.prompt }],
          },
        ],
        tools: [{ google_search: {} }],
        generationConfig: {
          temperature: options.temperature ?? 0.2,
        },
      }),
    });

    if (!response.ok) {
      const detail = await response.text();
      const error = new Error(`Gemini grounded request failed (${response.status}): ${detail}`) as Error & {
        status?: number;
      };
      error.status = response.status;
      throw error;
    }

    const data = (await response.json()) as GeminiGenerateResponse & {
      candidates?: Array<{ groundingMetadata?: unknown }>;
    };
    const text = String(
      data?.candidates?.[0]?.content?.parts
        ?.map((part) => part.text || '')
        .join('')
        .trim() || '',
    );
    if (!text) throw new Error('Gemini returned empty grounded content');

    return {
      text,
      model,
      grounded: Boolean(data?.candidates?.[0]?.groundingMetadata),
    };
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
