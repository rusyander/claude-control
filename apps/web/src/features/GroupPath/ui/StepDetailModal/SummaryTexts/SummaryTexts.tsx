import type { SummaryTextsProps } from '../StepDetailModal.types';
import { useTranslation } from 'react-i18next';
import { Fact } from '../Fact/Fact';
import { Typography } from '@shared/ui/typography';
import styles from './SummaryTexts.module.scss';

/**
 * Краткое описание на обоих языках: русское видит человек, английское — то,
 * что знает о шаге модель. Язык интерфейса — первым.
 */
export function SummaryTexts({ summary }: SummaryTextsProps) {
  const { t, i18n } = useTranslation();
  const sides: ('ru' | 'en')[] = i18n.language.startsWith('en') ? ['en', 'ru'] : ['ru', 'en'];
  return (
    <>
      {sides.map((side) => (
        <Fact key={side} label={`${t('groupBuilder.detail.summary')} · ${side.toUpperCase()}`}>
          <Typography variant="body-sm" as="span" lang={side} className={styles.text}>
            {summary[side]}
          </Typography>
        </Fact>
      ))}
    </>
  );
}
