import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { FlowDiagram } from '@shared/ui/diagram';
import { HelpSection, StorageCard, FieldTable, Callout, CapabilityGrid, OptionCards } from '../ui';

/** Документ раздела «Команды». */
export function CommandsTopic() {
  const { t } = useTranslation();
  const tr = (key: string): string => t(`help.topics.commands.${key}`);

  return (
    <>
      <HelpSection title={t('help.common.whyTitle')}>
        <OptionCards
          items={[
            { title: tr('whyOne'), text: tr('whyOneText') },
            { title: tr('whyWhose'), text: tr('whyWhoseText') },
            { title: tr('whyJump'), text: tr('whyJumpText') },
          ]}
        />
      </HelpSection>

      <HelpSection title={t('help.common.storageTitle')}>
        <StorageCard
          title={tr('title')}
          rows={[
            { label: tr('storageSkills'), value: '~/.claude/skills/<имя>/SKILL.md', isMono: true },
            { label: tr('storageFiles'), value: '~/.claude/commands/**/*.md', isMono: true },
            { label: tr('storagePlugins'), value: '~/.claude/plugins/', isMono: true },
            { label: tr('storageBuiltin'), value: tr('storageBuiltinValue') },
          ]}
        />
      </HelpSection>

      <HelpSection title={tr('flowTitle')} caption={tr('flowCaption')}>
        <FlowDiagram
          ariaLabel={tr('flowTitle')}
          nodes={[
            {
              id: 'disk',
              label: tr('flowDisk'),
              caption: tr('flowDiskCaption'),
              tone: 'accent',
              icon: 'folder',
            },
            {
              id: 'merge',
              label: tr('flowMerge'),
              caption: tr('flowMergeCaption'),
              tone: 'info',
              icon: 'commands',
            },
            {
              id: 'search',
              label: tr('flowSearch'),
              caption: tr('flowSearchCaption'),
              icon: 'search',
            },
            {
              id: 'open',
              label: tr('flowOpen'),
              caption: tr('flowOpenCaption'),
              tone: 'success',
              icon: 'edit',
            },
          ]}
        />
      </HelpSection>

      <HelpSection title={tr('sourcesTitle')}>
        <FieldTable
          caption={tr('sourcesCaption')}
          nameHeader={t('help.common.fieldName')}
          descriptionHeader={t('help.common.fieldPurpose')}
          rows={[
            { name: '/имя-скилла', description: tr('sourceSkill'), badge: tr('badgeSkill') },
            { name: '/папка:имя', description: tr('sourceCommand'), badge: tr('badgeCommand') },
            { name: '/плагин:имя', description: tr('sourcePlugin'), badge: tr('badgePlugin') },
            {
              name: '/help, /clear, …',
              description: tr('sourceBuiltin'),
              badge: tr('badgeBuiltin'),
            },
          ]}
        />
      </HelpSection>

      <HelpSection title={`${t('help.common.canTitle')} · ${t('help.common.cantTitle')}`}>
        <CapabilityGrid
          canTitle={t('help.common.canTitle')}
          cantTitle={t('help.common.cantTitle')}
          can={[
            tr('canList'),
            tr('canSearch'),
            tr('canFilter'),
            tr('canFamily'),
            tr('canOpen'),
            tr('canDisabled'),
            tr('canProvider'),
          ]}
          cant={[tr('cantEdit'), tr('cantRun'), tr('cantTranslate'), tr('cantFresh')]}
        />
      </HelpSection>

      <HelpSection title={tr('familyTitle')} caption={tr('familyCaption')}>
        <OptionCards
          minWidth={320}
          items={[
            { title: tr('familyPrefix'), text: tr('familyPrefixText') },
            { title: tr('familyOwner'), text: tr('familyOwnerText') },
          ]}
        />
      </HelpSection>

      <HelpSection title={tr('notesTitle')}>
        <Stack gap="var(--spacing-xs)">
          <Callout tone="info" title={tr('noteReadOnlyTitle')}>
            {tr('noteReadOnlyText')}
          </Callout>
          <Callout tone="info" title={tr('noteAutoTitle')}>
            {tr('noteAutoText')}
          </Callout>
          <Callout tone="warning" title={tr('noteBuiltinTitle')}>
            {tr('noteBuiltinText')}
          </Callout>
          <Callout tone="info" title={tr('noteDescTitle')}>
            {tr('noteDescText')}
          </Callout>
          <Callout tone="info" title={tr('noteProviderTitle')}>
            {tr('noteProviderText')}
          </Callout>
        </Stack>
      </HelpSection>
    </>
  );
}
