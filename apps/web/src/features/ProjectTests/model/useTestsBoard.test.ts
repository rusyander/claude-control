import { describe, it, expect } from 'vitest';
import type { ProjectTestGroup } from '@agentdeck/contracts';
import { messageOf, pickActive, toggleChecked } from './useTestsBoard';

describe('pickActive', () => {
  const groups: ProjectTestGroup[] = [
    { id: 'gui', title: 'GUI', file: 'gui.tests.json', cases: [] },
    { id: 'api', title: 'API', file: 'api.tests.json', cases: [] },
  ];

  it('открывает выбранную группу', () => {
    expect(pickActive(groups, 'api')?.id).toBe('api');
  });

  it('исчезнувшая или ещё не выбранная группа заменяется первой', () => {
    expect(pickActive(groups, '')?.id).toBe('gui');
    expect(pickActive(groups, 'удалённая')?.id).toBe('gui');
  });

  it('групп нет — открывать нечего', () => {
    expect(pickActive([], 'gui')).toBeUndefined();
  });
});

describe('toggleChecked', () => {
  it('добавляет и снимает отметку, не задваивая её', () => {
    expect(toggleChecked([], 'a')).toEqual(['a']);
    expect(toggleChecked(['a'], 'b')).toEqual(['a', 'b']);
    expect(toggleChecked(['a', 'b'], 'a')).toEqual(['b']);
  });

  it('исходный набор не меняется — состояние обновляется копией', () => {
    const checked = ['a'];
    toggleChecked(checked, 'b');
    expect(checked).toEqual(['a']);
  });
});

describe('messageOf', () => {
  it('без ошибки молчит', () => {
    expect(messageOf(undefined)).toBeUndefined();
    expect(messageOf(null)).toBeUndefined();
  });

  it('берёт текст сервера, а не общий текст исключения', () => {
    const error = Object.assign(new Error('Request failed'), {
      response: { data: { message: 'Кейс с таким идентификатором уже есть' } },
    });
    expect(messageOf(error)).toBe('Кейс с таким идентификатором уже есть');
  });

  it('без ответа сервера остаётся текст исключения', () => {
    expect(messageOf(new Error('Network Error'))).toBe('Network Error');
  });
});
