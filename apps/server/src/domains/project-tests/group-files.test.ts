import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  SECTION_SPLIT_THRESHOLD,
  listGroupIds,
  readGroupSource,
  removeGroupFiles,
  writeGroupSource,
} from './group-files.ts';
import { readGroup, readGroups } from './store.ts';

/**
 * Раскладка большой группы по секциям. Главное здесь — не сама раскладка, а
 * то, что она НЕ ВИДНА снаружи: вкладка остаётся одна, а маленький набор лежит
 * ровно так же, как его писала прошлая версия панели.
 */
function dir(root: string): string {
  return join(root, '.agent', 'tests');
}

function write(root: string, name: string, body: unknown): void {
  mkdirSync(dir(root), { recursive: true });
  writeFileSync(
    join(dir(root), name),
    typeof body === 'string' ? body : JSON.stringify(body, null, 2),
  );
}

function read(root: string, name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(dir(root), name), 'utf8')) as Record<string, unknown>;
}

/** Набор кейсов, разложенный по секциям по кругу. */
function manyCases(count: number, sections: string[]): unknown[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `gui-${String(index + 1).padStart(3, '0')}`,
    title: `Кейс ${index + 1}`,
    section: sections[index % sections.length],
  }));
}

describe('project-tests group-files', () => {
  let root = '';

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-groupfiles-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('небольшая группа лежит одним файлом прежней формы', () => {
    writeGroupSource(root, 'gui', { title: 'GUI', cases: manyCases(10, ['Чат', 'Аналитика']) });

    const file = read(root, 'gui.tests.json');

    // Ключа `parts` в обычном файле быть не должно: проект, записанный прошлой
    // версией, обязан открываться и читаться неизменным.
    expect(Object.keys(file)).toEqual(['version', 'title', 'cases']);
    expect((file.cases as unknown[]).length).toBe(10);
    expect(readGroup(root, 'gui').cases).toHaveLength(10);
  });

  it('большая группа разъезжается по секциям, а читается как одна', () => {
    const cases = manyCases(SECTION_SPLIT_THRESHOLD + 30, ['Чат', 'Аналитика', 'Настройки']);
    writeGroupSource(root, 'gui', { title: 'GUI', cases });

    const index = read(root, 'gui.tests.json');
    const group = readGroup(root, 'gui');

    expect((index.parts as unknown[]).length).toBe(3);
    expect(index.cases).toEqual([]);
    expect(group.cases).toHaveLength(cases.length);
    expect(group.files).toHaveLength(4);
    // Части — не отдельные вкладки: снаружи группа по-прежнему одна.
    expect(listGroupIds(root)).toEqual(['gui']);
    expect(readGroups(root)).toHaveLength(1);
    expect(existsSync(join(dir(root), 'gui--chat.tests.json'))).toBe(false);
  });

  it('кейсы без секции остаются в индексе — потерять кейс нельзя', () => {
    const cases = [
      ...manyCases(SECTION_SPLIT_THRESHOLD + 10, ['Чат', 'Аналитика']),
      { id: 'gui-999', title: 'Ничей кейс' },
    ];
    writeGroupSource(root, 'gui', { cases });

    const index = read(root, 'gui.tests.json');

    expect((index.cases as { id: string }[]).map((item) => item.id)).toEqual(['gui-999']);
    expect(readGroup(root, 'gui').cases).toHaveLength(cases.length);
  });

  it('одна секция на весь набор — резать нечего, файл остаётся один', () => {
    writeGroupSource(root, 'gui', { cases: manyCases(SECTION_SPLIT_THRESHOLD + 5, ['Чат']) });

    expect(read(root, 'gui.tests.json').parts).toBeUndefined();
    expect(readGroup(root, 'gui').files).toBeUndefined();
  });

  it('набор усох — части исчезают, а кейсы возвращаются в один файл', () => {
    writeGroupSource(root, 'gui', {
      cases: manyCases(SECTION_SPLIT_THRESHOLD + 30, ['Чат', 'Аналитика']),
    });
    const parts = (read(root, 'gui.tests.json').parts as { id: string }[]).map((part) => part.id);

    writeGroupSource(root, 'gui', { cases: manyCases(5, ['Чат', 'Аналитика']) });

    expect(read(root, 'gui.tests.json').parts).toBeUndefined();
    for (const id of parts) expect(existsSync(join(dir(root), `${id}.tests.json`))).toBe(false);
    expect(readGroup(root, 'gui').cases).toHaveLength(5);
  });

  it('сломанная часть гасит СВОЮ группу с причиной и остаётся на диске', () => {
    writeGroupSource(root, 'gui', {
      cases: manyCases(SECTION_SPLIT_THRESHOLD + 30, ['Чат', 'Аналитика']),
    });
    const part = (read(root, 'gui.tests.json').parts as { id: string }[])[0]!.id;
    write(root, `${part}.tests.json`, '{ сломано');

    const group = readGroup(root, 'gui');

    expect(group.error).toContain(part);
    expect(group.cases).toEqual([]);
    expect(readFileSync(join(dir(root), `${part}.tests.json`), 'utf8')).toBe('{ сломано');
  });

  it('файл, написанный прошлой версией, читается как был', () => {
    write(root, 'gui.tests.json', {
      version: 1,
      title: 'GUI',
      cases: [{ id: 'gui-001', title: 'Старый кейс', steps: 'зайти\nнажать' }],
    });

    const source = readGroupSource(root, 'gui');

    expect(source.title).toBe('GUI');
    expect(source.cases).toHaveLength(1);
    expect(source.files).toEqual(['.agent/tests/gui.tests.json']);
  });

  it('удаление группы уносит и её части', () => {
    writeGroupSource(root, 'gui', {
      cases: manyCases(SECTION_SPLIT_THRESHOLD + 30, ['Чат', 'Аналитика']),
    });
    const parts = (read(root, 'gui.tests.json').parts as { id: string }[]).map((part) => part.id);

    removeGroupFiles(root, 'gui');

    expect(existsSync(join(dir(root), 'gui.tests.json'))).toBe(false);
    for (const id of parts) expect(existsSync(join(dir(root), `${id}.tests.json`))).toBe(false);
  });

  it('осиротевшая часть не превращается во вкладку — она помечена своей группой', () => {
    write(root, 'gui--chat.tests.json', {
      version: 1,
      group: 'gui',
      section: 'Чат',
      cases: [{ id: 'gui-001', title: 'Кейс' }],
    });

    expect(listGroupIds(root)).toEqual([]);
  });
});
