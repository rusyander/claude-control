import { beforeAll, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { AgentNode } from '@agentdeck/contracts/core/agents';
import { i18n } from '@shared/config/i18n';
import { agentTreeKeys, NO_FILTERS } from '@entities/AgentTree';
import { ChatPreviewPane } from './ChatPreviewPane';

/**
 * Клик по субагенту в дереве открывает справа его узел ядра (этап 11, W3-17): что ему поручили,
 * по журналу ядра, у любого CLI — транскрипт субагента панель больше не читает.
 */
beforeAll(async () => {
  await i18n.changeLanguage('ru');
});

const NODE_ID = '019a0000-0000-7000-8000-00000000000a';
const node = (nodeId: string, briefExcerpt: string): AgentNode => ({
  nodeId,
  parentId: null,
  taskId: '019a0000-0000-7000-8000-000000000001',
  kind: 'subagent',
  status: 'completed',
  stepId: '019a0000-0000-7000-8000-000000000002',
  unitId: null,
  sessionId: '019a0000-0000-7000-8000-000000000003',
  model: null,
  background: false,
  startedAt: 1_000,
  endedAt: 61_000,
  spend: { tokens: null, windowShare: null },
  counts: { toolCalls: 0, files: 0, refusals: 0, escalations: 0, children: 0 },
  signals: [],
  briefExcerpt,
  returnExcerpt: null,
});

function render(agentId: string): string {
  const client = new QueryClient();
  client.setQueryData(agentTreeKeys.list('chat-1', NO_FILTERS), {
    nodes: [
      node('019a0000-0000-7000-8000-00000000000b', 'Чужой узел'),
      node(NODE_ID, 'Проверить тесты\nподробно'),
    ],
  });
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <ChatPreviewPane
        chatId="chat-1"
        agent={{ chatId: 'chat-1', agentId }}
        width={480}
        onResize={() => {}}
        onClose={() => {}}
      />
    </QueryClientProvider>,
  );
}

describe('ChatPreviewPane — узел субагента', () => {
  it('открывает узел, названный кликом: его поручение заголовком', () => {
    const html = render(NODE_ID);
    expect(html).toContain(`data-agent-pane="${NODE_ID}"`);
    expect(html).toContain('Проверить тесты');
    expect(html).not.toContain('Чужой узел');
  });
});

/** Окно сайта (этап 12, D20): пока оно открыто, столбец занят только им — iframe через прокси. */
describe('ChatPreviewPane — окно сайта', () => {
  it('показывает сайт через прокси в песочнице, а не узел субагента рядом', () => {
    const client = new QueryClient();
    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <ChatPreviewPane
          chatId="chat-1"
          site={{
            preview: {
              siteId: 'site-1',
              url: 'http://127.0.0.1:41234/',
              nonce: 'n0nce-0123456789abcdef',
            },
            name: 'stand-site',
            siteUrl: 'http://localhost:5173/',
            onPick: () => {},
            onClose: () => {},
          }}
          agent={{ chatId: 'chat-1', agentId: NODE_ID }}
          width={480}
          onResize={() => {}}
          onClose={() => {}}
        />
      </QueryClientProvider>,
    );
    expect(html).toContain('data-site-preview');
    expect(html).toContain('src="http://127.0.0.1:41234/"');
    expect(html).toContain('sandbox="allow-scripts allow-same-origin allow-forms allow-popups"');
    expect(html).toContain('title="Сайт проекта stand-site"');
    expect(html).toContain('aria-pressed="false"');
    expect(html).toContain('href="http://localhost:5173/"');
    expect(html).not.toContain('data-agent-pane');
  });
});
