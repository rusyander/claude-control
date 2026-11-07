import { beforeAll, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ModelInfo } from '@agentdeck/contracts';
import { i18n } from '@shared/config/i18n';
import { ChatHeader } from './ChatHeader';
import type { ChatHeaderProps } from './ChatHeader.types';

/**
 * Шапка чата отдаёт выбору модели CLI разговора (W3-17a): разговор Qwen при активном Claude
 * предлагает «как выберет CLI» и каталог Qwen, а не алиасы Claude. Перехода «продолжить через
 * ядро» в шапке больше нет: чат любого CLI идёт здесь же.
 */
beforeAll(async () => {
  await i18n.changeLanguage('ru');
});

const QWEN: ModelInfo[] = [
  { id: 'qwen3-coder-plus', name: 'Qwen3 Coder Plus', family: 'qwen-coder', vendor: 'alibaba' },
];
const noop = () => {};

function render(cli: string | undefined): string {
  const props: ChatHeaderProps = {
    chatTitle: 'разговор',
    isProjectContext: false,
    chatId: 'chat-1',
    sessionId: '0f6a2f7e-1111-4222-8333-944445555666',
    activeRuns: [],
    totalCost: 0,
    totalTokens: 0,
    costUnit: 'tokens',
    onStopRun: noop,
    onStopAllRuns: noop,
    onViewRun: noop,
    model: '',
    effort: '',
    defaultModel: '',
    defaultEffort: '',
    models: QWEN,
    ...(cli ? { cli } : {}),
    consumer: 'chat',
    onModelChange: noop,
    onEffortChange: noop,
    isEditorPending: false,
    onOpenEditor: noop,
    onOpenCode: noop,
    onOpenTests: noop,
    onOpenEnvironment: noop,
    allowEdits: false,
    onAllowEditsChange: noop,
    autoApprove: false,
    onAutoApproveChange: noop,
    runStatus: 'idle',
    onRetry: noop,
    onContinue: noop,
    onAllowAndContinue: noop,
    tokens: 0,
    canExport: false,
    onExport: noop,
    onRefresh: noop,
  };
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <ChatHeader {...props} />
    </QueryClientProvider>,
  );
}

/** Значения пунктов выбора модели — то, что человек может выбрать в шапке. */
const modelValues = (html: string): string[] =>
  [
    ...(html.match(/aria-label="Модель"[^>]*>([\s\S]*?)<\/select>/)?.[1] ?? '').matchAll(
      /value="([^"]*)"/g,
    ),
  ].map((m) => m[1] ?? '');

describe('ChatHeader — модель CLI разговора', () => {
  it('разговор Qwen: «как выберет CLI» и его каталог, алиасов Claude нет', () => {
    const html = render('qwen');
    expect(modelValues(html)).toEqual(['', 'qwen3-coder-plus']);
    expect(html).toContain('как выберет CLI');
  });

  it('CLI не назван — разговор Claude: его алиасы на месте', () => {
    expect(modelValues(render(undefined))).toEqual(
      expect.arrayContaining(['', 'opus', 'sonnet', 'qwen3-coder-plus']),
    );
  });

  it('перехода «продолжить через ядро» в шапке нет', () => {
    expect(render('qwen')).not.toContain('data-chat-continue-in-core');
  });
});
