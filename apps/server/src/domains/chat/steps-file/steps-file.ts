import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { ChatProgress } from '@agentdeck/contracts';

/**
 * Файл шагов разговора — `.agent/steps.json` в его рабочей папке (решение
 * владельца 29.09). Общий и не привязанный к проекту: навык проекта сам пишет
 * номер, всего и название шага, а панель показывает «Шаг 8 из 14» у группы,
 * которая плана агента (TodoWrite) не ведёт.
 *
 * Форма: `{ "current": 8, "total": 14, "title": "Прогон тестов" }`. Навыки,
 * написанные раньше этого соглашения, пишут `step` и `name` — принимаются так же.
 * Неверный файл — шага нет: панель не выдумывает «0 из 0».
 */
export const STEPS_FILE = join('.agent', 'steps.json');

/** Больше — не шаги, а опечатка или чужой файл. */
const MAX_STEPS = 1000;
/** Файл шагов — несколько строк; большой — не он. */
const MAX_BYTES = 64 * 1024;

export function readStepsFile(cwd: string | undefined): ChatProgress['steps'] {
  if (!cwd) return undefined;
  const path = join(cwd, STEPS_FILE);
  let raw: unknown;
  let updatedAt: string;
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > MAX_BYTES) return undefined;
    updatedAt = stat.mtime.toISOString();
    raw = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return undefined;
  }
  return parseSteps(raw, updatedAt);
}

export function parseSteps(raw: unknown, updatedAt?: string): ChatProgress['steps'] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  const current = value.current ?? value.step;
  const total = value.total;
  if (!Number.isInteger(current) || !Number.isInteger(total)) return undefined;
  const at = current as number;
  const all = total as number;
  if (at < 1 || all < 1 || at > all || all > MAX_STEPS) return undefined;
  const title = [value.title, value.name].find(
    (item): item is string => typeof item === 'string' && item.trim() !== '',
  );
  return {
    current: at,
    total: all,
    ...(title ? { title: title.trim().slice(0, 200) } : {}),
    ...(updatedAt ? { updatedAt } : {}),
  };
}
