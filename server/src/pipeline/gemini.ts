import fs from 'node:fs';
import { GoogleGenAI, type Part, ThinkingLevel, MediaResolution } from '@google/genai';
import { config } from '../config.js';
import { gcs } from '../infra/cloudStore.js';
import { sleep } from '../lib/proc.js';

/**
 * All AI in CrestClip goes through Gemini on Google Cloud Vertex AI
 * (now branded "Gemini Enterprise Agent Platform") so it bills against your GCP credits.
 * Auth = Application Default Credentials: `gcloud auth application-default login`
 * or GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json
 */
let client: GoogleGenAI | null = null;
function ai(): GoogleGenAI {
  if (client) return client;
  if (config.vertexApiKey) {
    // API-key mode: billed to the key's project, always on the global endpoint.
    client = new GoogleGenAI({ vertexai: true, apiKey: config.vertexApiKey });
  } else {
    if (!config.gcpProject) throw new Error('Set GOOGLE_CLOUD_PROJECT (with gcloud login) or VERTEX_API_KEY in .env to use Gemini on Vertex AI.');
    client = new GoogleGenAI({ vertexai: true, project: config.gcpProject, location: config.gcpLocation });
  }
  return client;
}

export async function uploadToGcs(localPath: string, dest: string, contentType: string): Promise<string> {
  if (!config.gcsBucket) throw new Error('GCS_BUCKET not set');
  await gcs().bucket(config.gcsBucket).upload(localPath, { destination: dest, contentType, resumable: true });
  return `gs://${config.gcsBucket}/${dest}`;
}

export async function deleteFromGcs(dest: string) {
  if (!config.gcsBucket) return;
  await gcs()
    .bucket(config.gcsBucket)
    .file(dest)
    .delete({ ignoreNotFound: true })
    .catch(() => {});
}

export const part = {
  text: (text: string): Part => ({ text }),
  file: (localPath: string, mimeType: string): Part => ({ inlineData: { mimeType, data: fs.readFileSync(localPath).toString('base64') } }),
  uri: (fileUri: string, mimeType: string, videoMetadata?: { startOffset?: string; endOffset?: string; fps?: number }): Part => ({
    fileData: { fileUri, mimeType },
    ...(videoMetadata ? { videoMetadata } : {}),
  }),
};

interface JsonCall {
  model?: string;
  system?: string;
  parts: Part[];
  schema: object;
  thinking?: 'MINIMAL' | 'LOW' | 'MEDIUM' | 'HIGH';
  audioTimestamp?: boolean;
  lowMediaRes?: boolean;
  maxOutputTokens?: number;
  label?: string;
  /** give up on one try after this long (default 5 min) — a call that never answers must not freeze a project */
  timeoutMs?: number;
}

interface Usage {
  input: number;
  output: number;
  calls: number;
}
export const usage: Usage = { input: 0, output: 0, calls: 0 };

/** Call Gemini and get back parsed JSON that matches `schema`. Retries on rate limits / transient errors. */
export async function generateJson<T>(c: JsonCall): Promise<T> {
  const model = c.model ?? config.model;
  let lastErr: unknown;
  // Compatibility switches, flipped on the fly if Vertex rejects a field for this model.
  let useThinking = Boolean(c.thinking);
  let schemaField: 'responseJsonSchema' | 'responseSchema' = 'responseJsonSchema';
  let useMediaRes = Boolean(c.lowMediaRes);
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const res = await ai().models.generateContent({
        model,
        contents: [{ role: 'user', parts: c.parts }],
        config: {
          systemInstruction: c.system,
          responseMimeType: 'application/json',
          [schemaField]: c.schema,
          maxOutputTokens: c.maxOutputTokens ?? 32768,
          ...(useThinking ? { thinkingConfig: { thinkingLevel: c.thinking as ThinkingLevel } } : {}),
          ...(c.audioTimestamp ? { audioTimestamp: true } : {}),
          ...(useMediaRes ? { mediaResolution: MediaResolution.MEDIA_RESOLUTION_LOW } : {}),
          abortSignal: AbortSignal.timeout(c.timeoutMs ?? 5 * 60_000),
        },
      });
      usage.calls++;
      usage.input += res.usageMetadata?.promptTokenCount ?? 0;
      usage.output += res.usageMetadata?.candidatesTokenCount ?? 0;
      const text = res.text ?? '';
      if (!text.trim()) throw new Error(`Gemini returned an empty response (${res.candidates?.[0]?.finishReason ?? 'unknown'})`);
      try {
        return JSON.parse(stripFences(text)) as T;
      } catch (parseErr) {
        // a cut-off or garbled answer: try again; on the last try keep what's complete rather than failing the video
        if (attempt < 2) throw new Error(`Gemini returned broken JSON (${res.candidates?.[0]?.finishReason ?? 'unknown'}): ${(parseErr as Error).message}`);
        const saved = salvageJson(stripFences(text));
        if (saved === undefined) throw parseErr;
        console.warn(`[gemini] ${c.label ?? 'call'}: answer was cut off or garbled — kept the complete part`);
        return saved as T;
      }
    } catch (e) {
      lastErr = e;
      const msg = String((e as Error)?.message ?? e);
      const status = (e as { status?: number })?.status;
      // timed out: one more try could take just as long, so stop here (callers fall back, e.g. without the video)
      if ((e as Error)?.name === 'TimeoutError' || (e as Error)?.name === 'AbortError') {
        lastErr = new Error(`Gemini took too long to answer${c.label ? ` (${c.label})` : ''}. Please try again.`);
        break;
      }
      if (status === 400 || /INVALID_ARGUMENT/.test(msg)) {
        if (useThinking && /think/i.test(msg)) {
          useThinking = false;
          continue;
        }
        if (schemaField === 'responseJsonSchema' && /schema/i.test(msg)) {
          schemaField = 'responseSchema';
          continue;
        }
        if (useMediaRes && /media_?resolution/i.test(msg)) {
          useMediaRes = false;
          continue;
        }
      }
      const retryable =
        status === 429 || (status && status >= 500) || /RESOURCE_EXHAUSTED|UNAVAILABLE|DEADLINE|ECONNRESET|fetch failed|broken JSON|Unexpected end of JSON|Unterminated|empty response/i.test(msg);
      if (!retryable || attempt >= 4) break;
      await sleep(2000 * 2 ** Math.min(attempt, 3) + Math.random() * 1000);
    }
  }
  throw explain(lastErr, model, c.label);
}

/**
 * Rescue the complete part of a cut-off or slightly broken JSON answer: drop trailing commas, cut back to the last
 * fully closed object/array and close whatever is still open. Returns undefined when nothing usable is left.
 */
export function salvageJson(text: string): unknown {
  const s = text.replace(/,\s*([}\]])/g, '$1');
  try {
    return JSON.parse(s);
  } catch {
    /* repair below */
  }
  // remember every place where an object/array has just closed, with what is still open there
  const cuts: { at: number; open: string }[] = [];
  const stack: string[] = [];
  let inStr = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (ch === '\\') i++;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{' || ch === '[') stack.push(ch);
    else if (ch === '}' || ch === ']') {
      stack.pop();
      cuts.push({ at: i + 1, open: stack.join('') });
    }
  }
  for (let k = cuts.length - 1; k >= 0 && k >= cuts.length - 50; k--) {
    const { at, open } = cuts[k];
    const closing = [...open]
      .reverse()
      .map((b) => (b === '{' ? '}' : ']'))
      .join('');
    try {
      return JSON.parse(s.slice(0, at) + closing);
    } catch {
      /* try an earlier cut */
    }
  }
  return undefined;
}

function stripFences(s: string) {
  return s.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '');
}

function explain(e: unknown, model: string, label?: string): Error {
  const msg = String((e as Error)?.message ?? e);
  const where = label ? ` during "${label}"` : '';
  if (/API key not valid|API_KEY_INVALID/i.test(msg)) return new Error(`The VERTEX_API_KEY in .env was rejected${where}.`);
  if (/Could not load the default credentials|invalid_grant|UNAUTHENTICATED/i.test(msg)) return new Error(`Google Cloud login is missing${where}. Run: gcloud auth application-default login`);
  if (/PERMISSION_DENIED|403/i.test(msg)) return new Error(`Vertex AI said "permission denied"${where}. Enable aiplatform.googleapis.com and give your account the "Vertex AI User" role.`);
  if (/NOT_FOUND|404/i.test(msg) && /model/i.test(msg))
    return new Error(`Model "${model}" was not found in location "${config.gcpLocation}"${where}. Check GEMINI_MODEL / GOOGLE_CLOUD_LOCATION in .env.`);
  // anything else: the full detail goes to the server log, the person gets something they can act on
  console.warn(`[gemini] failed${where}: ${msg.slice(0, 600)}`);
  if (/RESOURCE_EXHAUSTED|429|quota/i.test(msg)) return new Error('The AI is busy right now (too many requests). Please try again in a few minutes.');
  if (/took too long/i.test(msg)) return new Error(msg);
  const step = label ? ` while it was on “${label.replace(/ \d+\/\d+$/, '')}”` : '';
  return new Error(`The AI had trouble with this video${step}. Press Try again — it usually works the second time.`);
}

export async function checkGemini(): Promise<{ ok: boolean; detail: string }> {
  if (config.fakeAi) return { ok: true, detail: 'Fake AI mode (development only)' };
  if (!config.gcpProject && !config.vertexApiKey) return { ok: false, detail: 'GOOGLE_CLOUD_PROJECT or VERTEX_API_KEY is not set' };
  try {
    const r = await generateJson<{ ok: boolean }>({
      model: config.fastModel,
      parts: [part.text('Reply with {"ok": true}')],
      schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
      thinking: 'MINIMAL',
      maxOutputTokens: 512,
      label: 'health check',
    });
    return {
      ok: Boolean(r.ok),
      detail: config.vertexApiKey ? `Connected with a Vertex AI API key${config.gcpProject ? ` (${config.gcpProject})` : ''}` : `Connected to ${config.gcpProject} (${config.gcpLocation})`,
    };
  } catch (e) {
    return { ok: false, detail: (e as Error).message };
  }
}
