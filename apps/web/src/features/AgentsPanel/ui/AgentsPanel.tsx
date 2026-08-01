import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { Badge } from '@shared/ui/badge';
import { Toggle } from '@shared/ui/toggle';
import { useChatPrefs, MIN_SOUND_VOLUME, MAX_SOUND_VOLUME } from '@shared/lib/chat-prefs';
import { playNotification } from '@shared/lib/notify-sound';
import { formatSpend } from '@shared/lib/format';
import { worstTone } from '../lib/worstTone';
import { AgentRow } from './AgentRow';
import type { AgentsPanelProps } from './AgentsPanel.types';
import styles from './AgentsPanel.module.scss';

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
  const { sound, setSound, soundVolume, setSoundVolume } = useChatPrefs();

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

                {/* Громкость: базовый синтезированный сигнал слышно едва, поэтому
                    по умолчанию он усилен вдвое, а ползунок доводит до нужного.
                    Щелчок по проценту проигрывает пробу — подбирать на слух. */}
                {sound && (
                  <Stack
                    direction="row"
                    align="center"
                    gap="var(--spacing-3xs)"
                    title={t('agents.volumeHint')}
                  >
                    <input
                      type="range"
                      className={styles.volume}
                      min={MIN_SOUND_VOLUME}
                      max={MAX_SOUND_VOLUME}
                      step={0.25}
                      value={soundVolume}
                      aria-label={t('agents.volume')}
                      onChange={(event) => setSoundVolume(Number(event.target.value))}
                      onMouseUp={() => playNotification('waiting', soundVolume)}
                      onKeyUp={() => playNotification('waiting', soundVolume)}
                    />
                    <button
                      type="button"
                      className={styles.volumeValue}
                      onClick={() => playNotification('waiting', soundVolume)}
                      title={t('agents.volumeTest')}
                    >
                      {Math.round(soundVolume * 100)}%
                    </button>
                  </Stack>
                )}
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

            <Stack
              direction="row"
              align="center"
              justify="between"
              gap="var(--spacing-sm)"
              padding="var(--spacing-xs) var(--spacing-sm)"
              className={styles.foot}
            >
              <Typography variant="caption" color="subtle" as="span">
                {t('agents.total')}
              </Typography>
              <Typography variant="mono" as="span">
                {formatSpend(costUnit, totalTokens, totalCost)}
              </Typography>
            </Stack>
          </div>
        </>
      )}
    </div>
  );
}
