import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { maskPanelAgentMessages } from './data-mask.ts';

/**
 * Маска реплик человека (§3.4): ключи непрозрачных форм, которые встроенные
 * образцы DLP не узнают, — проба ревью `dlp-probe.ts` отдавала их модели как есть.
 * Значения собраны из кусков, чтобы в репозитории не лежало похожее на ключ.
 */
const j = (...parts: string[]): string => parts.join('');

describe('maskPanelAgentMessages — ключи без префикса вендора', () => {
  let appData: string;
  beforeEach(() => {
    appData = mkdtempSync(join(tmpdir(), 'cc-agent-mask-'));
  });
  afterEach(() => rmSync(appData, { recursive: true, force: true }));

  const mask = (content: string): string => {
    const result = maskPanelAgentMessages(appData, [{ role: 'user', content }]);
    if (!result.ok) throw new Error(result.message);
    return result.messages[0]!.content;
  };

  const secrets: Array<[string, string]> = [
    ['32 hex', j('3f9a1c7e5b2d4a6f', '8e0c1b3d5f7a9c2e')],
    ['gor_live_', j('gor_live_7Hk2mP9qR4sT6v', 'W8xY0zA1bC3dE5fG')],
    ['key=', j('Zx9kLmN0pQrS7t', 'UvWxYz12345')],
    ['пароль', j('Qwerty!', '2345')],
  ];
  const texts: Record<string, (value: string) => string> = {
    '32 hex': (value) => `ключ контура: ${value}`,
    gor_live_: (value) => `вот ключ ${value} для dev`,
    'key=': (value) => `key=${value}`,
    пароль: (value) => `пароль от джиры ${value}`,
  };

  it.each(secrets)('%s — до модели не доходит, метка из словаря хода', (name, value) => {
    const masked = mask(texts[name]!(value));
    expect(masked).not.toContain(value);
    expect(masked).toMatch(/\[КЛЮЧ_1\]/);
  });

  it('одно значение в двух репликах — одна метка', () => {
    const key = j('gor_live_7Hk2mP9qR4sT6v', 'W8xY0zA1bC3dE5fG');
    const result = maskPanelAgentMessages(appData, [
      { role: 'user', content: `ключ ${key}` },
      { role: 'assistant', content: 'не нужно' },
      { role: 'user', content: `всё же ${key}` },
    ]);
    expect(result.ok && result.messages.map((message) => message.content)).toEqual([
      'ключ [КЛЮЧ_1]',
      'не нужно',
      'всё же [КЛЮЧ_1]',
    ]);
  });

  it.each([
    'Открой C:\\work\\agentdeck\\apps\\server и добавь правило про тесты',
    // Адрес и UUID маскирует уже встроенный набор DLP — здесь проза без них.
    'Запусти тесты группы gui-002 в проекте useChatMessagesPlaceholderData2',
    'Поменяй пароль в файле config.v2.json на странице настроек',
    'Модель claude-opus-4-5-20251101, файл panel-agent-routes.integration.test.ts',
  ])('обычная просьба не трогается: %s', (text) => {
    expect(mask(text)).toBe(text);
  });
});
