import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  OWNER_REQUEST_END,
  OWNER_REQUEST_HEADER,
  ownerCoverageLine,
} from '@agentdeck/contracts/quality-floor';
import { OWNER_BRIEF, ownerBlockOf, writeOwnerBrief } from './owner-brief.ts';

/**
 * Слова владельца файлом в копии (живая группа 26.10): после сжатия группа
 * искала просьбу и номера `owner-N` в своём транскрипте. Проверяется файл на
 * настоящем диске — его и читает группа.
 */
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function copy(): string {
  const root = mkdtempSync(join(tmpdir(), 'owner-brief-'));
  roots.push(root);
  return root;
}

const OWNER = 'Доска PROJ: возьми фронтовые задачи, глубокое ревью, MR без мержа.';
// Блок слов владельца в том виде, в каком его писало старое разделение панели
// (уехало в ядро, этап 10): старые задания читаются как прежде.
const ownerBlock = (words: string): string =>
  [
    OWNER_REQUEST_HEADER,
    `[owner message 1 of 1]\n\n${words}`,
    OWNER_REQUEST_END,
    ownerCoverageLine(),
  ].join('\n\n');
const task = (words = OWNER): string =>
  `${ownerBlock(words)}\n\nДобавка разделяющего агента.\n\nЗадачи группы:\n- PROJ-1`;

describe('файл слов владельца в копии', () => {
  it('держит дословную просьбу, формат строк owner-N и без добавки разделяющего агента', () => {
    const cwd = copy();
    expect(writeOwnerBrief(cwd, { task: task(), group: 'Доки' })).toBe(OWNER_BRIEF);
    const text = readFileSync(join(cwd, OWNER_BRIEF), 'utf8');
    expect(text).toContain(OWNER);
    expect(text).toContain('"id":"owner-1"');
    expect(text).toContain('Requirement trace');
    expect(text).not.toContain('Задачи группы');
    // Папка прячет себя от git сама — доставка `git add -A` файл не захватит.
    expect(readFileSync(join(cwd, '.agent/run/.gitignore'), 'utf8')).toBe('*\n');
  });

  it('несёт сданные строки и сита звена; повтор переписывает раздел своей группы', () => {
    const cwd = copy();
    writeOwnerBrief(cwd, {
      task: task(),
      group: 'Доки',
      rows: [{ id: 'owner-1', status: 'pass', evidence: 'x'.repeat(400) }],
    });
    // Доказательство — коротко: номер и статус, а не пересказ на 400 знаков.
    const long = readFileSync(join(cwd, OWNER_BRIEF), 'utf8');
    expect(long).toContain(`- owner-1 pass — ${'x'.repeat(159)}…`);
    expect(long).not.toContain('x'.repeat(160));
    writeOwnerBrief(cwd, {
      task: task(),
      group: 'Доки',
      rows: [
        { id: 'owner-1', status: 'pass', evidence: 'npx vitest → 78 passed' },
        { id: 'owner-2', status: 'n/a', evidence: 'other group: API' },
      ],
      sieves: '1. [browser-focus] проверить фокус',
    });
    const text = readFileSync(join(cwd, OWNER_BRIEF), 'utf8');
    expect(text).toContain('- owner-1 pass — npx vitest → 78 passed');
    expect(text).toContain('- owner-2 n/a — other group: API');
    expect(text).toContain('[browser-focus]');
    expect(text).not.toContain('x'.repeat(200));
    expect(text.match(/## Rows already reported/g)).toHaveLength(1);
  });

  it('разделы другой группы той же просьбы остаются, другой просьбы — уходят', () => {
    const cwd = copy();
    const row = (id: string) => [{ id, status: 'pass' as const, evidence: 'ok' }];
    writeOwnerBrief(cwd, { task: task(), group: 'Первая', rows: row('owner-1') });
    writeOwnerBrief(cwd, { task: task(), group: 'Вторая', rows: row('owner-2') });
    let text = readFileSync(join(cwd, OWNER_BRIEF), 'utf8');
    expect(text).toContain('## Rows already reported — Первая');
    expect(text).toContain('## Rows already reported — Вторая');

    writeOwnerBrief(cwd, { task: task('Другая просьба'), group: 'Вторая', rows: row('owner-3') });
    text = readFileSync(join(cwd, OWNER_BRIEF), 'utf8');
    expect(text).not.toContain('— Первая');
    expect(text).not.toContain(OWNER);
    expect(text).toContain('- owner-3 pass');
  });

  it('перезапуск группы (старт без строк) сданные строки не стирает', () => {
    const cwd = copy();
    const rows = [{ id: 'owner-1', status: 'pass' as const, evidence: 'ok' }];
    writeOwnerBrief(cwd, { task: task(), group: 'Доки', rows });
    writeOwnerBrief(cwd, { task: task(), group: 'Доки', keepOwn: true });
    expect(readFileSync(join(cwd, OWNER_BRIEF), 'utf8')).toContain('- owner-1 pass — ok');
    writeOwnerBrief(cwd, { task: task(), group: 'Доки' });
    expect(readFileSync(join(cwd, OWNER_BRIEF), 'utf8')).not.toContain('owner-1 pass');
  });

  it('задание без слов владельца — файла нет', () => {
    const cwd = copy();
    expect(writeOwnerBrief(cwd, { task: 'Сделай PROJ-1', group: 'Доки' })).toBeUndefined();
    expect(existsSync(join(cwd, OWNER_BRIEF))).toBe(false);
    expect(ownerBlockOf(undefined)).toBeUndefined();
  });
});
