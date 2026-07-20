import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { FlowDiagram } from '@shared/ui/diagram';
import {
  HelpSection,
  StorageCard,
  FieldTable,
  StepList,
  Callout,
  CapabilityGrid,
  OptionCards,
} from '../ui';

/**
 * Документ раздела «Чат».
 *
 * Раздел самый большой в панели, поэтому и блоков здесь больше: кроме общего
 * скелета есть вкладки проектов, цветные точки, режим правок и продолжение
 * сессии — то, о чём спрашивают чаще всего.
 */
export function ChatTopic() {
  const { t } = useTranslation();
  const tr = (key: string): string => t(`help.topics.chat.${key}`);

  return (
    <>
      <HelpSection title={t('help.common.whyTitle')}>
        <OptionCards
          items={[
            { title: tr('whyParallel'), text: tr('whyParallelText') },
            { title: tr('whyHistory'), text: tr('whyHistoryText') },
            { title: tr('whyVisible'), text: tr('whyVisibleText') },
          ]}
        />
      </HelpSection>

      <HelpSection title={t('help.common.storageTitle')}>
        <StorageCard
          title={tr('title')}
          rows={[
            { label: tr('storageTranscripts'), value: tr('storageTranscriptsValue'), isMono: true },
            { label: tr('storageWhatRuns'), value: tr('storageWhatRunsValue'), isMono: true },
            { label: tr('storageSandbox'), value: tr('storageSandboxValue'), isMono: true },
            { label: tr('storageStream'), value: tr('storageStreamValue') },
          ]}
        />
      </HelpSection>

      <HelpSection title={tr('flowTitle')} caption={tr('flowCaption')}>
        <FlowDiagram
          ariaLabel={tr('flowTitle')}
          nodes={[
            {
              id: 'composer',
              label: tr('flowComposer'),
              caption: tr('flowComposerCaption'),
              tone: 'accent',
              icon: 'chat',
            },
            {
              id: 'server',
              label: tr('flowServer'),
              caption: tr('flowServerCaption'),
              icon: 'send',
              isMono: true,
            },
            {
              id: 'process',
              label: tr('flowProcess'),
              caption: tr('flowProcessCaption'),
              tone: 'info',
              icon: 'scripts',
            },
            {
              id: 'stream',
              label: tr('flowStream'),
              caption: tr('flowStreamCaption'),
              tone: 'success',
              icon: 'refresh',
            },
            {
              id: 'transcript',
              label: tr('flowTranscript'),
              caption: tr('flowTranscriptCaption'),
              icon: 'file',
            },
          ]}
        />
      </HelpSection>

      <HelpSection title={`${t('help.common.canTitle')} · ${t('help.common.cantTitle')}`}>
        <CapabilityGrid
          canTitle={t('help.common.canTitle')}
          cantTitle={t('help.common.cantTitle')}
          can={[
            tr('canParallel'),
            tr('canContinue'),
            tr('canFork'),
            tr('canAnswerButtons'),
            tr('canModel'),
            tr('canApprove'),
            tr('canOpenFolder'),
            tr('canAttach'),
            tr('canVoice'),
            tr('canStop'),
            tr('canRetry'),
            tr('canSpend'),
            tr('canEditor'),
          ]}
          cant={[tr('cantApprove'), tr('cantDelete'), tr('cantSearchInside')]}
        />
      </HelpSection>

      <HelpSection title={tr('tabsTitle')} caption={tr('tabsCaption')}>
        <OptionCards
          items={[
            { title: tr('tabHome'), text: tr('tabHomeText') },
            { title: tr('tabProject'), text: tr('tabProjectText') },
            { title: tr('tabAdd'), text: tr('tabAddText') },
          ]}
        />
        <Callout tone="info" title={tr('tabsNote')} />
      </HelpSection>

      <HelpSection title={tr('dotsTitle')} caption={tr('dotsCaption')}>
        <FieldTable
          nameHeader={t('help.common.fieldName')}
          descriptionHeader={t('help.common.fieldPurpose')}
          rows={[
            { name: tr('dotGreen'), description: tr('dotGreenText'), isMono: false },
            { name: tr('dotYellow'), description: tr('dotYellowText'), isMono: false },
            { name: tr('dotRed'), description: tr('dotRedText'), isMono: false },
            { name: tr('dotNone'), description: tr('dotNoneText'), isMono: false },
          ]}
        />
      </HelpSection>

      <HelpSection title={tr('panelTitle')}>
        <OptionCards
          minWidth={320}
          items={[
            { title: tr('panelAgents'), text: tr('panelAgentsText') },
            { title: tr('panelParallel'), text: tr('panelParallelText') },
          ]}
        />
        <Callout tone="info" title={tr('panelNote')} />
      </HelpSection>

      <HelpSection title={tr('composerTitle')}>
        <FieldTable
          nameHeader={t('help.common.fieldName')}
          descriptionHeader={t('help.common.fieldPurpose')}
          rows={[
            { name: tr('composerEnter'), description: tr('composerEnterText'), isMono: false },
            { name: tr('composerVoice'), description: tr('composerVoiceText'), isMono: false },
            { name: tr('composerFiles'), description: tr('composerFilesText'), isMono: false },
            { name: tr('composerChips'), description: tr('composerChipsText'), isMono: false },
            { name: tr('composerStop'), description: tr('composerStopText'), isMono: false },
          ]}
        />
      </HelpSection>

      <HelpSection title={tr('editsTitle')} caption={tr('editsCaption')}>
        <Stack gap="var(--spacing-sm)">
          <FlowDiagram
            ariaLabel={tr('editsOff')}
            nodes={[
              {
                id: 'off',
                label: tr('editsOff'),
                caption: tr('editsOffCaption'),
                tone: 'info',
                icon: 'eye',
              },
              {
                id: 'off-mode',
                label: tr('editsMode'),
                caption: tr('editsModeCaption'),
                isMono: true,
                icon: 'permissions',
              },
              {
                id: 'off-result',
                label: tr('editsResult'),
                caption: tr('editsResultCaption'),
                icon: 'close',
              },
            ]}
          />

          <FlowDiagram
            ariaLabel={tr('editsOn')}
            nodes={[
              {
                id: 'on',
                label: tr('editsOn'),
                caption: tr('editsOnCaption'),
                tone: 'warning',
                icon: 'edit',
              },
              {
                id: 'on-mode',
                label: tr('editsOnMode'),
                caption: tr('editsOnModeCaption'),
                isMono: true,
                icon: 'permissions',
              },
              {
                id: 'on-result',
                label: tr('editsOnResult'),
                caption: tr('editsOnResultCaption'),
                tone: 'success',
                icon: 'check',
              },
            ]}
          />
        </Stack>

        <Callout tone="warning" title={tr('editsResetTitle')}>
          {tr('editsResetText')}
        </Callout>
      </HelpSection>

      <HelpSection title={tr('historyTitle')} caption={tr('historyCaption')}>
        <FlowDiagram
          ariaLabel={tr('historyTitle')}
          nodes={[
            {
              id: 'id',
              label: tr('historyId'),
              caption: tr('historyIdCaption'),
              tone: 'accent',
              icon: 'link',
            },
            {
              id: 'resume',
              label: tr('historyResume'),
              caption: tr('historyResumeCaption'),
              isMono: true,
              icon: 'refresh',
            },
            {
              id: 'cwd',
              label: tr('historyCwd'),
              caption: tr('historyCwdCaption'),
              tone: 'info',
              icon: 'folder',
            },
          ]}
        />

        <Callout tone="warning" title={tr('historyFolderTitle')}>
          {tr('historyFolderText')}
        </Callout>
      </HelpSection>

      <HelpSection title={tr('retryTitle')} caption={tr('retryCaption')}>
        <OptionCards
          minWidth={320}
          items={[
            { title: tr('retryRepeat'), text: tr('retryRepeatText') },
            { title: tr('retryFull'), text: tr('retryFullText') },
          ]}
        />
        <Callout tone="danger" title={tr('retryNoteTitle')}>
          {tr('retryNoteText')}
        </Callout>
      </HelpSection>

      <HelpSection title={tr('spendTitle')} caption={tr('spendCaption')}>
        <FieldTable
          nameHeader={t('help.common.fieldName')}
          descriptionHeader={t('help.common.fieldPurpose')}
          rows={[
            { name: tr('spendRun'), description: tr('spendRunText'), isMono: false },
            { name: tr('spendSession'), description: tr('spendSessionText'), isMono: false },
            { name: tr('spendLimit'), description: tr('spendLimitText'), isMono: false },
          ]}
        />
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
          <Callout tone="warning" title={tr('noteTabTitle')}>
            {tr('noteTabText')}
          </Callout>
          <Callout tone="info" title={tr('noteQuestionTitle')}>
            {tr('noteQuestionText')}
          </Callout>
          <Callout tone="info" title={tr('noteArtifactsTitle')}>
            {tr('noteArtifactsText')}
          </Callout>
          <Callout tone="info" title={tr('noteLimitTitle')}>
            {tr('noteLimitText')}
          </Callout>
          <Callout tone="info" title={tr('noteMemoryTitle')}>
            {tr('noteMemoryText')}
          </Callout>
          <Callout tone="info" title={tr('noteHistoryTitle')}>
            {tr('noteHistoryText')}
          </Callout>
        </Stack>
      </HelpSection>
    </>
  );
}
