import { Typography } from '@shared/ui/typography';
import styles from './help-kit.module.scss';
import type { GuideStepProps, GuideStepsProps } from './help-kit.types';

/**
 * Путеводитель: шаги, у каждого из которых свой снимок экрана.
 *
 * Отличие от `StepList` — не в оформлении, а в объёме шага. Там шаг это одна
 * фраза в рецепте, который читают по диагонали; здесь шаг это кусок пути с
 * картинкой того, что человек увидит, и номер нужен, чтобы на него ссылались
 * словами («на шаге 5 ключ показан один раз»).
 *
 * Номер рисует счётчик CSS, а не текст: шаги в путеводителе делятся и
 * исчезают вместе со сценарием съёмки, и руками проставленная нумерация
 * разъехалась бы с первой же пересъёмкой.
 */
export function GuideSteps({ children }: GuideStepsProps) {
  return <ol className={styles.guideSteps}>{children}</ol>;
}

export function GuideStep({ title, text, children }: GuideStepProps) {
  return (
    <li className={styles.guideStep}>
      <Typography variant="body-sm" weight="medium" as="h3" className={styles.guideStepTitle}>
        {title}
      </Typography>
      {text && (
        <Typography variant="body-sm" color="muted" as="p" className={styles.guideStepText}>
          {text}
        </Typography>
      )}
      {children && <div className={styles.guideStepBody}>{children}</div>}
    </li>
  );
}
