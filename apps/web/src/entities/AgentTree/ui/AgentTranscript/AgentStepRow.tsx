import { useTranslation } from 'react-i18next';
import { Typography } from '@shared/ui/typography';
import { cn } from '@shared/lib/cn';
import { formatClock } from '@shared/lib/format-clock';
import { formatNumber } from '@shared/lib/formatNumber';
import { formatTokens } from '@shared/lib/formatTokens';
import { shortModel } from '../../model/agentTree';
import { callDuration } from '../../model/agentHistory';
import type { AgentStepRowProps } from './AgentTranscript.types';
import styles from './AgentTranscript.module.scss';

/**
 * Шаг агента: реплика, размышление или вызов с итогом. Вызов без итога — то,
 * чем агент занят прямо сейчас; итог с ошибкой — своим цветом, отказ хука —
 * своей меткой с причиной, чтобы упавший шаг находился глазом в длинном ходе.
 * У вызова — время, длительность и полный размер результата; у первого шага
 * ответа модели — расход этого ответа и модель.
 */
export function AgentStepRow({ step }: AgentStepRowProps) {
  const { t, i18n } = useTranslation();
  const clock = step.at ? formatClock(step.at, i18n.language) : '';
  const usage = step.usage;
  const turn = usage ? (
    <Typography variant="caption" color="subtle" as="p" className={styles.turn} data-step-turn>
      {t('agentTree.pane.turn', {
        input: formatTokens(usage.input),
        cacheRead: formatTokens(usage.cacheRead),
        cacheCreation: formatTokens(usage.cacheCreation),
        output: formatTokens(usage.output),
      })}
      {step.model ? ` · ${shortModel(step.model) ?? step.model}` : ''}
    </Typography>
  ) : null;

  if (step.kind === 'text' || step.kind === 'thinking') {
    return (
      <li className={styles.step} data-agent-step={step.kind}>
        {turn}
        {step.kind === 'text' ? (
          <Typography variant="body-sm" as="p" className={styles.text}>
            {clock && <span className={styles.clock}>{clock} </span>}
            {step.text}
          </Typography>
        ) : (
          <Typography variant="caption" color="subtle" as="p" className={styles.thinking}>
            {clock && <span className={styles.clock}>{clock} </span>}
            {t('agentTree.pane.thinking')}: {step.text}
          </Typography>
        )}
      </li>
    );
  }
  const open = step.result === undefined;
  const meta = [
    clock,
    step.durationMs !== undefined ? callDuration(step.durationMs, t) : '',
    step.resultChars !== undefined
      ? t('agentTree.pane.chars', { value: formatNumber(step.resultChars, i18n.language) })
      : '',
  ].filter(Boolean);
  return (
    <li
      className={cn(styles.step, styles.tool, step.isError && styles.toolError)}
      data-agent-step="tool"
      {...(step.denial !== undefined ? { 'data-step-denied': '' } : {})}
    >
      {turn}
      <div className={styles.call}>
        <span className={styles.toolName}>{step.name}</span>
        {step.summary && <span className={styles.summary}>{step.summary}</span>}
        {open && <span className={styles.badgeRunning}>{t('agentTree.pane.running')}</span>}
        {step.denial !== undefined ? (
          <span className={styles.badgeError}>{t('agentTree.pane.denied')}</span>
        ) : (
          step.isError && <span className={styles.badgeError}>{t('agentTree.pane.error')}</span>
        )}
      </div>
      {meta.length > 0 && (
        <Typography variant="caption" color="subtle" as="p" className={styles.meta} data-step-meta>
          {meta.join(' · ')}
        </Typography>
      )}
      {step.denial !== undefined && (
        <p className={styles.denial} data-step-denial>
          {step.denial}
        </p>
      )}
      {step.result && step.denial === undefined && (
        <pre className={styles.result}>{step.result}</pre>
      )}
    </li>
  );
}
