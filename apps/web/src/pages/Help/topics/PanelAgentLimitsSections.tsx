import { HelpSection, StorageCard, FieldTable, Callout } from '../ui';
import { Stack } from '@shared/ui/stack';

interface SectionProps {
  /** Перевод ключа `help.topics.panelAgent.<key>`. */
  tr: (key: string) => string;
}

/**
 * Обязательные блоки документа «Агент панели»: чем он НЕ является, что пишет на
 * диске, пределы с тем, как отменить сделанное, отказы и подписанный компромисс.
 *
 * «Как отменить» стоит первой строкой пределов, а не отдельной оговоркой: вопрос
 * «а назад?» возникает у человека сразу после первого «Выполнить», и ответ
 * «откатывает История изменений — или агент карточкой» должен быть под рукой.
 */
export function PanelAgentLimitsSections({ tr }: SectionProps) {
  const row = (key: string) => ({ name: tr(key), description: tr(`${key}Text`), isMono: false });

  return (
    <>
      <HelpSection title={tr('notTitle')} caption={tr('notCaption')}>
        <FieldTable
          nameHeader={tr('notColumn')}
          descriptionHeader={tr('notMeaningColumn')}
          rows={[row('notChat'), row('notAssistant'), row('notAutopilot'), row('notKeys')]}
        />
      </HelpSection>

      <HelpSection title={tr('storageTitle')} caption={tr('storageCaption')}>
        <StorageCard
          title={tr('title')}
          rows={[
            { label: tr('storageJournal'), value: tr('storageJournalValue'), isMono: true },
            {
              label: tr('storageConversations'),
              value: tr('storageConversationsValue'),
              isMono: true,
            },
            { label: tr('storageBackups'), value: tr('storageBackupsValue'), isMono: true },
            { label: tr('storageTargets'), value: tr('storageTargetsValue') },
            { label: tr('storageWhen'), value: tr('storageWhenValue') },
            { label: tr('storageNever'), value: tr('storageNeverValue') },
          ]}
        />
      </HelpSection>

      <HelpSection title={tr('limitsTitle')} caption={tr('limitsCaption')}>
        <FieldTable
          nameHeader={tr('limitsColumn')}
          descriptionHeader={tr('limitsMeaningColumn')}
          rows={[
            row('limitUndo'),
            row('limitHooks'),
            row('limitStartChat'),
            row('limitPhone'),
            row('limitMask'),
            row('limitVoice'),
            row('limitWindow'),
            row('limitCode'),
          ]}
        />
      </HelpSection>

      <HelpSection title={tr('refusalsTitle')} caption={tr('refusalsCaption')}>
        <Stack gap="var(--spacing-xs)">
          <FieldTable
            nameHeader={tr('refusalsColumn')}
            descriptionHeader={tr('refusalsMeaningColumn')}
            rows={[
              { ...row('refusalProvider'), badge: 'provider_unsupported', badgeTone: 'warning' },
              { ...row('refusalCli'), badge: 'cli_not_found', badgeTone: 'warning' },
              { ...row('refusalEndpoint'), badge: 'endpoint_unsupported', badgeTone: 'warning' },
              { ...row('refusalContour'), badge: 'contour_unreachable', badgeTone: 'warning' },
              { ...row('refusalMask'), badge: 'data_mask_broken', badgeTone: 'danger' },
              { ...row('refusalBusy'), badge: 'busy', badgeTone: 'neutral' },
              { ...row('refusalTimeout'), badge: 'timeout', badgeTone: 'neutral' },
            ]}
          />
          <Callout tone="warning" title={tr('compromiseTitle')}>
            {tr('compromiseText')}
          </Callout>
        </Stack>
      </HelpSection>
    </>
  );
}
