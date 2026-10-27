import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MAIN_AGENT_ID } from '@agentdeck/contracts/agent-history';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { Badge } from '@shared/ui/badge';
import { formatTokens } from '@shared/lib/formatTokens';
import { useChatProgress } from '@entities/Chat';
import { useAgentTranscript } from '../../api/agentTreeApi';
import { shortModel } from '../../model/agentTree';
import { anomalyParts, repeatedReadsHint } from '../../model/agentHistory';
import { AgentStepRow } from './AgentStepRow';
import type { AgentTranscriptProps } from './AgentTranscript.types';
import styles from './AgentTranscript.module.scss';

/** Сколько шагов в одном окне хода. */
const PAGE = 200;

/**
 * Ход агента в правой колонке — как панель субагента у расширения VS Code:
 * задание и шаги по порядку, у каждого вызова время, длительность, размер
 * результата и отказ хука, у ответа модели — его расход. Главный агент сессии
 * (`MAIN_AGENT_ID`) открывается тем же видом. Длинный ход листается окнами с
 * точным «шаги a–b из M»; итоги сверху — по всему файлу, не по окну. Только
 * чтение. Escape закрывает панель и возвращает фокус тому, кто её открыл.
 */
export function AgentTranscript({ chatId, agentId, onClose }: AgentTranscriptProps) {
  const { t } = useTranslation();
  const isMain = agentId === MAIN_AGENT_ID;
  // Окно: `undefined` — последние шаги (едет за идущим агентом), число — с этого шага.
  const [start, setStart] = useState<number | undefined>();
  // Прогресс разговора уже в кэше — из него видно, идёт ли агент.
  const progress = useChatProgress(chatId, false);
  const node = isMain ? undefined : progress.data?.agents.find((a) => a.agentId === agentId);
  const running = isMain ? Boolean(progress.data?.processAlive) : node?.status === 'running';
  const stepWindow = start === undefined ? { limit: PAGE } : { limit: PAGE, start };
  const transcript = useAgentTranscript(
    chatId,
    agentId,
    stepWindow,
    running && start === undefined,
  );
  const data = transcript.data?.agentId === agentId ? transcript.data : undefined;

  useEffect(() => setStart(undefined), [agentId, chatId]);

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

  const paneTitle = isMain ? t('agentTree.pane.mainTitle') : t('agentTree.pane.title');
  const title = isMain ? paneTitle : (data?.description ?? node?.description ?? paneTitle);
  const kind = data?.kind ?? node?.kind;
  const model = shortModel(data?.model ?? node?.model);
  const first = data?.start ?? 0;
  const shownEnd = first + (data?.steps.length ?? 0);
  const anomalies = anomalyParts(data?.anomalies, t);
  const tokens = data?.tokens;

  return (
    <section className={styles.panel} aria-label={paneTitle} data-agent-pane={agentId}>
      <Stack
        direction="row"
        align="center"
        justify="between"
        gap="var(--spacing-sm)"
        className={styles.header}
      >
        <Stack gap="var(--spacing-3xs)" className={styles.heading}>
          <Typography variant="body-sm" weight="medium" as="h2" className={styles.title}>
            {title}
          </Typography>
          <Stack direction="row" align="center" gap="var(--spacing-2xs)" wrap>
            {kind && <Badge tone="neutral">{kind}</Badge>}
            {model && <Badge tone="info">{model}</Badge>}
            <Typography variant="caption" color="subtle" as="span">
              {isMain ? t('agentTree.pane.mainReadOnly') : t('agentTree.pane.readOnly')}
            </Typography>
          </Stack>
        </Stack>
        <Button
          size="sm"
          variant="ghost"
          iconOnly
          icon={<Icon name="close" size={24} />}
          aria-label={t('common.close')}
          onClick={onClose}
        />
      </Stack>

      <div className={styles.body}>
        {transcript.isError && !data && (
          <Typography variant="body-sm" color="subtle" as="p" className={styles.note}>
            {t('agentTree.pane.missing')}
          </Typography>
        )}
        {data && tokens && (
          <Typography
            variant="caption"
            color="subtle"
            as="p"
            className={styles.totals}
            data-agent-pane-totals
          >
            {t('agentTree.pane.totals', {
              calls: data.toolCalls ?? 0,
              input: formatTokens(tokens.input),
              cacheRead: formatTokens(tokens.cacheRead),
              cacheCreation: formatTokens(tokens.cacheCreation),
              output: formatTokens(tokens.output),
            })}
          </Typography>
        )}
        {anomalies.length > 0 && (
          <Typography
            variant="caption"
            as="p"
            className={styles.denial}
            title={repeatedReadsHint(data?.anomalies, t)}
            data-agent-pane-anomalies
          >
            {anomalies.join(' · ')}
          </Typography>
        )}
        {data?.prompt && (
          <details className={styles.prompt} open={!isMain}>
            <summary>{t('agentTree.pane.prompt')}</summary>
            <p className={styles.promptText}>{data.prompt}</p>
          </details>
        )}
        {data && (
          <>
            <Stack direction="row" align="center" justify="between" className={styles.stepsHead}>
              <Typography variant="caption" color="subtle" as="span">
                {t('agentTree.pane.steps')}
              </Typography>
              {data.steps.length < data.total && (
                <Typography variant="caption" color="subtle" as="span" data-agent-pane-window>
                  {t('agentTree.pane.window', {
                    from: first + 1,
                    to: shownEnd,
                    total: data.total,
                  })}
                </Typography>
              )}
            </Stack>
            {first > 0 && !data.hasMore && (
              <Typography variant="caption" color="subtle" as="p" className={styles.note}>
                {t('agentTree.pane.dropped', { count: first })}
              </Typography>
            )}
            {(data.hasMore || start !== undefined) && (
              <div className={styles.paging}>
                {data.hasMore && (
                  <Button
                    size="sm"
                    variant="secondary"
                    isLoading={transcript.isFetching}
                    onClick={() => setStart(Math.max(0, first - PAGE))}
                  >
                    {t('agentTree.pane.earlier')}
                  </Button>
                )}
                {start !== undefined && shownEnd < data.total && (
                  <Button size="sm" variant="secondary" onClick={() => setStart(shownEnd)}>
                    {t('agentTree.pane.later')}
                  </Button>
                )}
                {start !== undefined && (
                  <Button size="sm" variant="ghost" onClick={() => setStart(undefined)}>
                    {t('agentTree.pane.latest')}
                  </Button>
                )}
              </div>
            )}
            {data.steps.length === 0 ? (
              <Typography variant="body-sm" color="subtle" as="p" className={styles.note}>
                {t('agentTree.pane.empty')}
              </Typography>
            ) : (
              <ol className={styles.steps} start={first + 1}>
                {data.steps.map((step, index) => (
                  <AgentStepRow key={`${first + index}`} step={step} />
                ))}
              </ol>
            )}
          </>
        )}
      </div>
    </section>
  );
}
