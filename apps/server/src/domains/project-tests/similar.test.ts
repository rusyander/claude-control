import type { ProjectTestCase, ProjectTestGroup } from '@agentdeck/contracts';
import { describe, expect, it } from 'vitest';
import { SIMILAR_THRESHOLD, caseTokens, jaccard, similarCases, similarTo } from './similar.ts';

/**
 * Похожесть кейсов. Проверяется то, ради чего она вообще считается: настоящая
 * копия должна находиться, а соседний по теме кейс — нет. Ложный дубль здесь
 * дороже пропуска: после второго вранья список перестают читать.
 */

function testCase(
  id: string,
  title: string,
  steps: ProjectTestCase['steps'] = [],
  over: Partial<ProjectTestCase> = {},
): ProjectTestCase {
  return { id, type: 'case', title, steps, status: 'unknown', source: 'human', ...over };
}

function group(id: string, cases: ProjectTestCase[]): ProjectTestGroup {
  return { id, title: id.toUpperCase(), file: `.agent/tests/${id}.tests.json`, cases };
}

/** Настоящая пара дублей: тот же сценарий, пересказанный близкими словами. */
const emptyPassword = testCase('gui-001', 'Вход с пустым паролем', [
  { action: 'Открыть форму входа', expected: 'Поля логина и пароля пустые' },
  { action: 'Ввести логин, пароль оставить пустым', expected: 'Кнопка «Войти» неактивна' },
]);
const blankPassword = testCase('gui-014', 'Вход с пустым полем пароля', [
  { action: 'Открыть форму входа', expected: 'Видны поля логина и пароля' },
  { action: 'Ввести логин и оставить пароль пустым', expected: 'Кнопка «Войти» неактивна' },
]);

/** Сосед по теме: те же слова раздела, другой сценарий. */
const stopRun = testCase('gui-020', 'Остановка ответа агента', [
  { action: 'Открыть чат проекта', expected: 'Виден список сообщений' },
  { action: 'Нажать «Стоп» во время ответа', expected: 'Ответ прерван' },
]);

describe('project-tests/similar: слова кейса', () => {
  it('служебные слова и знаки препинания в счёт не идут', () => {
    const tokens = caseTokens(testCase('gui-001', 'Вход в панель, а не в чат!'));
    expect([...tokens].sort()).toEqual(['вход', 'панель', 'чат']);
  });

  it('имя параметра выбрасывается: %login и %user — одно и то же место подстановки', () => {
    const first = caseTokens(testCase('gui-001', 'Вход с %login'));
    const second = caseTokens(testCase('gui-002', 'Вход с %user'));
    expect([...first]).toEqual(['вход']);
    expect([...second]).toEqual(['вход']);
  });

  it('«ё» и «е» пишут вперемешку, и словом это считается одним', () => {
    expect([...caseTokens(testCase('gui-001', 'Всё меню'))]).toEqual([
      ...caseTokens(testCase('gui-002', 'Все меню')),
    ]);
  });

  it('подписи шага «данные» и «ожидание» словами кейса не считаются', () => {
    const tokens = caseTokens(
      testCase('gui-001', 'Оплата', [{ action: 'Оплатить', data: 'карта', expected: 'списано' }]),
    );
    expect(tokens.has('данные')).toBe(false);
    expect(tokens.has('ожидание')).toBe(false);
    expect(tokens.has('карта')).toBe(true);
  });
});

describe('project-tests/similar: мера Жаккара', () => {
  it('общие слова делятся на объединение', () => {
    expect(jaccard(new Set(['вход', 'пароль']), new Set(['вход', 'пароль']))).toBe(1);
    expect(jaccard(new Set(['вход', 'пароль']), new Set(['вход', 'логин']))).toBe(0.33);
    expect(jaccard(new Set(['вход']), new Set(['выход']))).toBe(0);
  });

  it('пустое множество ни на что не похоже, а не похоже на всё', () => {
    expect(jaccard(new Set(), new Set())).toBe(0);
    expect(jaccard(new Set(), new Set(['вход']))).toBe(0);
  });
});

describe('project-tests/similar: дубли библиотеки', () => {
  it('настоящая пара находится с обеих сторон и с одинаковым счётом', () => {
    const duplicates = similarCases([group('gui', [emptyPassword, blankPassword])]);

    expect(duplicates.map((item) => item.caseId)).toEqual(['gui-001', 'gui-014']);
    expect(duplicates[0]?.similar[0]?.caseId).toBe('gui-014');
    expect(duplicates[1]?.similar[0]?.caseId).toBe('gui-001');
    expect(duplicates[0]?.similar[0]?.score).toBe(duplicates[1]?.similar[0]?.score);
    expect(duplicates[0]?.similar[0]?.score).toBeGreaterThanOrEqual(SIMILAR_THRESHOLD);
  });

  it('соседний по теме кейс дублем не считается', () => {
    const chat = testCase('gui-021', 'Отправка сообщения в чате', [
      { action: 'Открыть чат проекта', expected: 'Виден список сообщений' },
      { action: 'Ввести текст и нажать «Отправить»', expected: 'Сообщение появилось в списке' },
    ]);

    expect(similarCases([group('gui', [chat, stopRun])])).toEqual([]);
  });

  it('пара, у которой общие только служебные слова, не дубль', () => {
    const first = testCase('gui-030', 'Экспорт отчёта в PDF', [
      { action: 'Нажать «Скачать» и выбрать PDF' },
    ]);
    const second = testCase('gui-031', 'Импорт результатов из junit', [
      { action: 'Загрузить файл junit и применить' },
    ]);

    expect(jaccard(caseTokens(first), caseTokens(second))).toBe(0);
    expect(similarCases([group('gui', [first, second])])).toEqual([]);
  });

  it('одного общего слова мало: короткие кейсы с %параметром не сводятся в дубль', () => {
    const first = testCase('gui-040', 'Вход с %login');
    const second = testCase('gui-041', 'Вход с %user');

    // Слово осталось одно на оба кейса, и мера Жаккара честно даёт единицу —
    // от ложного дубля спасает требование двух общих слов, а не порог.
    expect(jaccard(caseTokens(first), caseTokens(second))).toBe(1);
    expect(similarCases([group('gui', [first, second])])).toEqual([]);
  });

  it('дубль ищется и в соседней группе: набор растёт вширь именно так', () => {
    const duplicates = similarCases([
      group('gui', [emptyPassword]),
      group('smoke', [{ ...blankPassword, id: 'smoke-002' }]),
    ]);

    expect(duplicates.map((item) => `${item.groupId}/${item.caseId}`)).toEqual([
      'gui/gui-001',
      'smoke/smoke-002',
    ]);
    expect(duplicates[0]?.similar[0]?.groupId).toBe('smoke');
  });

  it('сам с собой кейс не сравнивается', () => {
    expect(similarCases([group('gui', [emptyPassword])])).toEqual([]);
  });

  it('архивный кейс дублем не считается — ради этого архив и есть', () => {
    const archived = { ...blankPassword, archived: true };
    expect(similarCases([group('gui', [emptyPassword, archived])])).toEqual([]);
  });

  it('нечитаемая группа пропускается целиком', () => {
    const broken: ProjectTestGroup = {
      ...group('gui', [emptyPassword, blankPassword]),
      error: 'Файл не разобрался',
    };
    expect(similarCases([broken])).toEqual([]);
  });

  it('похожих на кейс показывается не больше трёх, лучшие сверху', () => {
    const copies = [0, 1, 2, 3, 4].map((index) =>
      testCase(`gui-10${index}`, `Вход с пустым паролем ${'очень '.repeat(index)}`, [
        { action: 'Открыть форму входа', expected: 'Поля логина и пароля пустые' },
        { action: 'Ввести логин, пароль оставить пустым', expected: 'Кнопка «Войти» неактивна' },
      ]),
    );

    const duplicates = similarCases([group('gui', copies)]);
    const scores = duplicates[0]?.similar.map((item) => item.score) ?? [];

    expect(scores).toHaveLength(3);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });

  it('порог настраивается: с низким соседи по теме уже сходятся', () => {
    const chat = testCase('gui-021', 'Отправка сообщения в чате', [
      { action: 'Открыть чат проекта', expected: 'Виден список сообщений' },
      { action: 'Ввести текст и нажать «Отправить»', expected: 'Сообщение появилось в списке' },
    ]);

    expect(similarCases([group('gui', [chat, stopRun])], { threshold: 0.3 })).toHaveLength(2);
  });

  it('пять сотен кейсов разбираются меньше чем за секунду', () => {
    const many = Array.from({ length: 500 }, (_, index) =>
      testCase(`gui-${index}`, `Проверка раздела номер ${index}`, [
        { action: `Открыть раздел ${index}`, expected: `Раздел ${index} открылся` },
        { action: 'Нажать «Обновить»', expected: 'Список перечитан' },
      ]),
    );

    const started = Date.now();
    similarCases([group('gui', many)]);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe('project-tests/similar: похожие на один кейс', () => {
  it('черновик находит своего близнеца в библиотеке', () => {
    const draft = testCase('gui-999', 'Вход с пустым полем пароля', blankPassword.steps);

    const found = similarTo(draft, [group('gui', [emptyPassword, stopRun])]);

    expect(found).toHaveLength(1);
    expect(found[0]?.caseId).toBe('gui-001');
    expect(found[0]?.title).toBe('Вход с пустым паролем');
    expect(found[0]?.score).toBeGreaterThanOrEqual(SIMILAR_THRESHOLD);
  });

  it('правка существующего кейса не находит саму себя', () => {
    const edited = { ...emptyPassword, title: 'Вход с пустым паролем (уточнено)' };

    expect(similarTo(edited, [group('gui', [emptyPassword])])).toEqual([]);
  });

  it('исключается ровно указанный кейс, остальные сравниваются', () => {
    const found = similarTo(blankPassword, [group('gui', [emptyPassword, blankPassword])], {
      excludeId: 'gui-014',
    });

    expect(found.map((item) => item.caseId)).toEqual(['gui-001']);
  });

  it('кейс без слов вовсе похожих не имеет', () => {
    expect(similarTo(testCase('gui-998', '   '), [group('gui', [emptyPassword])])).toEqual([]);
  });
});
