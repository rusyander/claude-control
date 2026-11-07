import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ChatSummary, ModelInfo } from '@agentdeck/contracts';
import '@shared/config/i18n/instance';
import { ChatModelPicker } from '@features/ChatModelPicker';
import { useChatModelPrefs } from './useChatModelPrefs';

/**
 * Глубина в шапке чата (находка 17 живого прогона 24.09): разбор шёл на xhigh —
 * так его завела панель, — а шапка показывала «Высокая» из настроек. Проверяется
 * тот же путь, что на странице: хук настроек разговора → выбор в шапке, с
 * настоящим русским словарём, а не с одними ключами.
 */

type Chat = Pick<ChatSummary, 'effort' | 'assignedModel'> | undefined;

function Header({
  chat,
  chatEffort,
  chatModel,
  cli,
  catalog,
  contour = false,
}: {
  chat: Chat;
  chatEffort: string;
  chatModel: string;
  cli?: string;
  catalog?: ModelInfo[];
  contour?: boolean;
}) {
  const models = useChatModelPrefs('k', { chatModel, chatEffort }, chat, {
    ...(cli ? { cli } : {}),
    ...(catalog ? { catalog } : {}),
    contour,
  });
  return (
    <>
      <ChatModelPicker
        model={models.modelOverride}
        effort={models.effortOverride}
        defaultModel={models.defaultModel}
        defaultEffort={models.defaultEffort}
        {...(cli ? { cli } : {})}
        {...(catalog ? { models: catalog } : {})}
        onModelChange={() => {}}
        onEffortChange={() => {}}
      />
      <output
        data-effective-effort={models.effective.effort}
        data-effective-model={models.effective.model}
      />
    </>
  );
}

const render = (chat: Chat, chatEffort = 'high', chatModel = ''): string =>
  renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <Header chat={chat} chatEffort={chatEffort} chatModel={chatModel} />
    </QueryClientProvider>,
  );

/** Подпись пункта «по умолчанию» в выборе глубины — то, что человек видит в шапке. */
const defaultEffortLabel = (html: string): string | undefined =>
  html.match(/aria-label="Глубина продумывания"[^>]*>\s*<option[^>]*value=""[^>]*>([^<]*)</)?.[1];

describe('глубина в шапке чата', () => {
  it('разговор с назначенной xhigh показывает «Оч. высокая», а не настройку', () => {
    const html = render({ effort: 'xhigh' });

    expect(defaultEffortLabel(html)).toBe('Оч. высокая');
    expect(html).toContain('data-effective-effort="xhigh"');
  });

  it('у каждой глубины своя подпись', () => {
    const labels = ['low', 'medium', 'high', 'xhigh', 'max'].map((effort) =>
      defaultEffortLabel(render({ effort }, 'medium')),
    );

    expect(labels).toEqual(['Низкая', 'Средняя', 'Высокая', 'Оч. высокая', 'Максимум']);
  });

  it('без назначения — глубина из настроек', () => {
    const html = render({}, 'high');

    expect(defaultEffortLabel(html)).toBe('Высокая');
    expect(html).toContain('data-effective-effort="high"');
  });

  it('без разговора — глубина из настроек', () => {
    expect(defaultEffortLabel(render(undefined, 'low'))).toBe('Низкая');
  });
});

/** Подпись пункта «по умолчанию» в выборе модели. */
const defaultModelLabel = (html: string): string | undefined =>
  html.match(/aria-label="Модель"[^>]*>s*<option[^>]*value=""[^>]*>([^<]*)</)?.[1];

// Модель — по тому же правилу, что глубина (W3-5, владелец 25.09): группа,
// заведённая на haiku, не должна отвечать человеку на модели из настроек.
describe('модель в шапке чата', () => {
  it('назначенная разговору модель важнее настройки', () => {
    const html = render({ assignedModel: 'claude-haiku-4-5' }, 'high', 'claude-opus-4-1');

    expect(html).toContain('data-effective-model="claude-haiku-4-5"');
    expect(defaultModelLabel(html)).toContain('haiku');
  });

  it('без назначения — модель из настроек', () => {
    const html = render({}, 'high', 'claude-opus-4-1');

    expect(html).toContain('data-effective-model="claude-opus-4-1"');
    expect(defaultModelLabel(html)).toContain('opus');
  });
});

// W3-17a: шапка предлагает модели CLI разговора. Новый чат при активном Qwen предлагал алиасы
// Claude и слал `opus` из настроек — ядро получало `set-model opus` для qwen.
describe('модель в шапке чата другого CLI (W3-17a)', () => {
  const QWEN_CATALOG: ModelInfo[] = [
    { id: 'qwen3-coder-plus', name: 'Qwen3 Coder Plus', family: 'qwen-coder', vendor: 'alibaba' },
  ];
  const renderCli = (
    cli: string,
    chatModel: string,
    chat: Chat = {},
    catalog: ModelInfo[] = QWEN_CATALOG,
    contour = false,
  ): string =>
    renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <Header
          chat={chat}
          chatEffort="high"
          chatModel={chatModel}
          cli={cli}
          catalog={catalog}
          contour={contour}
        />
      </QueryClientProvider>,
    );
  const optionValues = (html: string): string[] =>
    [
      ...(html.match(/aria-label="Модель"[^>]*>([\s\S]*?)<\/select>/)?.[1] ?? '').matchAll(
        /value="([^"]*)"/g,
      ),
    ].map((m) => m[1] ?? '');

  it('qwen: модель Claude из настроек не уходит, алиасов Claude нет, «по умолчанию» — модель CLI', () => {
    const html = renderCli('qwen', 'opus');

    expect(html).toContain('data-effective-model=""');
    expect(optionValues(html)).toEqual(['', 'qwen3-coder-plus']);
    expect(defaultModelLabel(html)).toBe('как выберет CLI');
  });

  it('qwen: назначенная разговору модель Claude тоже не уходит', () => {
    const html = renderCli('qwen', '', { assignedModel: 'claude-haiku-4-5' });

    expect(html).toContain('data-effective-model=""');
  });

  it('qwen: своя модель из настроек уходит как была', () => {
    expect(renderCli('qwen', 'qwen3-coder-plus')).toContain(
      'data-effective-model="qwen3-coder-plus"',
    );
  });

  // Ревью W3-17a (M-F1): каталог OpenCode Zen (и каталог контура у любого CLI) несёт `claude-*` —
  // это модели САМОГО CLI. Отсекать их правилом «имя Claude» значило: пункт списка выбирается, а
  // шапка тут же возвращается к «как выберет CLI», и выбор не уходит.
  it('opencode: claude-* из его же каталога уходит и стоит в списке; алиас Claude — нет', () => {
    const zen: ModelInfo[] = [
      {
        id: 'claude-sonnet-4-5',
        name: 'Claude Sonnet 4.5',
        family: 'claude-sonnet',
        vendor: 'opencode',
      },
      { id: 'gpt-5', name: 'GPT-5', family: 'gpt', vendor: 'opencode' },
    ];
    const html = renderCli('opencode', 'claude-sonnet-4-5', {}, zen);

    expect(html).toContain('data-effective-model="claude-sonnet-4-5"');
    expect(optionValues(html)).toEqual(['', 'claude-sonnet-4-5', 'gpt-5']);
    expect(renderCli('opencode', 'opus', {}, zen)).toContain('data-effective-model=""');
  });

  // Ревью W3-17a (M-F1, живой прогон check-core-chat): через контур модель решает его перевод, а
  // каталог контура один у любого CLI и несёт `claude-*`. Срезанная шапкой, модель Claude из
  // настроек пропадала ДО перевода — ход qwen шёл на модели контура по умолчанию.
  it('qwen через контур: модель Claude из настроек и назначенная уходят как есть — их переводит контур', () => {
    expect(renderCli('qwen', 'claude-sonnet-5-5', {}, QWEN_CATALOG, true)).toContain(
      'data-effective-model="claude-sonnet-5-5"',
    );
    expect(
      renderCli('qwen', '', { assignedModel: 'claude-haiku-4-5' }, QWEN_CATALOG, true),
    ).toContain('data-effective-model="claude-haiku-4-5"');
  });

  it('claude: алиасы Claude на месте, модель из настроек уходит', () => {
    const html = renderCli('claude', 'opus');

    expect(html).toContain('data-effective-model="opus"');
    expect(optionValues(html)).toEqual(
      expect.arrayContaining(['', 'fable', 'opus', 'sonnet', 'haiku']),
    );
  });
});
