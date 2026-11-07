import { beforeAll, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { AgentNode } from '@agentdeck/contracts/core/agents';
import { i18n } from '@shared/config/i18n';
import { createDraftBox } from '@shared/lib/draft/useDraftBox';
import { agentTreeKeys, NO_FILTERS } from '@entities/AgentTree';
import { ChatDock } from './ChatDock';

/**
 * Кнопка «Агенты · фоном: N» над полем ввода (этап 11, W3-17): узлы ядра этого разговора, у
 * любого CLI — дерево больше не читает транскрипты субагентов. Узлы есть — карточка стоит; ключа
 * разговора нет — карточки нет.
 */
beforeAll(async () => {
  await i18n.changeLanguage('ru');
});

const SESSION = '019a0000-0000-7000-8000-000000000003';
const NODE = {
  nodeId: SESSION,
  parentId: null,
  taskId: '019a0000-0000-7000-8000-000000000001',
  kind: 'unit-session',
  status: 'completed',
  stepId: '019a0000-0000-7000-8000-000000000002',
  unitId: null,
  sessionId: SESSION,
  model: null,
  background: false,
  startedAt: 1_000,
  endedAt: 61_000,
  spend: { tokens: null, windowShare: null },
  counts: { toolCalls: 0, files: 0, refusals: 0, escalations: 0, children: 0 },
  signals: [],
  briefExcerpt: null,
  returnExcerpt: null,
} satisfies AgentNode;

function render(progressChatId: string | undefined): string {
  const client = new QueryClient();
  client.setQueryData(agentTreeKeys.list('chat-1', NO_FILTERS), { nodes: [NODE] });
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <ChatDock
        {...(progressChatId ? { progressChatId } : {})}
        isRunning={false}
        queued={[]}
        onCancelQueued={() => {}}
        draft={createDraftBox(undefined)}
        onSend={async () => true}
        onStop={() => {}}
      />
    </QueryClientProvider>,
  );
}

describe('ChatDock — агенты разговора', () => {
  it('узлы ядра у разговора есть — карточка «Агенты» над полем ввода', () => {
    const html = render('chat-1');
    expect(html).toContain('data-agent-history-open="1"');
    expect(html).toContain('фоновых нет');
  });

  it('ключа разговора нет — карточки нет', () => {
    expect(render(undefined)).not.toContain('data-agent-history-card');
  });
});
