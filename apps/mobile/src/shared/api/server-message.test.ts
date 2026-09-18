import { describe, expect, it, vi } from 'vitest';
import {
  serverMessageCodes,
  serverMessageParams,
  templateParams,
} from '@agentdeck/contracts/server-messages';
import { en } from '../config/i18n/en';
import { ru } from '../config/i18n/ru';

let language: 'ru' | 'en' = 'en';
vi.mock('../config/i18n', () => ({ dict: () => (language === 'en' ? en : ru) }));

const { serverField, serverMessage } = await import('./server-message');

/**
 * Каждый код сервера переведён на оба языка телефона, и перевод использует ровно
 * объявленные подстановки: пустая строка или забытое `{{cwd}}` краснеют здесь,
 * а не на экране.
 */
describe('тексты сервера по коду на телефоне', () => {
  for (const [name, dictionary] of Object.entries({ ru, en })) {
    it(`${name}: у каждого кода непустой текст с объявленными подстановками`, () => {
      const table = dictionary.serverMessages as Record<string, string | undefined>;
      const problems = serverMessageCodes.flatMap((code) => {
        const text = table[code];
        if (!text?.trim()) return [`${code}: нет перевода`];
        const used = [...new Set(templateParams(text))].sort();
        const declared = [...serverMessageParams[code]].sort();
        return JSON.stringify(used) === JSON.stringify(declared) ? [] : [`${code}: ${used}`];
      });
      expect(problems).toEqual([]);
      expect(Object.keys(table).sort()).toEqual([...serverMessageCodes].sort());
    });
  }

  it('код переводится с подстановками; незнакомый код — пусто', () => {
    language = 'en';
    expect(serverMessage('run-workspace-missing', { cwd: 'C:/w' })).toBe(
      'This chat’s working folder was not found: C:/w. The conversation started there and can only continue from there.',
    );
    expect(serverMessage('newer-server-code')).toBeUndefined();
    language = 'ru';
    expect(serverMessage('platform-not-found', { id: 'dev' })).toBe('Контура «dev» не существует.');
  });

  it('поле записи: свой код поля, у текста отказа — общие messageCode + params', () => {
    language = 'en';
    expect(serverField({ output: 'Коммит создан', outputCode: 'git-committed' }, 'output')).toBe(
      'Commit created',
    );
    expect(
      serverField(
        {
          error: 'Скилл «x» уже существует',
          messageCode: 'skill-exists',
          params: { skillId: 'x' },
        },
        'error',
      ),
    ).toBe('Skill «x» already exists');
    expect(serverField({ output: '[main 1a2b] fix' }, 'output')).toBe('[main 1a2b] fix');
  });
});
