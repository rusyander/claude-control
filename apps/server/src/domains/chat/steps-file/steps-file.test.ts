import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSteps, readStepsFile } from './steps-file.ts';

/** Файл шагов `.agent/steps.json` в копии группы (решение владельца 29.09). */
describe('файл шагов', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('номер, всего и название — из файла, время — правки файла', () => {
    dir = mkdtempSync(join(tmpdir(), 'steps-file-'));
    mkdirSync(join(dir, '.agent'));
    writeFileSync(
      join(dir, '.agent', 'steps.json'),
      '\uFEFF{ "current": 8, "total": 14, "title": " Прогон тестов " }',
    );
    expect(readStepsFile(dir)).toEqual({
      current: 8,
      total: 14,
      title: 'Прогон тестов',
      updatedAt: expect.any(String),
    });
  });

  it('прежние имена полей `step` и `name` принимаются', () => {
    expect(parseSteps({ step: 2, total: 3, name: 'Ревью' })).toEqual({
      current: 2,
      total: 3,
      title: 'Ревью',
    });
  });

  it.each([
    ['номер больше всего', { current: 15, total: 14 }],
    ['ноль', { current: 0, total: 14 }],
    ['дробь', { current: 1.5, total: 14 }],
    ['строки', { current: '8', total: '14' }],
    ['без всего', { current: 8 }],
    ['массив', [8, 14]],
    ['тысячи шагов', { current: 1, total: 5000 }],
  ])('%s — шага нет', (_name, raw) => {
    expect(parseSteps(raw)).toBeUndefined();
  });

  it('файла нет, он битый или папки нет — шага нет', () => {
    dir = mkdtempSync(join(tmpdir(), 'steps-file-'));
    expect(readStepsFile(dir)).toBeUndefined();
    expect(readStepsFile(undefined)).toBeUndefined();
    mkdirSync(join(dir, '.agent'));
    writeFileSync(join(dir, '.agent', 'steps.json'), '{ "current": 8,');
    expect(readStepsFile(dir)).toBeUndefined();
  });
});
