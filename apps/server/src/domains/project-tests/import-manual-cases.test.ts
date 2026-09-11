import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createGroup, readGroup } from './store.ts';
import { importManualCases, parseManualCase } from './import-manual-cases.ts';

/**
 * Ручные кейсы из репозитория. Проверяется то, ради чего импорт и написан:
 * номер из имени файла остаётся номером кейса, повторный импорт правит тот же
 * кейс, а написанное человеком не пропадает, даже если раздел незнакомый.
 */

let project = '';

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), 'cc-manual-'));
  createGroup(project, 'manual', 'Ручные');
});
afterEach(() => {
  rmSync(project, { recursive: true, force: true });
});

const NOW = '2026-09-10T10:00:00.000Z';

const CASE_MD = `# ТК-012. Вход по одноразовому коду

**Зона:** авторизация
**Приоритет:** высокий
**Теги:** смоук, вход

## Предусловие

Пользователь зарегистрирован

## Шаги

1. Открыть форму входа
   - Ожидание: форма открыта
2. Ввести телефон
   - Данные: 79990000000

## Ожидаемый результат

Пользователь внутри
`;

function write(relative: string, text: string): void {
  const path = join(project, relative);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text, 'utf8');
}

describe('project-tests/import-manual-cases: разбор одного файла', () => {
  it('заголовок, поля преамбулы и шаги с подстрочниками', () => {
    const row = parseManualCase(CASE_MD, 'ТК-012');

    expect(row).toMatchObject({
      id: 'ТК-012',
      title: 'Вход по одноразовому коду',
      area: 'авторизация',
      priority: 'high',
      precondition: 'Пользователь зарегистрирован',
      expected: 'Пользователь внутри',
      tags: ['смоук', 'вход'],
    });
    expect(row?.steps).toEqual([
      { action: 'Открыть форму входа', expected: 'форма открыта' },
      { action: 'Ввести телефон', data: '79990000000' },
    ]);
  });

  it('шаги таблицей — тот же результат: люди пишут и так, и так', () => {
    const row = parseManualCase(
      [
        '# ТК-1 Оплата',
        '## Шаги',
        '| № | Действие | Ожидание |',
        '|---|---|---|',
        '| 1 | Нажать «Оплатить» | Открылась касса |',
      ].join('\n'),
      'ТК-1',
    );

    expect(row?.steps).toEqual([{ action: 'Нажать «Оплатить»', expected: 'Открылась касса' }]);
  });

  it('незнакомый раздел не выбрасывается — он уходит в цель вместе с заголовком', () => {
    const row = parseManualCase(
      ['# ТК-3 Отчёт', '## Риски', 'Данные за прошлый год могут быть неполными'].join('\n'),
      'ТК-3',
    );

    expect(row?.purpose).toBe('Риски:\nДанные за прошлый год могут быть неполными');
  });

  it('файл без заголовка первого уровня — не кейс: названия у него нет', () => {
    expect(parseManualCase('Просто текст без заголовка', 'ТК-9')).toBeUndefined();
  });
});

describe('project-tests/import-manual-cases: импорт каталога', () => {
  it('номер из имени файла становится номером кейса, папка — разделом', () => {
    write('QA/auth/ТК-012.md', CASE_MD);

    const result = importManualCases(project, { groupId: 'manual', now: NOW });
    expect(result).toMatchObject({ format: 'markdown', read: 1, created: 1, matched: 0 });

    const stored = readGroup(project, 'manual').cases[0]!;
    expect(stored.id).toBe('ТК-012');
    expect(stored.section).toBe('auth');
    expect(stored.title).toBe('Вход по одноразовому коду');
    // Кейс писал человек — агенту такие удалять запрещено.
    expect(stored.source).toBe('human');
  });

  it('повторный импорт правит тот же кейс, а не заводит второй', () => {
    write('QA/ТК-012.md', CASE_MD);
    importManualCases(project, { groupId: 'manual', now: NOW });

    write('QA/ТК-012.md', CASE_MD.replace('Вход по одноразовому коду', 'Вход по коду из СМС'));
    const again = importManualCases(project, { groupId: 'manual', now: NOW });

    expect(again).toMatchObject({ read: 1, matched: 1, created: 0 });
    const cases = readGroup(project, 'manual').cases;
    expect(cases).toHaveLength(1);
    expect(cases[0]?.id).toBe('ТК-012');
    expect(cases[0]?.title).toBe('Вход по коду из СМС');
  });

  it('латинская раскладка имени файла тоже читается', () => {
    write('QA/TK-7.md', '# TK-7 Выход\n## Шаги\n1. Нажать «Выйти»\n');

    importManualCases(project, { groupId: 'manual', now: NOW });
    expect(readGroup(project, 'manual').cases[0]?.id).toBe('TK-7');
  });

  it('каталога нет — отказ называет каталог, а не падает 500', () => {
    expect(() => importManualCases(project, { groupId: 'manual', dir: 'нетути' })).toThrow(
      /нетути/,
    );
  });

  it('каталог есть, файлов нет — сказано, что именно искали', () => {
    mkdirSync(join(project, 'QA'), { recursive: true });
    writeFileSync(join(project, 'QA/readme.md'), 'не кейс', 'utf8');

    expect(() => importManualCases(project, { groupId: 'manual' })).toThrow(/ТК-\*\.md/);
  });

  it('каталог за пределами проекта не читается', () => {
    expect(() => importManualCases(project, { groupId: 'manual', dir: '../..' })).toThrow();
  });
});

/**
 * Находки враждебного ревью Т9 (10.09.2026). Каждый вход здесь — тот самый, на
 * котором ревьюер сломал импорт, а не облегчённый пересказ.
 */
describe('project-tests/import-manual-cases: находки ревью Т9', () => {
  it('два файла с одним номером НЕ затирают друг друга — второй назван', () => {
    write('QA/auth/ТК-1.md', '# ТК-1. Вход\n\n## Шаги\n\n1. Открыть форму\n');
    write('QA/billing/ТК-1.md', '# ТК-1. Оплата\n\n## Шаги\n\n1. Открыть кассу\n');

    const first = importManualCases(project, { groupId: 'manual', now: NOW });
    // Номер занят первым файлом; второй не получает придуманный номер молча.
    expect(first.created).toBe(1);
    expect(first.unmatched).toHaveLength(1);

    // Ровно здесь и терялся кейс: раньше ВТОРОЙ импорт находил по номеру один и
    // тот же кейс для обеих строк, и «Вход» переставал существовать вовсе.
    const second = importManualCases(project, { groupId: 'manual', now: NOW });
    expect(second.created).toBe(0);
    const titles = readGroup(project, 'manual').cases.map((item) => item.title);
    expect(titles).toContain('Вход');
    expect(readGroup(project, 'manual').cases).toHaveLength(1);
  });

  it('одинаковый заголовок не съедает отдельный номер', () => {
    write('QA/ТК-10.md', '# Вход в систему\n\n## Шаги\n\n1. Открыть форму\n');
    write('QA/ТК-11.md', '# Вход в систему\n\n## Шаги\n\n1. Открыть форму\n');

    importManualCases(project, { groupId: 'manual', now: NOW });
    const ids = readGroup(project, 'manual')
      .cases.map((item) => item.id)
      .sort();
    // Раньше совпадение по названию перебивало живой свободный номер, и ТК-11
    // не появлялся никогда — при том что номером кейс зовут в дефекте и в MR.
    expect(ids).toEqual(['ТК-10', 'ТК-11']);
  });

  it('строка таблицы без закрывающей трубы не уносит предыдущие шаги', () => {
    const row = parseManualCase(
      [
        '# ТК-2. Оплата',
        '',
        '## Шаги',
        '',
        '| № | Действие | Ожидание |',
        '|---|---|---|',
        '| 1 | Открыть кассу | Касса открыта |',
        '| 2 | Ввести карту',
        '| 3 | Нажать «Оплатить» | Успех |',
      ].join('\n'),
      'ТК-2',
    );
    // Раньше строка без трубы опознавалась как РАЗМЕТКА: и сама пропадала, и
    // забирала с собой шаг выше — из трёх шагов оставался один.
    expect(row?.steps).toHaveLength(3);
    expect(row?.steps?.[1]).toMatchObject({ action: 'Ввести карту' });
    expect(row?.steps?.[0]).toMatchObject({ action: 'Открыть кассу', expected: 'Касса открыта' });
  });

  it('пустая ячейка не сдвигает колонки: данные не становятся ожиданием', () => {
    const row = parseManualCase(
      [
        '# ТК-3. Касса',
        '',
        '## Шаги',
        '',
        '| № | Действие | Ожидание | Данные |',
        '|---|---|---|---|',
        '| 1 | Открыть кассу |  | карта |',
      ].join('\n'),
      'ТК-3',
    );
    expect(row?.steps?.[0]).toMatchObject({ action: 'Открыть кассу', data: 'карта' });
    expect(row?.steps?.[0]?.expected ?? '').toBe('');
  });

  it('таблица без разделителя: шапка не становится шагом', () => {
    const row = parseManualCase(
      [
        '# ТК-4. Вход',
        '',
        '## Шаги',
        '',
        '| № | Действие | Ожидание |',
        '| 1 | Открыть | Открыто |',
      ].join('\n'),
      'ТК-4',
    );
    expect(row?.steps).toHaveLength(1);
    expect(row?.steps?.[0]).toMatchObject({ action: 'Открыть', expected: 'Открыто' });
  });

  it('таблица без внешних труб разбирается, а разделитель не становится шагом', () => {
    const row = parseManualCase(
      [
        '# ТК-5. Вход',
        '',
        '## Шаги',
        '',
        '№ | Действие | Ожидание',
        '---|---|---',
        '1 | Открыть кассу | Касса открыта',
      ].join('\n'),
      'ТК-5',
    );
    expect(row?.steps).toEqual([{ action: 'Открыть кассу', expected: 'Касса открыта' }]);
  });

  it('вложенный пункт остаётся частью шага и не крадёт его ожидание', () => {
    const row = parseManualCase(
      [
        '# ТК-6. Вход',
        '',
        '## Шаги',
        '',
        '1. Открыть форму',
        '   - ввести логин',
        '   - Ожидание: форма открыта',
      ].join('\n'),
      'ТК-6',
    );
    // Раньше «ввести логин» становилось отдельным шагом и забирало ожидание,
    // предназначенное первому.
    expect(row?.steps).toHaveLength(1);
    expect(row?.steps?.[0]).toMatchObject({
      action: 'Открыть форму · ввести логин',
      expected: 'форма открыта',
    });
  });

  it('номер берётся из начала длинного имени файла, а не теряется', () => {
    write('QA/ТК-042-вход-по-одноразовому-коду-при-истёкшей-сессии.md', '# ТК-042. Вход\n');
    write('QA/ТК-900 (копия).md', '# ТК-900. Выход\n');
    write('QA/ТК-901.v2.md', '# ТК-901. Сброс\n');

    importManualCases(project, { groupId: 'manual', now: NOW });
    const cases = readGroup(project, 'manual').cases;
    expect(cases.map((item) => item.id).sort()).toEqual(['ТК-042', 'ТК-900', 'ТК-901']);
    // И номер не дублируется внутри названия: раньше `stripId` получал
    // придуманный `manual-001` и снять номер с заголовка не мог.
    expect(cases.map((item) => item.title).sort()).toEqual(['Вход', 'Выход', 'Сброс']);
  });
});
