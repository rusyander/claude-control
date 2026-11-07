import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AgentNodeDetail as Detail } from '@agentdeck/contracts/core/agents';
import { Typography } from '@shared/ui/typography';
import { useAgentNode } from '../../api/agentTreeApi';
import { AgentNodeDetailView } from './AgentNodeDetailView';
import type { AgentNodeDetailProps } from './AgentHistory.types';

/** Часы «идёт N» у идущего узла: раз в секунду, только пока узел идёт. */
function useNow(running: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  return now;
}

/** Страницы вызовов — одним списком; узел и прочие разделы — из первой страницы. */
function merged(pages: readonly Detail[]): Detail | undefined {
  const [first] = pages;
  if (!first) return undefined;
  return {
    ...first,
    toolCalls: {
      items: pages.flatMap((page) => page.toolCalls.items),
      next: pages[pages.length - 1]?.toolCalls.next ?? null,
    },
  };
}

/**
 * Узел подробно у ядра (`GET /api/core/tasks/:id/agents/:nodeId`): идущий перечитывается сам,
 * вызовы догружаются страницами по «Ещё вызовы».
 */
export function AgentNodeDetail({ taskId, nodeId, nodes }: AgentNodeDetailProps) {
  const { t } = useTranslation();
  const query = useAgentNode(taskId, nodeId);
  const detail = merged(query.data?.pages ?? []);
  // Ответ другого узла (переключение до прихода нового) не показывается за этот.
  const own = detail && detail.node.nodeId === nodeId ? detail : undefined;
  const now = useNow(own?.node.status === 'running');

  if (!own) {
    return (
      <Typography variant="body-sm" color="subtle" as="p" role="status">
        {query.isError ? t('agentTree.node.missing') : t('agentTree.node.loading')}
      </Typography>
    );
  }
  return (
    <AgentNodeDetailView
      detail={own}
      nodes={nodes}
      now={now}
      hasMore={Boolean(query.hasNextPage)}
      isFetchingMore={query.isFetchingNextPage}
      onMore={() => void query.fetchNextPage()}
    />
  );
}
