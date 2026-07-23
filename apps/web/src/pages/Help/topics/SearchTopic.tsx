import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { HelpSection, StorageCard, Callout, CapabilityGrid, OptionCards } from '../ui';

/** Документ раздела «Поиск» — глобальный поиск по разделам конфигурации. */
export function SearchTopic() {
  const { t } = useTranslation();
  const tr = (key: string): string => t(`help.topics.search.${key}`);

  return (
    <>
      <HelpSection title={t('help.common.whyTitle')}>
        <OptionCards
          items={[
            { title: tr('whyOne'), text: tr('whyOneText') },
            { title: tr('whyCross'), text: tr('whyCrossText') },
            { title: tr('whySafe'), text: tr('whySafeText') },
          ]}
        />
      </HelpSection>

      <HelpSection title={t('help.common.storageTitle')}>
        <StorageCard
          title={tr('title')}
          rows={[
            { label: tr('storageWhere'), value: tr('storageWhereValue') },
            { label: tr('storageScope'), value: tr('storageScopeValue') },
            { label: tr('storageMin'), value: tr('storageMinValue') },
            { label: tr('storageSecrets'), value: tr('storageSecretsValue') },
          ]}
        />
      </HelpSection>

      <HelpSection title={`${t('help.common.canTitle')} · ${t('help.common.cantTitle')}`}>
        <CapabilityGrid
          canTitle={t('help.common.canTitle')}
          cantTitle={t('help.common.cantTitle')}
          can={[tr('canAll'), tr('canGrouped'), tr('canOpen'), tr('canLive')]}
          cant={[tr('cantBody'), tr('cantSecrets'), tr('cantEdit')]}
        />
      </HelpSection>

      <HelpSection title={tr('notesTitle')}>
        <Stack gap="var(--spacing-xs)">
          <Callout tone="danger" title={tr('noteSecretTitle')}>
            {tr('noteSecretText')}
          </Callout>
          <Callout tone="info" title={tr('noteChatTitle')}>
            {tr('noteChatText')}
          </Callout>
        </Stack>
      </HelpSection>
    </>
  );
}
