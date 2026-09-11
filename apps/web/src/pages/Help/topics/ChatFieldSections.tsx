import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { FlowDiagram } from '@shared/ui/diagram';
import { HelpSection, FieldTable, Callout } from '../ui';

/**
 * Таблицы полей и состояний документа «Чат»: поле ввода, цветные точки, расход,
 * режим правок и возобновление сессии.
 *
 * Стоят они ПОСЛЕ снимков и до ограничений: человек, прошедший путь по кадрам,
 * возвращается сюда за одним значением — что означает жёлтая точка, откуда
 * берётся «Σ» в расходе, — и ищет его в таблице, а не в абзаце.
 *
 * Вынесены из `ChatTopic` целиком: вместе они переваливали документ за предел
 * длины файла, а порядок разделов от этого не зависит.
 */
export function ChatFieldSections() {
  const { t } = useTranslation();
  const tr = (key: string): string => t(`help.topics.chat.${key}`);

  return (
    <>
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

      <HelpSection title={tr('dotsTitle')} caption={tr('dotsCaption')}>
        <FieldTable
          nameHeader={t('help.common.fieldName')}
          descriptionHeader={t('help.common.fieldPurpose')}
          rows={[
            { name: tr('dotGreen'), description: tr('dotGreenText'), isMono: false },
            { name: tr('dotGrey'), description: tr('dotGreyText'), isMono: false },
            { name: tr('dotYellow'), description: tr('dotYellowText'), isMono: false },
            { name: tr('dotRed'), description: tr('dotRedText'), isMono: false },
            { name: tr('dotNone'), description: tr('dotNoneText'), isMono: false },
          ]}
        />
      </HelpSection>

      <HelpSection title={tr('spendTitle')} caption={tr('spendCaption')}>
        <FieldTable
          nameHeader={t('help.common.fieldName')}
          descriptionHeader={t('help.common.fieldPurpose')}
          rows={[
            { name: tr('spendRun'), description: tr('spendRunText'), isMono: false },
            { name: tr('spendSession'), description: tr('spendSessionText'), isMono: false },
            { name: tr('spendLimit'), description: tr('spendLimitText'), isMono: false },
            { name: tr('spendStep'), description: tr('spendStepText'), isMono: false },
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

        <Callout tone="info" title={tr('autoApproveTitle')}>
          {tr('autoApproveText')}
        </Callout>

        <Callout tone="info" title={tr('rulesTitle')}>
          {tr('rulesText')}
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
    </>
  );
}
