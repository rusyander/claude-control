/**
 * Клиент Gemini API по справке «Generating content» (`GenerateContentResponse`) — строгий: поток —
 * события без имени, каждое `data:` — частичный ответ с одним `candidates[0]` (индекс 0, роль
 * `model`), часть — ровно одно из `text` / `functionCall`; `responseId` один на поток;
 * `finishReason` — только в последнем кадре, расход (`usageMetadata`) — только там же или в
 * кадрах без содержимого после него не бывает; `[DONE]` в потоке Google нет — встреча с ним
 * провал. Ошибка — `{error: {code, message, status}}`: код — число, статус — строка словаря
 * `google.rpc.Code`; посреди потока — последним кадром. Тип ошибки в общей форме ответа —
 * статус строчными (`RESOURCE_EXHAUSTED` → `resource_exhausted`).
 */
import { dataJson, parseSse } from './sse.ts';
import { usageWith, type Reply, type ReplyPart, type Usage } from './reply.ts';

const fail = (why: string): never => {
  throw new Error(`google-genai stream: ${why}`);
};
const failJson = (why: string): never => {
  throw new Error(`google-genai json: ${why}`);
};

type Record_ = Record<string, unknown>;

function errorOf(raw: unknown, onFail: (why: string) => never): { type: string; message: string } {
  const error = raw as Record_ | undefined;
  if (typeof error?.code !== 'number') onFail('error without numeric error.code');
  if (typeof error!.message !== 'string') onFail('error without error.message');
  if (typeof error!.status !== 'string' || !/^[A-Z][A-Z_]*$/.test(error!.status as string))
    onFail('error without a google.rpc status name');
  return { type: (error!.status as string).toLowerCase(), message: error!.message as string };
}

/** Расход по справке: `totalTokenCount` = вход + выход; кеш входит во вход. */
function usageOf(raw: unknown, onFail: (why: string) => never): Usage {
  const usage = raw as Record_ | undefined;
  const prompt = usage?.promptTokenCount;
  const output = usage?.candidatesTokenCount;
  if (typeof prompt !== 'number' || typeof output !== 'number')
    onFail('usageMetadata without promptTokenCount/candidatesTokenCount');
  if (usage!.totalTokenCount !== (prompt as number) + (output as number))
    onFail('usageMetadata total mismatch');
  return usageWith(prompt as number, output as number, usage!.cachedContentTokenCount);
}

/** Части одного кандидата: текст склеивается, вызов — целиком, со своим именем и объектом аргументов. */
function readParts(candidate: Record_, into: ReplyPart[], onFail: (why: string) => never): void {
  const content = candidate.content as Record_ | undefined;
  if (!content || content.role !== 'model') onFail('candidate content role is not model');
  const parts = content!.parts;
  if (!Array.isArray(parts)) onFail('candidate content without parts');
  for (const raw of parts as Record_[]) {
    const keys = Object.keys(raw).filter((k) => k === 'text' || k === 'functionCall');
    if (keys.length !== 1) onFail(`part with ${keys.length} of text/functionCall`);
    if (typeof raw.text === 'string') {
      if (raw.text === '') continue;
      const last = into.at(-1);
      if (last?.kind === 'text') last.text += raw.text;
      else into.push({ kind: 'text', text: raw.text });
      continue;
    }
    const call = raw.functionCall as Record_;
    if (typeof call?.name !== 'string' || !call.name) onFail('functionCall without name');
    if (!call.args || typeof call.args !== 'object' || Array.isArray(call.args))
      onFail('functionCall args is not an object');
    if (typeof call.id !== 'string' || !call.id) onFail('functionCall without id');
    into.push({ kind: 'tool', id: call.id as string, name: call.name as string, args: call.args });
  }
}

function candidateOf(response: Record_, onFail: (why: string) => never): Record_ {
  const candidates = response.candidates;
  if (!Array.isArray(candidates) || candidates.length !== 1) onFail('not exactly one candidate');
  const candidate = (candidates as Record_[])[0]!;
  if (candidate.index !== 0) onFail(`candidate index ${String(candidate.index)}`);
  return candidate;
}

export function readGoogleStream(text: string): Reply {
  const events = parseSse(text);
  let id: string | undefined;
  let finish: string | undefined;
  let usage: Usage | undefined;
  const parts: ReplyPart[] = [];
  for (const [at, event] of events.entries()) {
    if (event.named) fail(`named event ${event.event} in a Gemini stream`);
    if (event.data === '[DONE]') fail('[DONE] is not part of a Gemini stream');
    const response = dataJson(event);
    if (response.error) {
      const error = errorOf(response.error, fail);
      if (at !== events.length - 1) fail('a frame after the error frame');
      return { kind: 'error', midStream: true, ...error };
    }
    if (finish !== undefined) fail('a frame after finishReason');
    if (typeof response.responseId !== 'string') fail('chunk without responseId');
    if (id === undefined) id = response.responseId as string;
    else if (response.responseId !== id) fail('responseId changed mid-stream');
    if (typeof response.modelVersion !== 'string') fail('chunk without modelVersion');
    const candidate = candidateOf(response, fail);
    readParts(candidate, parts, fail);
    if (candidate.finishReason !== undefined) finish = String(candidate.finishReason);
    if (response.usageMetadata) {
      if (candidate.finishReason === undefined) fail('usageMetadata before the last chunk');
      usage = usageOf(response.usageMetadata, fail);
    }
  }
  if (finish === undefined) fail('stream ended without finishReason');
  return { kind: 'message', id: id!, stopReason: finish!, ...(usage ? { usage } : {}), parts };
}

export function readGoogleJson(body: Record_): Reply {
  if (body.error) return { kind: 'error', midStream: false, ...errorOf(body.error, failJson) };
  if (typeof body.responseId !== 'string') failJson('response without responseId');
  const candidate = candidateOf(body, failJson);
  if (typeof candidate.finishReason !== 'string') failJson('candidate without finishReason');
  const parts: ReplyPart[] = [];
  readParts(candidate, parts, failJson);
  return {
    kind: 'message',
    id: body.responseId as string,
    stopReason: candidate.finishReason as string,
    usage: usageOf(body.usageMetadata, failJson),
    parts,
  };
}
