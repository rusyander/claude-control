import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { HelpSection, StorageCard, Callout, CapabilityGrid, OptionCards } from '../ui';

/** Документ раздела «История изменений» — лента правок конфигурации с диффом. */
export function HistoryTopic() {
  const { t } = useTranslation();
  const tr = (key: string): string => t(`help.topics.history.${key}`);

  return (
    <>
      <HelpSection title={t('help.common.whyTitle')}>
        <OptionCards
          items={[
            { title: tr('whyWhat'), text: tr('whyWhatText') },
            { title: tr('whyDiff'), text: tr('whyDiffText') },
            { title: tr('whyFree'), text: tr('whyFreeText') },
          ]}
        />
      </HelpSection>

      <HelpSection title={t('help.common.storageTitle')}>
        <StorageCard
          title={tr('title')}
          rows={[
            {
              label: tr('storageSource'),
              value: '~/.claude/claude-control/backups/',
              isMono: true,
            },
            { label: tr('storageTracked'), value: tr('storageTrackedValue') },
            { label: tr('storageSecrets'), value: '.mcp-secrets.env', isMono: true },
            { label: tr('storageDir'), value: tr('storageDirValue') },
          ]}
        />
      </HelpSection>

      <HelpSection title={`${t('help.common.canTitle')} · ${t('help.common.cantTitle')}`}>
        <CapabilityGrid
          canTitle={t('help.common.canTitle')}
          cantTitle={t('help.common.cantTitle')}
          can={[tr('canFeed'), tr('canDiff'), tr('canCounts'), tr('canOffline')]}
          cant={[tr('cantSecrets'), tr('cantRestore'), tr('cantBig')]}
        />
      </HelpSection>

      <HelpSection title={tr('notesTitle')}>
        <Stack gap="var(--spacing-xs)">
          <Callout tone="danger" title={tr('noteSecretTitle')}>
            {tr('noteSecretText')}
          </Callout>
          <Callout tone="info" title={tr('noteRestoreTitle')}>
            {tr('noteRestoreText')}
          </Callout>
          <Callout tone="info" title={tr('noteBigTitle')}>
            {tr('noteBigText')}
          </Callout>
        </Stack>
      </HelpSection>
    </>
  );
}
