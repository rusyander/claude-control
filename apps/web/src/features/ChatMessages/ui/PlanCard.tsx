import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Icon } from '@shared/ui/icon';
import { renderMarkdown } from '@shared/lib/markdown/renderMarkdown';
import type { PlanCardProps } from './PlanCard.types';
import styles from './ReviewCard.module.scss';
import feed from './ChatMessages.module.scss';

/**
 * План группы (уровень 2, Т1): что именно уедет в задание работы.
 *
 * Карточка, а не блок кода: план — markdown со списком шагов, и читать его
 * нужно как текст. Кнопок нет — работа по нему стартует сама, — но рамка
 * говорит человеку, что этот текст панель ПРИНЯЛА: всё вне блока в задание не
 * попадёт.
 */
export function PlanCard({ plan }: PlanCardProps) {
  const { t } = useTranslation();

  return (
    <div className={styles.card} data-plan-card>
      <Stack direction="row" align="center" gap="var(--spacing-2xs)" className={styles.head}>
        <Icon name="check" size={18} />
        <Typography variant="body-sm" weight="medium" as="span">
          {t('chat.cascade.plan.title')}
        </Typography>
      </Stack>
      <div
        className={feed.text}
        // Тот же рендер, что у реплик: markdown-it с выключенным сырым html.
        dangerouslySetInnerHTML={{ __html: renderMarkdown(plan) }}
      />
    </div>
  );
}
