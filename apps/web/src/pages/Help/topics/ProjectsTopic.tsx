import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { HelpSection, StorageCard, FieldTable, Callout, CapabilityGrid, OptionCards } from '../ui';

/** Документ раздела «Проекты» — проектный уровень конфигурации. */
export function ProjectsTopic() {
  const { t } = useTranslation();
  const tr = (key: string): string => t(`help.topics.projects.${key}`);

  return (
    <>
      <HelpSection title={t('help.common.whyTitle')}>
        <OptionCards
          items={[
            { title: tr('whyLevel'), text: tr('whyLevelText') },
            { title: tr('whyAdditive'), text: tr('whyAdditiveText') },
            { title: tr('whySame'), text: tr('whySameText') },
          ]}
        />
      </HelpSection>

      <HelpSection title={t('help.common.storageTitle')}>
        <StorageCard
          title={tr('title')}
          rows={[
            { label: tr('storageRules'), value: '<проект>/CLAUDE.md', isMono: true },
            { label: tr('storageMcp'), value: '<проект>/.mcp.json', isMono: true },
            { label: tr('storagePerms'), value: '<проект>/.claude/settings.json', isMono: true },
            { label: tr('storageCreate'), value: tr('storageCreateValue') },
          ]}
        />
      </HelpSection>

      <HelpSection title={`${t('help.common.canTitle')} · ${t('help.common.cantTitle')}`}>
        <CapabilityGrid
          canTitle={t('help.common.canTitle')}
          cantTitle={t('help.common.cantTitle')}
          can={[tr('canRegister'), tr('canRules'), tr('canMcp'), tr('canPerms'), tr('canAdditive')]}
          cant={[tr('cantGroups'), tr('cantHooks'), tr('cantHealth')]}
        />
      </HelpSection>

      <HelpSection title={tr('fieldsTitle')}>
        <FieldTable
          nameHeader={t('help.common.fieldName')}
          descriptionHeader={t('help.common.fieldPurpose')}
          rows={[
            {
              name: 'path',
              description: tr('fieldPath'),
              badge: t('help.common.required'),
              badgeTone: 'accent',
            },
            { name: 'name', description: tr('fieldName') },
          ]}
        />
      </HelpSection>

      <HelpSection title={tr('notesTitle')}>
        <Stack gap="var(--spacing-xs)">
          <Callout tone="warning" title={tr('noteRawTitle')}>
            {tr('noteRawText')}
          </Callout>
          <Callout tone="info" title={tr('noteUserTitle')}>
            {tr('noteUserText')}
          </Callout>
          <Callout tone="info" title={tr('noteProviderTitle')}>
            {tr('noteProviderText')}
          </Callout>
        </Stack>
      </HelpSection>
    </>
  );
}
