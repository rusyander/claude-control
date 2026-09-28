import { describe, it, expect } from 'vitest';
import type { ProjectTestCaseResultEntry } from '@agentdeck/contracts';
import { caseRunSearch, flakyIndex, reasonOf } from './caseResults';

const entry = (patch: Partial<ProjectTestCaseResultEntry>): ProjectTestCaseResultEntry => ({
  runId: 'r1',
  startedAt: '2026-09-20T10:00:00.000Z',
  mode: 'run',
  actor: 'agent',
  status: 'failed',
  points: 1,
  ...patch,
});

/**
 * Строка причины в истории кейса: одна строка, по которой видно, ЧТО
 * сломалось, — без неё история отвечает только «когда красное».
 */
describe('reasonOf', () => {
  it('разобранный провал — шаг и что вышло', () => {
    expect(
      reasonOf(entry({ failure: { step: 3, actual: 'Кнопка не видна' }, note: 'длинная заметка' })),
    ).toEqual({ step: 3, text: 'Кнопка не видна' });
  });

  it('без разбора — первая непустая строка заметки', () => {
    expect(reasonOf(entry({ note: '\n  Таймаут входа  \nстек…' }))).toEqual({
      step: undefined,
      text: 'Таймаут входа',
    });
  });

  it('у пройденного причины нет, даже если заметка есть', () => {
    expect(reasonOf(entry({ status: 'passed', note: 'всё ок' }))).toBeUndefined();
  });

  it('провал без заметки и разбора — причины нет, а не пустая строка', () => {
    expect(reasonOf(entry({}))).toBeUndefined();
  });

  it('порядок общий с выгрузкой: без «что вышло» — заметка с номером шага; шаг без текста — ничего', () => {
    expect(reasonOf(entry({ failure: { step: 2 }, note: 'Стенд 2' }))).toEqual({
      step: 2,
      text: 'Стенд 2',
    });
    expect(reasonOf(entry({ failure: { step: 2, actual: '  ' } }))).toBeUndefined();
  });

  it('блокировка тоже объясняется', () => {
    expect(reasonOf(entry({ status: 'blocked', note: 'Стенд лежит' }))?.text).toBe('Стенд лежит');
  });
});

/**
 * Отметки нестабильности адресуются «группа:кейс» — тем же ключом, что строка
 * таблицы: один id кейса встречается в двух группах, и отметка одной не должна
 * красить другую.
 */
describe('flakyIndex', () => {
  it('ключ — группа и кейс; одинаковый id в другой группе не задет', () => {
    const index = flakyIndex({
      window: 10,
      minFlips: 2,
      cases: [{ groupId: 'gui', caseId: 'a', isFlaky: true, flips: 3, runs: 5 }],
    });
    expect(index.get('gui:a')?.flips).toBe(3);
    expect(index.has('e2e:a')).toBe(false);
  });

  it('нет данных — пустой индекс', () => {
    expect(flakyIndex(undefined).size).toBe(0);
  });
});

/**
 * Ссылка «Открыть прогон» из истории кейса. Карточка кейса живёт и в окне
 * тестов чата, где проект — каталог чата, а раздел «Тестирование» помнит свой:
 * без проекта в ссылке раздел открывал чужую историю прогонов и молчал.
 */
describe('caseRunSearch', () => {
  it('несёт вкладку, прогон и проект', () => {
    expect(caseRunSearch('C:/work/app', 'run-7')).toEqual({
      tab: 'runs',
      run: 'run-7',
      project: 'C:/work/app',
    });
  });

  it('без проекта — без пустого параметра', () => {
    expect(caseRunSearch(undefined, 'run-7')).toEqual({ tab: 'runs', run: 'run-7' });
  });
});
