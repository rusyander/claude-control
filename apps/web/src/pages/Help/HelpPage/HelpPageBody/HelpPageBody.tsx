import { useTranslation } from 'react-i18next';
import { useSearch, Link } from '@tanstack/react-router';
import { findHelpTopic, HELP_ROUTE } from '../../model/topics';
import { useHelpDictionary } from '@shared/config/i18n';
import { SkeletonList } from '@shared/ui/skeleton';
import { HelpTopicView } from '../../HelpTopicView/HelpTopicView';
import { Stack } from '@shared/ui/stack';
import styles from './HelpPageBody.module.scss';
import { PageHeader } from '@shared/ui/page-header';
import { Card } from '@shared/ui/card';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { HelpIndex } from '../../HelpIndex/HelpIndex';

export function HelpPageBody() {
  const { t } = useTranslation();
  const { topic: topicId } = useSearch({ strict: false }) as { topic?: string };
  const topic = findHelpTopic(topicId);
  // Первый заход словарь получает от лоадера маршрута; хук дотягивает его при
  // смене языка на открытой странице. Без словаря рисовать нечего — скелет.
  const ready = useHelpDictionary();

  if (!ready) return <SkeletonList rows={4} withActions={false} />;
  if (topic) return <HelpTopicView topic={topic} />;

  // Ссылка на несуществующий раздел — не пустой экран: показываем, что
  // произошло, и возвращаем к списку.
  if (topicId) {
    return (
      <Stack gap="var(--spacing-lg)" className={styles.page}>
        <PageHeader title={t('nav.help')} subtitle={t('help.index.subtitle')} />

        <Card padding="md">
          <Stack gap="var(--spacing-sm)" align="start">
            <Typography variant="body" weight="medium">
              {t('help.index.notFoundTitle')}
            </Typography>
            <Typography variant="body-sm" color="muted">
              {t('help.index.notFoundText')}
            </Typography>
            <Link to={HELP_ROUTE}>
              <Button variant="secondary">{t('help.common.back')}</Button>
            </Link>
          </Stack>
        </Card>
      </Stack>
    );
  }

  return <HelpIndex />;
}
