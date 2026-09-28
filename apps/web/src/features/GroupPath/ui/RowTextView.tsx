import { useTranslation } from 'react-i18next';
import { Typography } from '@shared/ui/typography';
import { useResourceSummary } from '@entities/Group';
import { firstParagraph } from '../model/skillText';
import { pickLang } from '../model/useEntryTitle';
import type { RowTextViewProps } from './RowTextView.types';
import styles from './RowTextView.module.scss';

/**
 * Описание строки порядка работы на языке интерфейса. Сводку ресурса
 * спрашивает только смонтированный вид — то есть показанная подсказка или
 * открытое окно шага: промах серверного кэша стоит вызова модели.
 */
export function RowTextView({ text, variant }: RowTextViewProps) {
  const { t, i18n } = useTranslation();
  const summary = useResourceSummary(
    text.kind === 'summary' ? text.type : 'skill',
    text.kind === 'summary' ? text.id : '',
    text.kind === 'summary',
    text.kind === 'summary' ? text.project : undefined,
  );

  let body = '';
  if (text.kind === 'stage') body = t(`groupPath.stageHint.${text.stage}`);
  if (text.kind === 'text') body = text.text;
  if (text.kind === 'summary' && summary.data) {
    const own = pickLang(summary.data, i18n.language);
    body = variant === 'hint' ? firstParagraph(own) : own;
  }
  const isReading = text.kind === 'summary' && summary.isLoading;
  const className = variant === 'full' ? styles.full : styles.hint;

  if (!body) {
    return (
      <Typography variant="caption" color="subtle" as="span" className={styles.fallback}>
        {isReading ? t('groupPath.hintReading') : t('groupPath.hintEmpty')}
      </Typography>
    );
  }
  return (
    <Typography
      variant={variant === 'full' ? 'body-sm' : 'caption'}
      as="span"
      className={className}
    >
      {body}
    </Typography>
  );
}
