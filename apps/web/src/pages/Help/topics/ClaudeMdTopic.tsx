import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { FlowDiagram } from '@shared/ui/diagram';
import { HelpSection, StorageCard, StepList, Callout, CapabilityGrid, OptionCards } from '../ui';

/**
 * Документ раздела «CLAUDE.md».
 *
 * Соседний документ «Правила» описывает тот же файл, разобранный на карточки,
 * поэтому здесь отдельным блоком объяснено, чем два раздела отличаются: без
 * этого читатель видит два способа править одно и то же и не знает, какой брать.
 */
export function ClaudeMdTopic() {
  const { t } = useTranslation();
  const tr = (key: string): string => t(`help.topics.claudeMd.${key}`);

  return (
    <>
      <HelpSection title={t('help.common.whyTitle')}>
        <OptionCards
          items={[
            { title: tr('whyWhole'), text: tr('whyWholeText') },
            { title: tr('whyRaw'), text: tr('whyRawText') },
            { title: tr('whyFast'), text: tr('whyFastText') },
          ]}
        />
      </HelpSection>

      <HelpSection title={t('help.common.storageTitle')}>
        <StorageCard
          title="CLAUDE.md"
          rows={[
            { label: tr('storageFile'), value: '~/.claude/CLAUDE.md', isMono: true },
            { label: tr('storageFormat'), value: tr('storageFormatValue') },
            { label: tr('storageReader'), value: tr('storageReaderValue') },
            {
              label: tr('storageBackup'),
              value: '~/.claude/claude-control/backups/',
              isMono: true,
            },
          ]}
        />
      </HelpSection>

      <HelpSection title={tr('flowTitle')} caption={tr('flowCaption')}>
        <FlowDiagram
          ariaLabel={tr('flowTitle')}
          edgeLabels={[tr('flowEdgeSave'), tr('flowEdgeWrite'), tr('flowEdgeRestart')]}
          nodes={[
            {
              id: 'editor',
              label: tr('flowEditor'),
              caption: tr('flowEditorCaption'),
              tone: 'accent',
              icon: 'edit',
            },
            {
              id: 'backup',
              label: tr('flowBackup'),
              caption: tr('flowBackupCaption'),
              tone: 'info',
              icon: 'copy',
            },
            {
              id: 'file',
              label: tr('flowFile'),
              caption: tr('flowFileCaption'),
              icon: 'file',
              isMono: true,
            },
            {
              id: 'session',
              label: tr('flowSession'),
              caption: tr('flowSessionCaption'),
              tone: 'success',
              icon: 'refresh',
            },
          ]}
        />
      </HelpSection>

      <HelpSection title={`${t('help.common.canTitle')} · ${t('help.common.cantTitle')}`}>
        <CapabilityGrid
          canTitle={t('help.common.canTitle')}
          cantTitle={t('help.common.cantTitle')}
          can={[
            tr('canSeeAll'),
            tr('canEditAnything'),
            tr('canOrder'),
            tr('canRevert'),
            tr('canFixParse'),
          ]}
          cant={[tr('cantProject'), tr('cantPreview'), tr('cantToggle'), tr('cantHistory')]}
        />
      </HelpSection>

      <HelpSection title={tr('pairTitle')} caption={tr('pairCaption')}>
        <OptionCards
          minWidth={320}
          items={[
            { title: tr('pairRules'), text: tr('pairRulesText') },
            { title: tr('pairFile'), text: tr('pairFileText') },
          ]}
        />
        <Callout tone="warning" title={tr('pairNoteTitle')}>
          {tr('pairNoteText')}
        </Callout>
      </HelpSection>

      <HelpSection title={tr('recipesTitle')}>
        <StepList
          steps={[
            { title: tr('recipe1'), text: tr('recipe1Text') },
            { title: tr('recipe2'), text: tr('recipe2Text') },
            { title: tr('recipe3'), text: tr('recipe3Text') },
            { title: tr('recipe4'), text: tr('recipe4Text') },
          ]}
        />
      </HelpSection>

      <HelpSection title={tr('notesTitle')}>
        <Stack gap="var(--spacing-xs)">
          <Callout tone="warning" title={tr('noteRestartTitle')}>
            {tr('noteRestartText')}
          </Callout>
          <Callout tone="danger" title={tr('noteDisabledTitle')}>
            {tr('noteDisabledText')}
          </Callout>
          <Callout tone="warning" title={tr('noteStaleTitle')}>
            {tr('noteStaleText')}
          </Callout>
          <Callout tone="info" title={tr('noteBackupTitle')}>
            {tr('noteBackupText')}
          </Callout>
          <Callout tone="success" title={tr('noteHeadingTitle')}>
            {tr('noteHeadingText')}
          </Callout>
          <Callout tone="info" title={tr('noteProviderTitle')}>
            {tr('noteProviderText')}
          </Callout>
        </Stack>
      </HelpSection>
    </>
  );
}
