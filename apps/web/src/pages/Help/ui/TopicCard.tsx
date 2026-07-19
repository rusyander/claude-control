import { Link } from '@tanstack/react-router';
import { Card } from '@shared/ui/card';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Icon } from '@shared/ui/icon';
import { HELP_ROUTE } from '../model/topics';
import styles from './help-kit.module.scss';
import type { TopicCardProps } from './help-kit.types';

/**
 * Карточка раздела на главной странице справки. Ссылка обёрнута вокруг всей
 * карточки: попасть в неё мышью должно быть так же просто, как прочитать.
 */
export function TopicCard({ title, summary, icon, topicId }: TopicCardProps) {
  return (
    <Link to={HELP_ROUTE} search={{ topic: topicId }} className={styles.topicLink}>
      <Card padding="md" isInteractive>
        <Stack direction="row" gap="var(--spacing-sm)" align="start">
          <span className={styles.topicIcon}>
            <Icon name={icon} size={24} />
          </span>

          <Stack gap="var(--spacing-3xs)" minWidth={0} flex={1}>
            <Typography variant="body" weight="medium" as="span">
              {title}
            </Typography>
            <Typography variant="body-sm" color="muted" as="span" className={styles.topicSummary}>
              {summary}
            </Typography>
          </Stack>

          <Icon name="chevronRight" size={24} className={styles.topicChevron} />
        </Stack>
      </Card>
    </Link>
  );
}
