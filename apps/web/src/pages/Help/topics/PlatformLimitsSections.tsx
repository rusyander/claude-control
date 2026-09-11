import { HelpSection, Callout, FieldTable, StepList } from '../ui';
import { PlatformCapabilityDiagram } from './PlatformDiagrams';
import type { CapabilityRow } from './PlatformDiagrams';

interface SectionProps {
  /** Перевод ключа `help.topics.platform.<key>`. */
  tr: (key: string) => string;
}

/**
 * Вторая половина документа «Контур»: модули платформы, честный список того,
 * что через контур не работает, коды отказов и отключение.
 *
 * Раздел «что не работает» не спрятан в конец мелким шрифтом и не смягчён.
 * Человек, направивший на контур Claude Code и обнаруживший, что тот перестал
 * править файлы, должен найти ответ здесь — а не в чате поддержки.
 */
export function PlatformLimitsSections({ tr }: SectionProps) {
  const capabilityRows: CapabilityRow[] = [
    { label: tr('workAssistant'), mark: 'yes' },
    { label: tr('workCases'), mark: 'yes' },
    { label: tr('workAnalytics'), mark: 'yes' },
    { label: tr('workEmbeddings'), mark: 'yes' },
    { label: tr('workAgent'), mark: 'yes' },
    { label: tr('workBridge'), mark: 'yes' },
    { label: tr('workCliChat'), mark: 'partial' },
    { label: tr('workCliAgent'), mark: 'no' },
  ];

  return (
    <>
      <HelpSection title={tr('modulesTitle')} caption={tr('modulesCaption')}>
        <FieldTable
          nameHeader={tr('modulesColumn')}
          descriptionHeader={tr('modulesMeaningColumn')}
          rows={[
            { name: tr('moduleLlm'), description: tr('moduleLlmText'), isMono: false },
            { name: tr('moduleGuard'), description: tr('moduleGuardText'), isMono: false },
            { name: tr('moduleTools'), description: tr('moduleToolsText'), isMono: false },
            { name: tr('moduleKb'), description: tr('moduleKbText'), isMono: false },
            { name: tr('moduleMcp'), description: tr('moduleMcpText'), isMono: false },
            { name: tr('moduleAgents'), description: tr('moduleAgentsText'), isMono: false },
            { name: tr('moduleOther'), description: tr('moduleOtherText'), isMono: false },
            { name: tr('moduleSpeech'), description: tr('moduleSpeechText'), isMono: false },
          ]}
        />
        <Callout tone="info" title={tr('modulesIndirectTitle')}>
          {tr('modulesIndirectText')}
        </Callout>
      </HelpSection>

      <HelpSection title={tr('worksTitle')} caption={tr('worksCaption')}>
        <PlatformCapabilityDiagram title={tr('d4Title')} rows={capabilityRows} />
        {/* Картинка отвечает «да или нет», таблица — «почему». Причина у
            прочерка обязательна: без неё «не работает» читается как поломка
            панели, и человек идёт чинить не то. */}
        <FieldTable
          nameHeader={tr('worksColumn')}
          descriptionHeader={tr('worksWhyColumn')}
          rows={[
            {
              name: tr('workAssistant'),
              description: tr('workAssistantWhy'),
              isMono: false,
              badge: tr('worksBadgeYes'),
              badgeTone: 'success',
            },
            {
              name: tr('workCases'),
              description: tr('workCasesWhy'),
              isMono: false,
              badge: tr('worksBadgeYes'),
              badgeTone: 'success',
            },
            {
              name: tr('workAnalytics'),
              description: tr('workAnalyticsWhy'),
              isMono: false,
              badge: tr('worksBadgeYes'),
              badgeTone: 'success',
            },
            {
              name: tr('workEmbeddings'),
              description: tr('workEmbeddingsWhy'),
              isMono: false,
              badge: tr('worksBadgeYes'),
              badgeTone: 'success',
            },
            {
              name: tr('workAgent'),
              description: tr('workAgentWhy'),
              isMono: false,
              badge: tr('worksBadgeYes'),
              badgeTone: 'success',
            },
            {
              name: tr('workBridge'),
              description: tr('workBridgeWhy'),
              isMono: false,
              badge: tr('worksBadgeYes'),
              badgeTone: 'success',
            },
            {
              name: tr('workCliChat'),
              description: tr('workCliChatWhy'),
              isMono: false,
              badge: tr('worksBadgePartial'),
              badgeTone: 'warning',
            },
            {
              name: tr('workCliAgent'),
              description: tr('workCliAgentWhy'),
              isMono: false,
              badge: tr('worksBadgeNo'),
              badgeTone: 'danger',
            },
          ]}
        />
        <Callout tone="warning" title={tr('worksHonestTitle')}>
          {tr('worksHonestText')}
        </Callout>
      </HelpSection>

      <HelpSection title={tr('errorsTitle')} caption={tr('errorsCaption')}>
        <FieldTable
          nameHeader={tr('errorsColumn')}
          descriptionHeader={tr('errorsActionColumn')}
          rows={[
            { name: '401', description: tr('err401'), badge: tr('err401Badge') },
            { name: '402', description: tr('err402'), badge: tr('err402Badge') },
            { name: '403', description: tr('err403'), badge: tr('err403Badge') },
            { name: '404', description: tr('err404'), badge: tr('err404Badge') },
            { name: '429', description: tr('err429'), badge: tr('err429Badge') },
            { name: '451', description: tr('err451'), badge: tr('err451Badge') },
            { name: '503', description: tr('err503'), badge: tr('err503Badge') },
          ]}
        />
      </HelpSection>

      <HelpSection title={tr('disableTitle')} caption={tr('disableCaption')}>
        <StepList
          steps={[
            { title: tr('disableStep1'), text: tr('disableStep1Text') },
            { title: tr('disableStep2'), text: tr('disableStep2Text') },
            { title: tr('disableStep3'), text: tr('disableStep3Text') },
          ]}
        />
        <Callout tone="info" title={tr('disableKeepsTitle')}>
          {tr('disableKeepsText')}
        </Callout>
      </HelpSection>
    </>
  );
}
