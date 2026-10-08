import type { StepTextsProps } from '../StepDetailModal.types';
import { useTranslation } from 'react-i18next';
import { Fact } from '../Fact/Fact';
import { Typography } from '@shared/ui/typography';
import styles from './StepTexts.module.scss';

/** Обе стороны своего шага: русскую видит человек, английскую читает прогон. */
export function StepTexts({ step }: StepTextsProps) {
  const { t } = useTranslation();
  return (
    <>
      <Fact label={t('groupPath.detail.promptRu')}>
        <Typography variant="body-sm" as="span" lang="ru" className={styles.text}>
          {step.prompt.ru || t('groupPath.detail.noDescription')}
        </Typography>
      </Fact>
      <Fact label={t('groupPath.detail.promptEn')}>
        <Typography variant="body-sm" as="span" lang="en" className={styles.text}>
          {step.prompt.en || t('groupPath.detail.noDescription')}
        </Typography>
      </Fact>
      {/* Условие готовности — тоже обе стороны: прогон проверяет английское,
          а показывали только язык окна. */}
      {step.gate?.ru && (
        <Fact label={t('groupPath.detail.gateRu')}>
          <Typography variant="body-sm" as="span" lang="ru" className={styles.text}>
            {step.gate.ru}
          </Typography>
        </Fact>
      )}
      {step.gate?.en && (
        <Fact label={t('groupPath.detail.gateEn')}>
          <Typography variant="body-sm" as="span" lang="en" className={styles.text}>
            {step.gate.en}
          </Typography>
        </Fact>
      )}
    </>
  );
}
