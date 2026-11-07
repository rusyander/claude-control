import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { Typography } from '@shared/ui/typography';
import { useCoreAgents } from '../../api/agentTreeApi';
import { findNode, NO_FILTERS } from '../../model/coreAgents';
import { AgentNodeDetail } from '../AgentHistory/AgentNodeDetail';
import styles from '../AgentHistory/AgentHistory.module.scss';
import type { AgentNodePaneProps } from './AgentNodePane.types';

/**
 * Узел ядра в правой колонке чата — открывают его строка «Плана агента» и переход из карточки
 * группы. Задачу узла находит список агентов чата (тот же кэш, что у кнопки «Агенты»); подробно —
 * то же, что в окне. Только чтение. Escape закрывает панель и возвращает фокус тому, кто её открыл.
 */
export function AgentNodePane({ chatId, agentId, onClose }: AgentNodePaneProps) {
  const { t } = useTranslation();
  const list = useCoreAgents(chatId, NO_FILTERS, false);
  const nodes = list.data?.nodes ?? [];
  const node = findNode(nodes, agentId);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      // Открытое окно поверх чата закрывается своим Escape, не панель под ним.
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const title = node?.briefExcerpt?.split('\n')[0] ?? t('agentTree.node.title');
  let body;
  if (node) body = <AgentNodeDetail taskId={node.taskId} nodeId={node.nodeId} nodes={nodes} />;
  else
    body = (
      <Typography variant="body-sm" color="subtle" as="p" role="status">
        {list.isLoading ? t('agentTree.node.loading') : t('agentTree.node.missing')}
      </Typography>
    );

  return (
    <section
      className={styles.pane}
      aria-label={t('agentTree.node.title')}
      data-agent-pane={agentId}
    >
      <div className={styles.paneHead}>
        <div>
          <Typography variant="body-sm" weight="medium" as="h2" className={styles.paneTitle}>
            {title}
          </Typography>
          <Typography variant="caption" color="subtle" as="span">
            {t('agentTree.node.readOnly')}
          </Typography>
        </div>
        <Button
          size="sm"
          variant="ghost"
          iconOnly
          icon={<Icon name="close" size={24} />}
          aria-label={t('common.close')}
          onClick={onClose}
        />
      </div>
      {body}
    </section>
  );
}
