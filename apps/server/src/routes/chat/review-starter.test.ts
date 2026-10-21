import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resumableSession, sessionWarmth } from './review-starter.ts';

/**
 * Какую сессию группы продолжать (вопрос ревью Q2): файл транскрипта удалён
 * мимо панели — `--resume` по нему падал «No conversation found», и группа
 * «падала» на каждом нажатии. Папка `projects/` — настоящая, во временном каталоге.
 */
describe('resumableSession', () => {
  let dir = '';
  const session = (id: string, at: number): void => {
    mkdirSync(join(dir, 'C--copy'), { recursive: true });
    const file = join(dir, 'C--copy', `${id}.jsonl`);
    writeFileSync(file, '{}\n', 'utf8');
    utimesSync(file, at, at);
  };
  const fresh = (): void => {
    dir = mkdtempSync(join(tmpdir(), 'resumable-'));
  };
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('просимая сессия на диске — её и продолжаем', () => {
    fresh();
    session('s-old', 1_000);
    expect(resumableSession(dir, 's-old', ['s-old'])).toBe('s-old');
  });

  it('файла просимой нет — ничего: ход идёт новым разговором', () => {
    fresh();
    expect(resumableSession(dir, 's-lost', ['s-lost', 'new-1'])).toBeUndefined();
  });

  it('файла просимой нет, а у другого ключа того же разговора есть — продолжаем его', () => {
    fresh();
    session('s-next', 2_000);
    expect(resumableSession(dir, 's-lost', ['s-lost', 's-next'])).toBe('s-next');
  });

  it('файлы у двух ключей — свежайший; временный `new-…` не продолжается никогда', () => {
    fresh();
    session('s-old', 1_000);
    session('s-next', 2_000);
    session('new-1', 3_000);
    expect(resumableSession(dir, 's-old', ['s-old', 's-next', 'new-1'])).toBe('s-next');
  });
});

/**
 * Насколько остыл разговор группы (рычаг «новый разговор после долгой паузы»):
 * простой — по времени файла, окно — по последнему ответу модели в хвосте, а не
 * по первому попавшемуся: строки после ответа (итог инструмента) usage не несут.
 */
describe('sessionWarmth', () => {
  let dir = '';
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const usage = (input: number, read: number, write: number) =>
    JSON.stringify({
      type: 'assistant',
      message: {
        usage: {
          input_tokens: input,
          output_tokens: 50,
          cache_read_input_tokens: read,
          cache_creation_input_tokens: write,
        },
      },
    });

  it('окно — последний вызов, база — первый, простой — от времени файла', () => {
    dir = mkdtempSync(join(tmpdir(), 'warmth-'));
    mkdirSync(join(dir, 'C--copy'), { recursive: true });
    const file = join(dir, 'C--copy', 's-cold.jsonl');
    const lines = [usage(10, 20_000, 1_000), usage(5, 110_000, 3_000), '{"type":"user"}'];
    writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');
    utimesSync(file, 1_000, 1_000);

    expect(sessionWarmth(dir, 's-cold', 1_000_000 + 3_600_000)).toEqual({
      file,
      idleMs: 3_600_000,
      contextTokens: 113_005,
      freshBase: 21_010,
    });
  });

  it('нет файла — нечего мерить; нет ответа модели — окно 0, то есть «продолжаем»', () => {
    dir = mkdtempSync(join(tmpdir(), 'warmth-'));
    expect(sessionWarmth(dir, 's-none', 0)).toBeUndefined();
    mkdirSync(join(dir, 'C--copy'), { recursive: true });
    writeFileSync(join(dir, 'C--copy', 's-empty.jsonl'), '{"type":"user"}\n', 'utf8');
    expect(sessionWarmth(dir, 's-empty', Date.now())?.contextTokens).toBe(0);
  });
});
