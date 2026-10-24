import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GROUP_ECONOMY_DEFAULTS } from '@agentdeck/contracts/group-economy';
import { decideContinuation } from './cold-continuation.ts';

/**
 * Пинг тёплого кэша (`keep-warm`) идёт без транскрипта: время файла о нём не
 * знает. Отметка `warmedAt` — единственное, по чему решение о продолжении видит,
 * что кэш свежий; без неё согретая сессия уходила бы в новый разговор.
 */

const MIN = 60_000;

describe('decideContinuation и отметка пинга', () => {
  let root: string;
  let dir: string;
  const now = Date.now();

  const call = (context: number) =>
    JSON.stringify({
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: 'ok' }],
        usage: {
          input_tokens: 0,
          output_tokens: 10,
          cache_read_input_tokens: context,
          cache_creation_input_tokens: 0,
        },
      },
    });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'kw-cont-'));
    dir = join(root, 'projects');
    mkdirSync(join(dir, 'C--copy'), { recursive: true });
    const file = join(dir, 'C--copy', 's1.jsonl');
    // База 40k, последнее окно 120k — выше порога база + 25k; файл не менялся 70 минут.
    writeFileSync(file, `${[call(40_000), call(120_000)].join('\n')}\n`, 'utf8');
    const at = new Date(now - 70 * MIN);
    utimesSync(file, at, at);
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const decide = (over: { warmedAt?: number; afterLimit?: boolean } = {}) =>
    decideContinuation({
      dir,
      sessionId: 's1',
      cwd: root,
      economy: GROUP_ECONOMY_DEFAULTS,
      now,
      ...over,
    }).kind;

  it('без пинга остывшая сессия идёт новым разговором', () => {
    expect(decide()).toBe('fresh');
  });

  it('пинг 20 минут назад — кэш тёплый, сессия продолжается', () => {
    expect(decide({ warmedAt: now - 20 * MIN })).toBe('resume');
  });

  it('пинг старше последней записи сессии ничего не меняет', () => {
    expect(decide({ warmedAt: now - 80 * MIN })).toBe('fresh');
  });

  it('ожидание лимита, согретое пингом, — не «остыл при любом простое»', () => {
    expect(decide({ afterLimit: true })).toBe('fresh');
    expect(decide({ afterLimit: true, warmedAt: now - 20 * MIN })).toBe('resume');
  });
});
