import { Link } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { PageHeader } from '@shared/ui/page-header';
import { HELP_ROUTE, findTopicNeighbours } from './model/topics';
import { TopicNav } from './ui';
import type { HelpTopicViewProps } from './HelpTopicView.types';
import styles from './HelpPage.module.scss';

/**
 * Оболочка документа: путь назад, заголовок, кнопка в сам раздел и вводный
 * абзац. Всё, что ниже, рисует компонент раздела — оболочка одинакова для
 * любого документа, поэтому её видом не приходится заниматься дважды.
 */
export function HelpTopicView({ topic }: HelpTopicViewProps) {
  const { t } = useTranslation();
  const { Content } = topic;
  const { prev, next } = findTopicNeighbours(topic.id);

  return (
    <Stack gap="var(--spacing-lg)" className={styles.page}>
      <Link to={HELP_ROUTE} className={styles.back}>
        <Icon name="chevronLeft" size={24} className={styles.backIcon} />
        <Typography variant="body-sm" as="span">
          {t('help.common.back')}
        </Typography>
      </Link>

      <PageHeader
        title={t(`help.topics.${topic.id}.title`)}
        actions={
          <Link to={topic.pagePath}>
            <Button variant="secondary" leftIcon={<Icon name={topic.icon} size={24} />}>
              {t('help.common.openSection')}
            </Button>
          </Link>
        }
      />

      <Typography variant="body" color="muted" className={styles.lead}>
        {t(`help.topics.${topic.id}.lead`)}
      </Typography>

      <div className={styles.topicBody}>
        <Content />

        <TopicNav
          prevLabel={t('help.common.prevTopic')}
          nextLabel={t('help.common.nextTopic')}
          prev={prev && { id: prev.id, title: t(`help.topics.${prev.id}.title`) }}
          next={next && { id: next.id, title: t(`help.topics.${next.id}.title`) }}
        />
      </div>
    </Stack>
  );
}
