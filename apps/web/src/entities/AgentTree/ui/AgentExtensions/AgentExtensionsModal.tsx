import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AgentExtensionSummary } from '@agentdeck/contracts';
import { Modal } from '@shared/ui/modal';
import { Typography } from '@shared/ui/typography';
import { cn } from '@shared/lib/cn';
import { useAgentExtensions } from '../../api/agentTreeApi';
import { extensionTotals } from '../../model/extensions';
import { ExtensionTimeline } from './ExtensionTimeline';
import type { AgentExtensionsModalProps } from './AgentExtensions.types';
import styles from './AgentExtensions.module.scss';

/**
 * Окно «Скиллы, хуки и MCP»: слева главный агент и субагенты разговора, справа
 * хронология выбранного тремя группами — что вызвал, что сработало, когда,
 * сколько шло и чем кончилось. Только чтение: источник — транскрипты CLI.
 */
export function AgentExtensionsModal({
  chatId,
  isOpen,
  onOpenChange,
  agents,
  mainSummary,
  initialAgentId,
  isRunning,
}: AgentExtensionsModalProps) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState<string | undefined>(initialAgentId);
  useEffect(() => {
    if (isOpen) setSelected(initialAgentId);
  }, [isOpen, initialAgentId]);
  const listed = agents.filter((agent) => agent.agentId);
  const query = useAgentExtensions(chatId, selected, isOpen, isRunning);

  const totalsLine = (summary: readonly AgentExtensionSummary[] | undefined): string => {
    const totals = extensionTotals(summary);
    const line = t('agentTree.extensions.totals', totals);
    return totals.denied > 0
      ? `${line} · ${t('agentTree.extensions.totalsDenied', { count: totals.denied })}`
      : line;
  };

  return (
    <Modal
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      title={t('agentTree.extensions.title')}
      size="lg"
      bodyFill
    >
      <div className={styles.layout} data-agent-extensions-modal>
        <nav className={styles.agents} aria-label={t('agentTree.extensions.agents')}>
          <ul className={styles.agentList}>
            <li>
              <button
                type="button"
                className={cn(styles.agent, selected === undefined && styles.agentSelected)}
                aria-pressed={selected === undefined}
                data-extensions-agent="main"
                onClick={() => setSelected(undefined)}
              >
                <Typography variant="body-sm" weight="medium" as="span">
                  {t('agentTree.extensions.main')}
                </Typography>
                <Typography variant="caption" color="subtle" as="span">
                  {totalsLine(mainSummary)}
                </Typography>
              </button>
            </li>
            {listed.map((agent) => (
              <li key={agent.id}>
                <button
                  type="button"
                  className={cn(styles.agent, selected === agent.agentId && styles.agentSelected)}
                  aria-pressed={selected === agent.agentId}
                  data-extensions-agent={agent.agentId}
                  onClick={() => setSelected(agent.agentId)}
                >
                  <Typography
                    variant="body-sm"
                    weight="medium"
                    as="span"
                    className={styles.agentName}
                  >
                    {agent.kind}: {agent.description}
                  </Typography>
                  <Typography variant="caption" color="subtle" as="span">
                    {totalsLine(agent.extensions)}
                  </Typography>
                </button>
              </li>
            ))}
          </ul>
        </nav>
        <div className={styles.timeline} data-extensions-timeline={selected ?? 'main'}>
          <ExtensionTimeline data={query.data} isLoading={query.isLoading} />
        </div>
      </div>
    </Modal>
  );
}
