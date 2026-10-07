import { beforeAll, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { PlatformRunPlan } from '@agentdeck/contracts';
import { i18n } from '@shared/config/i18n';
import { queryKeys } from '@shared/api/query-keys';
import { ChatModelPicker } from './ChatModelPicker';

/**
 * Шапка чата при Claude Code, уведённом на локальную модель: ответит Qwen, и
 * выбор обязан назвать её, а не «Opus». План — в кеше запроса тем ключом, которым
 * его спрашивает настоящий хук; сама шапка не подменяется.
 */

const LOCAL = { model: 'qwen3.6:27b-coding', title: 'Qwen3.6 27B Coding' };

function render(plan: PlatformRunPlan): string {
  const client = new QueryClient();
  client.setQueryData(queryKeys.platformRunPlan('chat'), plan);
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <ChatModelPicker
        model="claude-opus-5-5"
        effort=""
        defaultModel="opus"
        defaultEffort=""
        onModelChange={() => undefined}
        onEffortChange={() => undefined}
      />
    </QueryClientProvider>,
  );
}

const plain: PlatformRunPlan = {
  routed: false,
  title: '',
  reason: 'no_active_platform',
  rules: { model: '', source: 'none', map: {}, catalog: [] },
  effort: true,
};

beforeAll(async () => {
  await i18n.changeLanguage('ru');
});

describe('выбор модели при Claude на локальной модели', () => {
  it('заперт именем локальной модели и говорит, что отвечает она', () => {
    const html = render({ ...plain, local: LOCAL });
    expect(html).toMatch(/<select[^>]*disabled[^>]*>.*Qwen3\.6 27B Coding/s);
    expect(html).toContain(i18n.t('chat.localCaption', { title: LOCAL.title }));
    expect(html).not.toContain('Opus');
  });

  it('переключатель выключен — обычный выбор моделей Claude, без локальной подписи', () => {
    const html = render(plain);
    expect(html).toContain('Opus');
    expect(html).not.toContain(LOCAL.title);
  });
});
