import { beforeAll, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { MessageUsage } from '@agentdeck/contracts';
import { i18n } from '@shared/config/i18n';
import { TokenBadge } from './token-badge';

/**
 * Скорость у ответа локальной модели (приоритет №1, пункт 3): видна на самом
 * значке, без наведения, — ради неё человек выбирал карту и контекст. У облачного
 * Claude её нет: там это число ничего не меняет.
 */

const USAGE: MessageUsage = { input: 20, output: 224, cacheRead: 0, cacheCreation: 0 };

beforeAll(async () => {
  await i18n.changeLanguage('ru');
});

describe('TokenBadge: скорость генерации', () => {
  it('локальная модель с временем генерации — «N ток/с» на значке', () => {
    const html = renderToStaticMarkup(
      <TokenBadge usage={{ ...USAGE, model: 'qwen3.6:27b-coding', genMs: 2000 }} />,
    );
    expect(html).toContain('112 ток/с');
  });

  it('облачный Claude — без скорости', () => {
    const html = renderToStaticMarkup(
      <TokenBadge usage={{ ...USAGE, model: 'claude-opus-5-5', genMs: 2000 }} />,
    );
    expect(html).not.toContain('ток/с');
  });
});
