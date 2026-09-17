import { describe, expect, it } from 'vitest';
import {
  isSecretName,
  maskArgList,
  maskNamedValue,
  maskSecretsInText,
  SECRET_MASK,
} from './secret-mask.ts';

/**
 * Значения собраны из кусков: присваивание, похожее на ключ, в репозитории не
 * лежит. Формы — из ревью 17.09.2026 (`mask-probe.ts`, `dlp-probe.ts`): ровно
 * то, что проходило мимо прежней маски.
 */
const j = (...parts: string[]): string => parts.join('');

describe('maskSecretsInText — формы настоящих конфигов', () => {
  const leaks: Array<[string, string, string]> = [
    ['заголовок mcp-remote', `Authorization: Bearer ${j('sk-live-', 'SECRET1')}`, 'SECRET1'],
    ['X-Auth в команде', `curl -H "X-Auth: ${j('SEC', 'RET13')}" https://x`, 'RET13'],
    ['--api-key=', `--api-key=${j('sk-', 'SECRET2')}`, 'SECRET2'],
    ['--token значение', `tool --jira-token ${j('SEC', 'RET15')}`, 'RET15'],
    ['?apiKey= в адресе', `https://h/mcp?apiKey=${j('SEC', 'RET5')}&x=1`, 'RET5'],
    ['access_token в адресе', `https://h/mcp?access_token=${j('SEC', 'RET7')}`, 'RET7'],
    ['пароль в адресе', `https://user:${j('SEC', 'RET6')}@h/mcp`, 'RET6'],
    ['DATABASE_URL', `postgres://u:${j('SEC', 'RET8')}@db/x`, 'RET8'],
    ['docker -e TOKEN=', `-e GITHUB_PERSONAL_ACCESS_TOKEN=${j('SEC', 'RET16')}`, 'RET16'],
    ['ghp_ без имени', j('ghp_', 'SECRET10abcdefghijklmnopqrstuvwxyz12'), 'SECRET10'],
    ['JSON X-Auth', `"X-Auth": "${j('LIVE', 'SECRET-B2')}"`, 'SECRET-B2'],
    ['32 hex', `ключ контура: ${j('3f9a1c7e5b2d4a6f', '8e0c1b3d5f7a9c2e')}`, '8e0c1b3d'],
    ['key=', `key=${j('Zx9kLmN0pQrS7t', 'UvWxYz12345')}`, 'UvWxYz'],
    ['gor_live_', j('gor_live_7Hk2mP9qR4sT6v', 'W8xY0zA1bC3dE5fG'), 'W8xY0z'],
    ['пароль словами', `пароль от джиры ${j('Qwerty!', '2345')}`, 'Qwerty'],
  ];
  it.each(leaks)('%s — значение скрыто', (_name, text, fragment) => {
    const masked = maskSecretsInText(text);
    expect(masked).not.toContain(fragment);
    expect(masked).toContain(SECRET_MASK);
  });

  const clean = [
    'C:\\work\\agentdeck\\apps\\server\\src\\routes\\panel-agent\\actions-config.ts',
    'https://gitlab.example.com/api/v4/mcp',
    'b3705c71-a8c9-4d59-affb-6429d074639e',
    'Открой страницу правил и добавь правило про тесты, модель claude-opus-4-5-20251101',
    'Primary key: id column',
    'author: Ivan',
    'поменяй пароль в файле config.v2.json',
    'пароль должен быть длинным',
    '"API_KEY": "${API_KEY}"',
    'Authorization: Bearer ${GITLAB_TOKEN}',
    'npx -y @modelcontextprotocol/server-filesystem C:/work',
    '2026-09-17T08:59:49.682Z',
    'Accept: application/json',
    'panel-agent-routes.integration.test.ts',
    'useChatMessagesPlaceholderData2',
    'MAX_THINKING_TOKENS держим в настройках',
  ];
  it.each(clean)('без ложного срабатывания: %s', (text) => {
    expect(maskSecretsInText(text)).toBe(text);
  });
});

describe('имена и структурные значения', () => {
  it('секретные имена — по сегментам, без «author» и «hotkey»', () => {
    for (const name of ['X-Auth', 'PRIVATE-TOKEN', 'X-Goog-Api-Key', 'primaryApiKey', 'Cookie']) {
      expect(isSecretName(name), name).toBe(true);
    }
    for (const name of ['author', 'hotkey', 'Accept', 'GITLAB_API_URL', 'url']) {
      expect(isSecretName(name), name).toBe(false);
    }
  });

  it('значение по имени: секретное имя прячет целиком, ссылка остаётся', () => {
    expect(maskNamedValue('X-Auth', 'abc')).toBe(SECRET_MASK);
    expect(maskNamedValue('JIRA_API_TOKEN', '${JIRA_API_TOKEN}')).toBe('${JIRA_API_TOKEN}');
    expect(maskNamedValue('DATABASE_URL', 'postgres://u:pw1234@h/db')).toBe(
      `postgres://u:${SECRET_MASK}@h/db`,
    );
    expect(maskNamedValue('GITLAB_API_URL', 'https://gitlab.example.com')).toBe(
      'https://gitlab.example.com',
    );
  });

  it('аргументы: значение после секретного флага и заголовок mcp-remote', () => {
    expect(
      maskArgList(['mcp-remote', 'https://h/mcp', '--header', 'Authorization: Bearer abc123']),
    ).toEqual(['mcp-remote', 'https://h/mcp', '--header', `Authorization: Bearer ${SECRET_MASK}`]);
    expect(maskArgList(['--password', 'x', '--port', '3000'])).toEqual([
      '--password',
      SECRET_MASK,
      '--port',
      '3000',
    ]);
  });
});
