import { statSync } from 'node:fs';
import { serverText } from '../../../lib/server-texts/server-texts.ts';
import { readHeadRecords, readTailRecords } from '../ChatTranscriptFile/ChatTranscriptFile.ts';
import { coldBriefFacts } from '../cold-brief/cold-brief.ts';
import { coldResume } from '../group-continuation/group-continuation.ts';
import { FOREIGN_COLD_AFTER_MS } from '../token-ledger/foreign/foreign-cache.ts';
import { foreignWatchEvents } from '../token-ledger/foreign/foreign-events.ts';
import type {
  ForeignTranscriptKind,
  ForeignWarmth,
} from '../token-ledger/foreign/foreign.types.ts';
import { COLD_RESUME_INTRO } from '../split-continue.ts';

/**
 * «Продолжить остывшую сессию или начать новую» у групп Codex и Qwen Code —
 * то же правило, что у Claude (`decideContinuation`): рычаг
 * `freshOnColdResume`, кэш остыл, окно выше базы + 25k (`coldResume`). Своё
 * здесь — срок остывания (кэш провайдера, не Claude) и чтение переписки CLI.
 * Вводную собирает панель из файлов копии, как у Claude.
 */

// Срок остывания — один на решение здесь и сигнал сторожа R2: живёт у переписки CLI.
export { FOREIGN_COLD_AFTER_MS };

/** Хвоста в полмегабайта хватает на последний вызов и ответ даже за большим выводом. */
const WARMTH_TAIL_BYTES = 512 * 1024;

type Json = Record<string, unknown>;
const obj = (value: unknown): Json | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : undefined;

/** Окно вызова (вход без кэша + чтение + запись) по событиям одной строки. */
function callContext(kind: ForeignTranscriptKind, rows: readonly unknown[]): number[] {
  const read = foreignWatchEvents(kind);
  const out: number[] = [];
  for (const row of rows) {
    for (const event of read(row)) {
      if (event.kind === 'call') out.push(event.input + event.cacheRead + event.cacheWrite);
    }
  }
  return out.filter((ctx) => ctx > 0);
}

/** Текст ответа модели в строке переписки; не ответ — пусто. */
function answerText(kind: ForeignTranscriptKind, row: unknown): string {
  const record = obj(row);
  if (!record) return '';
  if (kind === 'codex') {
    const payload = obj(record.payload);
    if (record.type !== 'response_item' || payload?.type !== 'message') return '';
    if (payload.role !== 'assistant' || !Array.isArray(payload.content)) return '';
    return payload.content
      .map((part) => (obj(part)?.type === 'output_text' ? String(obj(part)?.text ?? '') : ''))
      .join('');
  }
  const parts = obj(record.message)?.parts;
  if (record.type !== 'assistant' || !Array.isArray(parts)) return '';
  // Размышления (`thought`) — не ответ человеку.
  return parts
    .map((part) => {
      const item = obj(part);
      return item && item.thought !== true && typeof item.text === 'string' ? item.text : '';
    })
    .join('');
}

/** Время строки переписки, мс эпохи. */
function rowTime(row: unknown): number {
  const stamp = obj(row)?.timestamp;
  return typeof stamp === 'string' ? Date.parse(stamp) : NaN;
}

/**
 * Что решению нужно о сессии CLI: время последней записи (у отметки живой
 * сессии времени нет — `live-session.ts`), окно последнего и первого вызова и
 * последний ответ модели (итог прежней стадии для вводной).
 */
export function foreignWarmth(
  kind: ForeignTranscriptKind,
  file: string,
): (ForeignWarmth & { lastAnswer: string }) | undefined {
  let tail: unknown[];
  let mtimeMs: number;
  try {
    tail = readTailRecords(file, WARMTH_TAIL_BYTES);
    mtimeMs = statSync(file).mtimeMs;
  } catch {
    return undefined;
  }
  let lastAt = NaN;
  for (let index = tail.length - 1; index >= 0 && !Number.isFinite(lastAt); index -= 1) {
    lastAt = rowTime(tail[index]);
  }
  let lastAnswer = '';
  for (let index = tail.length - 1; index >= 0 && !lastAnswer.trim(); index -= 1) {
    lastAnswer = answerText(kind, tail[index]);
  }
  const contexts = callContext(kind, tail);
  const head = callContext(kind, readHeadRecords(file));
  return {
    lastAt: Number.isFinite(lastAt) ? lastAt : mtimeMs,
    contextTokens: contexts.at(-1) ?? 0,
    freshBase: head[0] ?? 0,
    lastAnswer,
  };
}

export interface ForeignColdInput {
  kind: ForeignTranscriptKind;
  /** Переписка продолжаемой сессии CLI. */
  file: string;
  /** Прежняя сессия — в заметке человеку. */
  previous: string;
  /** Копия группы: заметки и git для вводной. */
  cwd: string;
  /** Первые строки вводной (`continuationIntro`); нет — общая строка. */
  intro?: string;
  /** Ветка, от которой отведена копия группы. */
  base?: string;
  /** Прогон на локальной модели: кэша провайдера нет — продолжать всегда. */
  local?: boolean;
  /** Свой срок остывания (проверки); нет — `FOREIGN_COLD_AFTER_MS` по CLI. */
  coldAfterMs?: number;
  now: number;
}

export type ForeignColdPlan =
  | { kind: 'resume' }
  | { kind: 'fresh'; brief: string; tail: number; notice: string; contextTokens: number };

/** Сколько последних реплик разговора едет в новую сессию вслед за вводной. */
export const FOREIGN_COLD_TAIL = 2;

/**
 * Решение для `setColdPlan`. Рычаг `freshOnColdResume` проверяет зовущий (он
 * читает настройки): сюда приходят только группы с включённым рычагом.
 */
export function foreignColdPlan(input: ForeignColdInput): ForeignColdPlan {
  if (input.local) return { kind: 'resume' };
  const warmth = foreignWarmth(input.kind, input.file);
  if (!warmth) return { kind: 'resume' };
  const cold = coldResume({
    idleMs: input.now - warmth.lastAt,
    contextTokens: warmth.contextTokens,
    freshBase: warmth.freshBase,
    coldAfterMs: input.coldAfterMs ?? FOREIGN_COLD_AFTER_MS[input.kind],
  });
  if (!cold) return { kind: 'resume' };
  const facts = coldBriefFacts(input.cwd, input.file, input.base, {
    lastAnswer: warmth.lastAnswer,
  });
  const params = {
    tokens: String(Math.round(warmth.contextTokens / 1000)),
    previous: input.previous,
  };
  return {
    kind: 'fresh',
    brief: `${input.intro ?? COLD_RESUME_INTRO}\n\n${facts}`,
    tail: FOREIGN_COLD_TAIL,
    notice: serverText('chat-cold-resume-notice', params),
    contextTokens: warmth.contextTokens,
  };
}
