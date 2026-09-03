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
 * Документ раздела «Правила».
 *
 * Порядок блоков одинаков во всех документах справки: где лежит → как
 * работает → поля → что делает помощник → как проверить → грабли. Читатель,
 * открывший второй документ, уже знает, где искать нужное.
 */
export function RulesTopic() {
  const { t } = useTranslation();
  // Ключи этого документа лежат под своим префиксом — короткий хелпер
  // избавляет от него в каждой строке.
  const tr = (key: string): string => t(`help.topics.rules.${key}`);

  const modes = [
    { title: tr('modeSimple'), text: tr('modeSimpleText') },
    { title: tr('modeBuilder'), text: tr('modeBuilderText') },
    { title: tr('modeBulk'), text: tr('modeBulkText') },
  ];

  return (
    <>
      <HelpSection title={t('help.common.whyTitle')}>
        <OptionCards
          items={[
            { title: tr('whyRepeat'), text: tr('whyRepeatText') },
            { title: tr('whyEverywhere'), text: tr('whyEverywhereText') },
            { title: tr('whyVisible'), text: tr('whyVisibleText') },
          ]}
        />
      </HelpSection>

      <HelpSection title={t('help.common.storageTitle')}>
        <StorageCard
          title="CLAUDE.md"
          rows={[
            { label: tr('storageFile'), value: '~/.claude/CLAUDE.md', isMono: true },
            { label: tr('storageUnit'), value: tr('storageUnitValue') },
            { label: tr('storageReader'), value: tr('storageReaderValue') },
            {
              label: tr('storageBackup'),
              value: '~/.claude/claude-control/backups/',
              isMono: true,
            },
          ]}
        />
      </HelpSection>

      {/* Формат заголовка — контракт панели (contracts/rule-format). Ровно на него
          опирается объясняющая заглушка «0 правил» на странице раздела, и сюда она
          ведёт ссылкой, поэтому раздел стоит раньше схемы: читатель приходит
          именно за этим. */}
      <HelpSection title={tr('formatTitle')} caption={tr('formatCaption')}>
        <OptionCards
          items={[
            { title: tr('formatRule'), text: tr('formatRuleText') },
            { title: tr('formatPlain'), text: tr('formatPlainText') },
          ]}
        />
        <Callout tone="info" title={tr('formatZero')}>
          {tr('formatZeroText')}
        </Callout>
      </HelpSection>

      <HelpSection title={tr('flowTitle')} caption={tr('flowCaption')}>
        <FlowDiagram
          ariaLabel={tr('flowTitle')}
          edgeLabels={[tr('flowEdgeSave'), tr('flowEdgeRestart'), tr('flowEdgeAlways')]}
          nodes={[
            {
              id: 'form',
              label: tr('flowForm'),
              caption: tr('flowFormCaption'),
              tone: 'accent',
              icon: 'edit',
            },
            {
              id: 'file',
              label: tr('flowFile'),
              caption: tr('flowFileCaption'),
              icon: 'file',
              isMono: true,
            },
            {
              id: 'start',
              label: tr('flowStart'),
              caption: tr('flowStartCaption'),
              tone: 'info',
              icon: 'refresh',
            },
            {
              id: 'answer',
              label: tr('flowAnswer'),
              caption: tr('flowAnswerCaption'),
              tone: 'success',
              icon: 'check',
            },
          ]}
        />
      </HelpSection>

      <HelpSection title={`${t('help.common.canTitle')} · ${t('help.common.cantTitle')}`}>
        <CapabilityGrid
          canTitle={t('help.common.canTitle')}
          cantTitle={t('help.common.cantTitle')}
          can={[
            tr('canWrite'),
            tr('canToggle'),
            tr('canSearch'),
            tr('canSandbox'),
            tr('canGroup'),
            tr('canEditByHand'),
          ]}
          cant={[tr('cantProject'), tr('cantPriority'), tr('cantHistory'), tr('cantForce')]}
        />
      </HelpSection>

      <HelpSection title={tr('modesTitle')} caption={tr('modesCaption')}>
        <OptionCards items={modes} />
        <Callout tone="info" title={tr('modesNote')} />
      </HelpSection>

      <HelpSection title={tr('fieldsTitle')}>
        <FieldTable
          caption={tr('fieldsCaption')}
          nameHeader={t('help.common.fieldName')}
          descriptionHeader={t('help.common.fieldPurpose')}
          rows={[
            {
              name: 'title',
              description: tr('fieldTitle'),
              badge: t('help.common.required'),
              badgeTone: 'accent',
            },
            {
              name: 'body',
              description: tr('fieldBody'),
              badge: t('help.common.required'),
              badgeTone: 'accent',
            },
            { name: 'isEnabled', description: tr('fieldEnabled') },
            { name: 'groupIds', description: tr('fieldGroups') },
          ]}
        />
      </HelpSection>

      <HelpSection title={tr('offTitle')} caption={tr('offCaption')}>
        <FlowDiagram
          ariaLabel={tr('offTitle')}
          nodes={[
            {
              id: 'toggle',
              label: tr('offToggle'),
              caption: tr('offToggleCaption'),
              tone: 'warning',
              icon: 'close',
            },
            {
              id: 'section',
              label: tr('offSection'),
              caption: tr('offSectionCaption'),
              icon: 'file',
              isMono: true,
            },
            {
              id: 'result',
              label: tr('offResult'),
              caption: tr('offResultCaption'),
              tone: 'info',
              icon: 'eyeOff',
            },
          ]}
        />
      </HelpSection>

      <HelpSection title={tr('assistantTitle')} caption={tr('assistantCaption')}>
        <FlowDiagram
          ariaLabel={tr('assistantTitle')}
          nodes={[
            {
              id: 'ask',
              label: tr('assistantAsk'),
              caption: tr('assistantAskCaption'),
              tone: 'accent',
              icon: 'chat',
            },
            {
              id: 'run',
              label: tr('assistantRun'),
              caption: tr('assistantRunCaption'),
              tone: 'info',
              icon: 'send',
            },
            {
              id: 'reply',
              label: tr('assistantReply'),
              caption: tr('assistantReplyCaption'),
              icon: 'file',
            },
            {
              id: 'fill',
              label: tr('assistantFill'),
              caption: tr('assistantFillCaption'),
              tone: 'success',
              icon: 'check',
            },
          ]}
        />

        <StepList
          steps={[
            { title: tr('assistantStep1'), text: tr('assistantStep1Text') },
            { title: tr('assistantStep2'), text: tr('assistantStep2Text') },
            { title: tr('assistantStep3'), text: tr('assistantStep3Text') },
            { title: tr('assistantStep4'), text: tr('assistantStep4Text') },
          ]}
        />

        <Stack gap="var(--spacing-xs)">
          <Callout tone="success" title={tr('assistantKeyTitle')}>
            {tr('assistantKeyText')}
          </Callout>
          <Callout tone="info" title={tr('assistantMemoryTitle')}>
            {tr('assistantMemoryText')}
          </Callout>
        </Stack>
      </HelpSection>

      <HelpSection title={tr('checkTitle')} caption={tr('checkCaption')}>
        <StepList
          steps={[
            { title: tr('checkStep1'), text: tr('checkStep1Text') },
            { title: tr('checkStep2'), text: tr('checkStep2Text') },
            { title: tr('checkStep3'), text: tr('checkStep3Text') },
          ]}
        />
      </HelpSection>

      <HelpSection title={tr('notesTitle')}>
        <Stack gap="var(--spacing-xs)">
          <Callout tone="warning" title={tr('noteRestartTitle')}>
            {tr('noteRestartText')}
          </Callout>
          <Callout tone="warning" title={tr('noteRenameTitle')}>
            {tr('noteRenameText')}
          </Callout>
          <Callout tone="info" title={tr('noteDuplicateTitle')}>
            {tr('noteDuplicateText')}
          </Callout>
          <Callout tone="danger" title={tr('noteDeleteTitle')}>
            {tr('noteDeleteText')}
          </Callout>
          <Callout tone="info" title={tr('noteWordingTitle')}>
            {tr('noteWordingText')}
          </Callout>
        </Stack>
      </HelpSection>
    </>
  );
}
