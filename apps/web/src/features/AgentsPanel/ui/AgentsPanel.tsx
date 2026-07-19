import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { Badge } from '@shared/ui/badge';
import { Toggle } from '@shared/ui/toggle';
import { StatusDot } from '@shared/ui/status-dot';
import { statusTone, type ActiveRunView } from '@shared/lib/agent-runs';
import { useChatPrefs } from '@shared/lib/chat-prefs';
import { formatSpend } from '@shared/lib/format';
import type { AgentsPanelProps } from './AgentsPanel.types';
import styles from './AgentsPanel.module.scss';

/** Короткое имя проекта из пути. */
function projectName(path: string | undefined, fallback: string): string {
  if (!path) return fallback;
  return path.split(/[\\/]/).filter(Boolean).pop() || path;
}

/**
 * Пульт агентов: сколько сейчас работает, что каждый делает, сколько всё это
 * стоило. Из одного места видно всех агентов по проектам, можно перейти к любому
 * или остановить как одного, так и всех разом.
 */
export function AgentsPanel({
  activeRuns,
  totalCost,
  totalTokens,
  costUnit,
  onStop,
  onStopAll,
  onView,
}: AgentsPanelProps) {
  const { t } = useTranslation();
  const [isOpen, setOpen] = useState(false);
  const { sound, setSound } = useChatPrefs();

  const running = activeRuns.filter((run) => run.status === 'running').length;
  const worst = worstTone(activeRuns);

  return (
    <div className={styles.wrap}>
      <Button
        variant="ghost"
        size="sm"
        leftIcon={<Icon name="analytics" size={20} />}
        onClick={() => setOpen((value) => !value)}
        aria-expanded={isOpen}
      >
        {t('agents.title')}
        {activeRuns.length > 0 && (
          <Badge tone={worst}>{running > 0 ? running : activeRuns.length}</Badge>
        )}
      </Button>

      {isOpen && (
        <>
          <div className={styles.backdrop} onClick={() => setOpen(false)} aria-hidden="true" />
          <div className={styles.panel} role="dialog" aria-label={t('agents.title')}>
            <Stack
              direction="row"
              align="center"
              justify="between"
              gap="var(--spacing-sm)"
              className={styles.head}
            >
              <Stack direction="row" align="center" gap="var(--spacing-sm)">
                <Typography variant="body-sm" weight="medium">
                  {t('agents.active', { count: activeRuns.length })}
                </Typography>
                {/* Звук уведомлений: слышно, когда агент ждёт ответа или упал. */}
                <Stack
                  as="label"
                  direction="row"
                  align="center"
                  gap="var(--spacing-3xs)"
                  title={t('agents.soundHint')}
                >
                  <Toggle
                    size="sm"
                    checked={sound}
                    onCheckedChange={setSound}
                    aria-label={t('agents.sound')}
                  />
                  <Typography variant="caption" color="subtle" as="span">
                    {t('agents.sound')}
                  </Typography>
                </Stack>
              </Stack>
              {activeRuns.length > 0 && (
                <Button variant="danger" size="sm" onClick={onStopAll}>
                  {t('agents.stopAll')}
                </Button>
              )}
            </Stack>

            <div className={styles.list}>
              {activeRuns.length === 0 && (
                <Typography variant="body-sm" color="subtle" className={styles.empty}>
                  {t('agents.empty')}
                </Typography>
              )}

              {activeRuns.map((run) => (
                <AgentRow
                  key={run.id}
                  run={run}
                  costUnit={costUnit}
                  onOpen={() => onView(run)}
                  onStop={() => onStop(run.id)}
                  statusLabel={t(`workspace.status.${run.status}`)}
                  chatLabel={t('agents.chat')}
                />
              ))}
            </div>

            <div className={styles.foot}>
              <Typography variant="caption" color="subtle" as="span">
                {t('agents.total')}
              </Typography>
              <Typography variant="mono" as="span">
                {formatSpend(costUnit, totalTokens, totalCost)}
              </Typography>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

interface AgentRowProps {
  run: ActiveRunView;
  costUnit: 'tokens' | 'money';
  statusLabel: string;
  chatLabel: string;
  onOpen: () => void;
  onStop: () => void;
}

function AgentRow({ run, costUnit, statusLabel, chatLabel, onOpen, onStop }: AgentRowProps) {
  const { t } = useTranslation();
  const spent =
    run.tokens || run.costUsd ? formatSpend(costUnit, run.tokens ?? 0, run.costUsd ?? 0) : '';

  return (
    <div className={styles.row}>
      <button type="button" className={styles.rowMain} onClick={onOpen} title={run.projectPath}>
        {/* Все активные прогоны пульсируют: работает — виден, ждёт/упал — зовёт. */}
        <StatusDot tone={statusTone(run.status)} pulse />

        <Stack gap="0" className={styles.rowText}>
          <Typography variant="body-sm" as="span" truncate>
            {projectName(run.projectPath, chatLabel)}
          </Typography>
          <Typography variant="caption" color="subtle" as="span">
            {statusLabel}
            {spent ? ` · ${spent}` : ''}
          </Typography>
        </Stack>
      </button>
      <Button
        variant="ghost"
        size="sm"
        iconOnly
        icon={<Icon name="stop" size={18} />}
        aria-label={t('chat.stop')}
        onClick={onStop}
      />
    </div>
  );
}

/** Самый тревожный тон среди активных — для бейджа-счётчика. */
function worstTone(runs: ActiveRunView[]): 'success' | 'warning' | 'danger' | 'neutral' {
  if (runs.some((run) => run.status === 'error')) return 'danger';
  if (runs.some((run) => run.status === 'waiting')) return 'warning';
  if (runs.some((run) => run.status === 'running')) return 'success';
  return 'neutral';
}
