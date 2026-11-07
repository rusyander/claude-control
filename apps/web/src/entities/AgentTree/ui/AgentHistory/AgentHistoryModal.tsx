import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal } from '@shared/ui/modal';
import { Button } from '@shared/ui/button';
import { Typography } from '@shared/ui/typography';
import { toast } from '@shared/lib/toast';
import { exportChatAgents, useChatGroups, useCoreAgents } from '../../api/agentTreeApi';
import { buildCoreTree, modelsOf, NO_FILTERS, ownerPool, taskIdsOf } from '../../model/coreAgents';
import type { AgentFilters } from '../../model/coreAgents.types';
import { AgentFiltersBar } from './AgentFiltersBar';
import { AgentNodeDetail } from './AgentNodeDetail';
import { AgentNodeList } from './AgentNodeList';
import type { AgentHistoryModalProps, NodePick } from './AgentHistory.types';
import styles from './AgentHistory.module.scss';

/**
 * Окно «Агенты»: слева фильтры и дерево узлов всех задач чата, справа выбранный узел подробно
 * (фоновая работа — своим видом). Всё — свёртка журнала ядра, отбор по фильтрам делает ядро.
 * «Выгрузить» — строки журнала об агентах каждой задачи чата одним файлом.
 */
export function AgentHistoryModal({
  chatId,
  isOpen,
  onOpenChange,
  isRunning,
}: AgentHistoryModalProps) {
  const { t } = useTranslation();
  const [filters, setFilters] = useState<AgentFilters>(NO_FILTERS);
  const [picked, setPicked] = useState<NodePick | undefined>();
  const [exporting, setExporting] = useState(false);
  const all = useCoreAgents(isOpen ? chatId : undefined, NO_FILTERS, isRunning);
  const filtered = useCoreAgents(isOpen ? chatId : undefined, filters, isRunning);
  const allNodes = useMemo(() => all.data?.nodes ?? [], [all.data]);
  const nodes = filtered.data?.nodes;
  const roots = useMemo(() => buildCoreTree(nodes ?? []), [nodes]);
  const owners = useMemo(() => ownerPool(allNodes, nodes), [allNodes, nodes]);
  const taskIds = useMemo(() => taskIdsOf(allNodes), [allNodes]);
  const groups = useChatGroups(taskIds, isOpen);
  const now = Date.now();

  useEffect(() => {
    if (isOpen) return;
    setPicked(undefined);
    setFilters(NO_FILTERS);
  }, [isOpen]);

  const onExport = async (): Promise<void> => {
    setExporting(true);
    try {
      await exportChatAgents(chatId, taskIds);
    } catch (error) {
      toast.error(
        t('agentTree.history.exportFailed', {
          reason: error instanceof Error ? error.message : String(error),
        }),
      );
    } finally {
      setExporting(false);
    }
  };

  let list;
  if (filtered.isError && !nodes) list = t('agentTree.history.error');
  else if (!nodes) list = t('agentTree.history.loading');
  else if (nodes.length === 0) list = t('agentTree.history.empty');

  return (
    <Modal
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      title={t('agentTree.history.title')}
      description={t('agentTree.history.summary', {
        count: allNodes.length,
        tasks: taskIds.length,
      })}
      size="xl"
      bodyFill
      headerActions={
        <Button
          size="sm"
          variant="secondary"
          isLoading={exporting}
          disabled={taskIds.length === 0}
          title={t('agentTree.history.exportHint')}
          onClick={() => void onExport()}
          data-agent-history-export
        >
          {t('agentTree.history.export')}
        </Button>
      }
    >
      <div className={styles.layout} data-agent-history-modal>
        <div className={styles.side}>
          <AgentFiltersBar
            filters={filters}
            onChange={setFilters}
            models={modelsOf(allNodes)}
            groups={groups}
          />
          {filtered.data?.truncated && (
            <Typography variant="caption" color="subtle" as="p">
              {t('agentTree.history.truncated')}
            </Typography>
          )}
          {list ? (
            <Typography variant="body-sm" color="subtle" as="p" role="status">
              {list}
            </Typography>
          ) : (
            <AgentNodeList roots={roots} picked={picked} onPick={setPicked} now={now} />
          )}
        </div>
        <div className={styles.main}>
          {picked ? (
            <AgentNodeDetail taskId={picked.taskId} nodeId={picked.nodeId} nodes={owners} />
          ) : (
            <Typography variant="body-sm" color="subtle" as="p" className={styles.pick}>
              {t('agentTree.history.pick')}
            </Typography>
          )}
        </div>
      </div>
    </Modal>
  );
}
