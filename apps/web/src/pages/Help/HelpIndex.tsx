import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Card } from '@shared/ui/card';
import { PageHeader } from '@shared/ui/page-header';
import { FlowDiagram } from '@shared/ui/diagram';
import { HELP_GROUPS } from './model/topics';
import { TopicCard, OptionCards } from './ui';
import styles from './HelpPage.module.scss';

/**
 * Главная страница справки: из чего состоит приложение и список разделов.
 *
 * Схема наверху отвечает на вопрос, который иначе всплывает в каждом разделе
 * по отдельности: где вообще живут настройки и почему изменения не видны сразу.
 */
export function HelpIndex() {
  const { t } = useTranslation();

  return (
    <Stack gap="var(--spacing-lg)" className={styles.page}>
      <PageHeader title={t('nav.help')} subtitle={t('help.index.subtitle')} />

      <Typography variant="body" color="muted" className={styles.lead}>
        {t('help.index.lead')}
      </Typography>

      <Card padding="md">
        <Stack gap="var(--spacing-sm)">
          <Typography variant="body" weight="medium">
            {t('help.index.howTitle')}
          </Typography>

          <FlowDiagram
            ariaLabel={t('help.index.howTitle')}
            edgeLabels={[t('help.index.howEdgeWrite'), t('help.index.howEdgeRestart')]}
            nodes={[
              {
                id: 'panel',
                label: t('help.index.howPanel'),
                caption: t('help.index.howPanelCaption'),
                tone: 'accent',
                icon: 'settings',
              },
              {
                id: 'files',
                label: t('help.index.howFiles'),
                caption: t('help.index.howFilesCaption'),
                icon: 'folder',
              },
              {
                id: 'claude',
                label: t('help.index.howClaude'),
                caption: t('help.index.howClaudeCaption'),
                tone: 'info',
                icon: 'chat',
              },
            ]}
          />

          <Typography variant="body-sm" color="muted" className={styles.lead}>
            {t('help.index.howCaption')}
          </Typography>
        </Stack>
      </Card>

      <Stack gap="var(--spacing-sm)">
        <Typography variant="heading-sm" as="h2">
          {t('help.index.helpTitle')}
        </Typography>

        <OptionCards
          items={[
            { title: t('help.index.helpButton'), text: t('help.index.helpButtonText') },
            { title: t('help.index.helpLink'), text: t('help.index.helpLinkText') },
            { title: t('help.index.helpNav'), text: t('help.index.helpNavText') },
            { title: t('help.index.helpAssistant'), text: t('help.index.helpAssistantText') },
          ]}
        />
      </Stack>

      <Stack gap="var(--spacing-sm)">
        <Stack gap="var(--spacing-3xs)">
          <Typography variant="heading-sm" as="h2">
            {t('help.index.sectionsTitle')}
          </Typography>
          <Typography variant="body-sm" color="muted">
            {t('help.index.sectionsCaption')}
          </Typography>
        </Stack>

        {HELP_GROUPS.map((group) => (
          <Stack key={group.labelKey} gap="var(--spacing-xs)">
            <Typography variant="caption" color="subtle" as="h3">
              {t(group.labelKey)}
            </Typography>

            <div className={styles.topicGrid}>
              {group.topics.map((topic) => (
                <TopicCard
                  key={topic.id}
                  topicId={topic.id}
                  icon={topic.icon}
                  title={t(`help.topics.${topic.id}.title`)}
                  summary={t(`help.topics.${topic.id}.summary`)}
                />
              ))}
            </div>
          </Stack>
        ))}
      </Stack>
    </Stack>
  );
}
