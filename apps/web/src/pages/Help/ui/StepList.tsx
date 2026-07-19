import { Typography } from '@shared/ui/typography';
import styles from './help-kit.module.scss';
import type { StepListProps } from './help-kit.types';

/**
 * Пошаговый рецепт. Номер рисуется псевдоэлементом счётчика, а не текстом:
 * при вставке шага в середину нумерация не разъезжается, и скринридер
 * читает список как список, а не как «1 точка Открыть».
 */
export function StepList({ steps }: StepListProps) {
  return (
    <ol className={styles.steps}>
      {steps.map((step) => (
        <li key={step.title} className={styles.step}>
          <Typography variant="body-sm" weight="medium" as="span" className={styles.stepTitle}>
            {step.title}
          </Typography>
          {step.text && (
            <Typography variant="body-sm" color="muted" as="span" className={styles.stepText}>
              {step.text}
            </Typography>
          )}
        </li>
      ))}
    </ol>
  );
}
