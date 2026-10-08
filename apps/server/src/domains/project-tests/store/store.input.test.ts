import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ProjectTestCaseInput } from '@agentdeck/contracts';
import { ProjectTestsError, createGroup, readGroups, upsertCase } from './store.ts';

/**
 * Сохранение кейса из панели (форма, телефон, API) — строгий вход.
 *
 * Найдено живой проверкой 26.09: `POST /case` с `priority:"urgent"` отвечал 200,
 * слово ложилось в файл, а при чтении молча пропадало — клиент думал, что
 * сохранил, а поля не было. Ссылка «не адрес вовсе» и `javascript:` сохранялись
 * как есть и становились строкой матрицы покрытия. Файлы агента по-прежнему
 * читаются снисходительно (`parseLinks`, `oneOf`) — строгость только у входа панели.
 */
const NOW = '2026-09-26T10:00:00.000Z';

describe('upsertCase: строгий вход панели', () => {
  let root = '';
  const file = (): string => readFileSync(join(root, '.agent', 'tests', 'gui.tests.json'), 'utf8');
  const save = (patch: Partial<ProjectTestCaseInput>): void => {
    upsertCase(root, 'gui', { id: 'gui-001', title: 'Вход', ...patch }, NOW);
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-tests-input-'));
    createGroup(root, 'gui');
    upsertCase(
      root,
      'gui',
      { title: 'Вход', steps: ['открыть'], priority: 'high', duration: 5 },
      NOW,
    );
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('слово вне словаря — отказ с перечнем допустимых, файл не тронут', () => {
    const before = file();
    expect(() => save({ priority: 'urgent' as 'high' })).toThrow(/urgent.*|допустимо/);
    expect(() => save({ readiness: 'done' as 'ready' })).toThrow(/done/);
    expect(() => save({ type: 'story' as 'case' })).toThrow(/story/);
    expect(() => save({ automation: { status: 'robot' as 'manual' } })).toThrow(/robot/);
    expect(() => save({ priority: 'urgent' as 'high' })).toThrow(ProjectTestsError);
    expect(file()).toBe(before);
  });

  it('ссылка без адреса http(s) отклоняется с названием ссылки', () => {
    const before = file();
    expect(() => save({ links: [{ type: 'requirement', url: 'не адрес вовсе' }] })).toThrow(
      /не адрес вовсе.*http/,
    );
    expect(() => save({ links: [{ type: 'doc', url: 'javascript:alert(1)' }] })).toThrow(
      /javascript/,
    );
    expect(() =>
      save({ links: [{ type: 'wiki' as 'doc', url: 'https://example.com/a' }] }),
    ).toThrow(/wiki/);
    expect(file()).toBe(before);

    save({ links: [{ type: 'requirement', url: 'https://tracker.example.com/browse/PROJ-1' }] });
    expect(readGroups(root)[0]?.cases[0]?.links).toEqual([
      { type: 'requirement', url: 'https://tracker.example.com/browse/PROJ-1' },
    ]);
  });

  it('длительность — целые минуты в разумных пределах; 0 очищает поле', () => {
    const before = file();
    expect(() => save({ duration: -5 })).toThrow(/-5/);
    expect(() => save({ duration: 1e9 })).toThrow(/1000000000/);
    expect(() => save({ duration: 2.5 })).toThrow(/2\.5/);
    expect(file()).toBe(before);

    save({ duration: 30 });
    expect(readGroups(root)[0]?.cases[0]?.duration).toBe(30);
    save({ duration: 0 });
    expect(readGroups(root)[0]?.cases[0]?.duration).toBeUndefined();
  });

  // Ревью 26.09: файл агента или CSV несут «REQ-12» и длительность 2000 —
  // чтение их принимает, форма шлёт ссылки обратно при ЛЮБОЙ правке, и правка
  // заголовка отказывала за ссылку, которую человек не трогал.
  it('ссылка и длительность, уже лежащие в файле, правке не мешают; новая плохая — отказ', () => {
    const path = join(root, '.agent', 'tests', 'gui.tests.json');
    const stored = JSON.parse(file()) as { cases: Array<Record<string, unknown>> };
    stored.cases[0]!.links = [{ type: 'requirement', url: 'REQ-12' }];
    stored.cases[0]!.duration = 2000;
    writeFileSync(path, JSON.stringify(stored, null, 2));
    const kept = readGroups(root)[0]?.cases[0];
    expect(kept?.links?.[0]?.url).toBe('REQ-12');

    save({ title: 'Вход по паролю', links: kept?.links, duration: kept?.duration });
    expect(readGroups(root)[0]?.cases[0]?.title).toBe('Вход по паролю');

    expect(() =>
      save({ links: [...(kept?.links ?? []), { type: 'requirement', url: 'REQ-13' }] }),
    ).toThrow(/REQ-13/);
    expect(() => save({ duration: 2001 })).toThrow(/2001/);
  });

  // F-162: сохранённый адрес прощал и смену типа — мусорный тип уходил в файл.
  it('смена типа у сохранённого адреса проверяется, сам адрес — нет', () => {
    const path = join(root, '.agent', 'tests', 'gui.tests.json');
    const stored = JSON.parse(file()) as { cases: Array<Record<string, unknown>> };
    stored.cases[0]!.links = [{ type: 'requirement', url: 'REQ-12' }];
    writeFileSync(path, JSON.stringify(stored, null, 2));

    expect(() => save({ links: [{ type: 'foo', url: 'REQ-12' } as never] })).toThrow(/foo/);
    save({ links: [{ type: 'issue', url: 'REQ-12' }] });
    expect(readGroups(root)[0]?.cases[0]?.links).toEqual([{ type: 'issue', url: 'REQ-12' }]);
  });

  it('поле, которого нет в запросе, остаётся с диска', () => {
    save({});
    const [item] = readGroups(root)[0]?.cases ?? [];
    expect(item?.priority).toBe('high');
    expect(item?.duration).toBe(5);
  });
});
