import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resumableSession } from './review-starter.ts';

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
