import { describe, expect, it } from 'vitest';
import { assistHistory } from './assistant-history';
import { groupMisses } from './groupMisses';
import { keptSecretMisses } from './keptSecretMisses';

/**
 * Окно помощника без сессии (лёгкое окно, D4 28.09): разговор продолжается
 * прежними репликами в теле запроса, а поле, где модель испортила маску
 * секрета, называется человеку, а не пропадает молча.
 */
describe('assistHistory — прежние реплики окна для запроса', () => {
  it('по порядку, роль и текст; неудачный ответ и пустые реплики не едут', () => {
    expect(
      assistHistory([
        { role: 'user', text: 'назови правило lint' },
        { role: 'assistant', text: 'Назвал: lint' },
        { role: 'user', text: 'теперь описание' },
        { role: 'assistant', text: 'Помощник не ответил', failed: true },
        { role: 'user', text: '   ' },
      ]),
    ).toEqual([
      { role: 'user', text: 'назови правило lint' },
      { role: 'assistant', text: 'Назвал: lint' },
      { role: 'user', text: 'теперь описание' },
    ]);
  });

  it('пустое окно — пустая история', () => {
    expect(assistHistory([])).toEqual([]);
  });
});

describe('keptSecretMisses — секрет оставлен как был', () => {
  it('каждое поле — промах с причиной secret; нет полей — нет промахов', () => {
    expect(keptSecretMisses(['headersText', 'envText'])).toEqual([
      { field: 'headersText', reason: 'secret' },
      { field: 'envText', reason: 'secret' },
    ]);
    expect(keptSecretMisses(undefined)).toEqual([]);
  });

  it('groupMisses выносит их отдельной строкой', () => {
    expect(
      groupMisses([
        { field: 'members', reason: 'unknown-value', values: ['a'] },
        ...keptSecretMisses(['headersText']),
      ]),
    ).toEqual({ values: ['members: a'], types: [], fields: [], secrets: ['headersText'] });
  });
});
