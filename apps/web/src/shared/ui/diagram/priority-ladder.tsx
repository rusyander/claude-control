import { Typography } from '@shared/ui/typography';
import styles from './diagram.module.scss';
import type { PriorityLadderProps } from './diagram.types';

/**
 * Лестница приоритетов: кто кого перебивает. Ширина ступени убывает сверху
 * вниз — сила правила видна раньше, чем прочитан текст.
 *
 * Порядок здесь несёт смысл, поэтому список нумерованный, а убывание ширины
 * задаётся переменной --step: в разметке нет ни одного числа.
 */
export function PriorityLadder({
  steps,
  topLabel,
  bottomLabel,
  ariaLabel,
  className,
}: PriorityLadderProps) {
  return (
    <div className={[styles.ladder, className].filter(Boolean).join(' ')}>
      {topLabel && (
        <Typography variant="caption" color="subtle" className={styles.ladderEdgeLabel}>
          {topLabel}
        </Typography>
      )}

      <ol className={styles.ladderSteps} aria-label={ariaLabel}>
        {steps.map((step, index) => (
          <li
            key={step.id}
            className={`${styles.ladderStep} ${styles[`tone-${step.tone ?? 'neutral'}`]}`}
            style={{ '--step': `${index}`, '--steps': `${steps.length}` } as React.CSSProperties}
          >
            <span className={styles.ladderBar}>
              <Typography variant="mono" weight="medium" as="span">
                {step.label}
              </Typography>
            </span>
            {step.caption && (
              <Typography
                variant="body-sm"
                color="muted"
                as="span"
                className={styles.ladderCaption}
              >
                {step.caption}
              </Typography>
            )}
          </li>
        ))}
      </ol>

      {bottomLabel && (
        <Typography variant="caption" color="subtle" className={styles.ladderEdgeLabel}>
          {bottomLabel}
        </Typography>
      )}
    </div>
  );
}
