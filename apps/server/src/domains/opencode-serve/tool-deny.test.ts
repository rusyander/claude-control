import { describe, expect, it } from 'vitest';
import {
  OPENCODE_TOOL_DENY_ENV,
  opencodeToolDeny,
  readToolDeny,
  toolDenyRules,
  withToolDenyEnv,
} from './tool-deny.ts';

/**
 * Выключатель инструментов MCP группы в OpenCode (P-16). Имена — как OpenCode
 * складывает имя инструмента MCP (`<сервер>_<инструмент>`, недопустимое — `_`):
 * проверено OpenCode 1.18.35 телом запроса (`check-opencode-mcp-off.mjs`).
 */
describe('opencodeToolDeny: шаблоны из снятых серверов и снятых поимённо инструментов', () => {
  it('сервер целиком — `<сервер>_*`, имя — `<сервер>_<имя>`; снятому целиком имён не нужно', () => {
    expect(
      opencodeToolDeny(['telegram-inbox', 'figma.dev'], {
        jira: ['confluence_search', 'confluence_get_page'],
        'telegram-inbox': ['confluence_search'],
      }),
    ).toEqual([
      'telegram-inbox_*',
      'figma_dev_*',
      'jira_confluence_search',
      'jira_confluence_get_page',
    ]);
  });

  it('снимать нечего — пусто', () => {
    expect(opencodeToolDeny([], {})).toEqual([]);
    expect(opencodeToolDeny([])).toEqual([]);
  });
});

describe('readToolDeny: ключ панели из окружения прогона', () => {
  it('массив строк — как есть; битое и чужое — пусто', () => {
    expect(readToolDeny({ [OPENCODE_TOOL_DENY_ENV]: '["a_*","b_c"]' })).toEqual(['a_*', 'b_c']);
    for (const raw of ['не json', '{"a":1}', '[1,""]'])
      expect(readToolDeny({ [OPENCODE_TOOL_DENY_ENV]: raw }), raw).toEqual([]);
    expect(readToolDeny(undefined)).toEqual([]);
  });
});

describe('withToolDenyEnv: окружение одиночного `opencode run`', () => {
  it('ключ панели снят, шаблоны — `deny` в OPENCODE_PERMISSION поверх объекта человека', () => {
    const env = withToolDenyEnv(
      { [OPENCODE_TOOL_DENY_ENV]: '["telegram-inbox_*"]', PWD: '/w' },
      '{"bash":"ask","telegram-inbox_*":"allow"}',
    );
    expect(env).toEqual({
      PWD: '/w',
      OPENCODE_PERMISSION: '{"bash":"ask","telegram-inbox_*":"deny"}',
    });
  });

  it('объект прогона сильнее унаследованного; битый — заменяется', () => {
    expect(
      withToolDenyEnv(
        { [OPENCODE_TOOL_DENY_ENV]: '["x_*"]', OPENCODE_PERMISSION: '{"edit":"deny"}' },
        '{"bash":"ask"}',
      ).OPENCODE_PERMISSION,
    ).toBe('{"edit":"deny","x_*":"deny"}');
    expect(
      withToolDenyEnv({ [OPENCODE_TOOL_DENY_ENV]: '["x_*"]' }, 'не json').OPENCODE_PERMISSION,
    ).toBe('{"x_*":"deny"}');
  });

  it('нет ключа — окружение то же; пустой список — ключ снят, OPENCODE_PERMISSION не тронут', () => {
    const plain = { PWD: '/w' };
    expect(withToolDenyEnv(plain, undefined)).toBe(plain);
    expect(withToolDenyEnv({ [OPENCODE_TOOL_DENY_ENV]: '[]', PWD: '/w' }, '{"a":1}')).toEqual({
      PWD: '/w',
    });
  });
});

describe('toolDenyRules: правила набора сессии', () => {
  it('на каждый шаблон — deny на любой аргумент', () => {
    expect(toolDenyRules(['a_*'])).toEqual([{ permission: 'a_*', pattern: '*', action: 'deny' }]);
  });
});
