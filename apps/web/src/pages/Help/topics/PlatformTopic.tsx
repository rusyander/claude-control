import { useTranslation } from 'react-i18next';
import { CompromiseList } from '@features/CompromiseList';
import { HelpSection, OptionCards, Callout, FieldTable } from '../ui';
import { PlatformGuideSections } from './PlatformGuideSections';
import { PlatformSetupSections } from './PlatformSetupSections';
import { PlatformLimitsSections } from './PlatformLimitsSections';

/**
 * Документ «Контур» — один на весь раздел, и намеренно длинный.
 *
 * Путеводитель по снимкам был отдельным документом ровно один день: человек,
 * пришедший подключать контур, читает подряд, а две страницы означают два
 * оглавления и вопрос «это я уже читал?» на каждом переходе. Теперь порядок
 * один: зачем это нужно → чем отличается от соседнего → весь путь в снимках →
 * что ещё живёт в админке → что с ключом → куда идёт запрос → что показывает
 * раздел → ограничения и отказы → как отключить.
 *
 * Список компромиссов сюда не переписан — он тот же компонент, что стоит в
 * самом разделе. Два списка одного содержимого разъезжаются в первый же месяц,
 * и человек читает в справке то, чего в панели уже нет.
 *
 * Ограничения стоят в середине документа, а не в конце мелким шрифтом: их
 * читают до подключения, а не после.
 */
export function PlatformTopic() {
  const { t } = useTranslation();
  const tr = (key: string): string => t(`help.topics.platform.${key}`);

  return (
    <>
      {/* Страница длинная, и первое, что ей нужно сказать, — из чего она
          состоит: иначе человек, которому нужен один факт, листает наугад. */}
      <Callout tone="info" title={tr('guideTitle')}>
        {tr('guideText')}
      </Callout>

      <HelpSection title={t('help.common.whyTitle')}>
        <OptionCards
          items={[
            { title: tr('whyKey'), text: tr('whyKeyText') },
            { title: tr('whySigned'), text: tr('whySignedText') },
            { title: tr('whyProbe'), text: tr('whyProbeText') },
          ]}
        />
      </HelpSection>

      <PlatformSetupSections tr={tr} guide={<PlatformGuideSections tr={tr} />} />

      <HelpSection title={tr('screenTitle')} caption={tr('screenCaption')}>
        <FieldTable
          nameHeader={tr('screenColumn')}
          descriptionHeader={tr('screenPurposeColumn')}
          rows={[
            { name: tr('screenCard'), description: tr('screenCardText'), isMono: false },
            { name: tr('screenMatrix'), description: tr('screenMatrixText'), isMono: false },
            { name: tr('screenApplied'), description: tr('screenAppliedText'), isMono: false },
            { name: tr('screenJournal'), description: tr('screenJournalText'), isMono: false },
            { name: tr('screenBudget'), description: tr('screenBudgetText'), isMono: false },
            { name: tr('screenSpend'), description: tr('screenSpendText'), isMono: false },
            { name: tr('screenExhausted'), description: tr('screenExhaustedText'), isMono: false },
          ]}
        />
        <Callout tone="warning" title={tr('driftTitle')}>
          {tr('driftText')}
        </Callout>
      </HelpSection>

      <HelpSection title={tr('statesTitle')} caption={tr('statesCaption')}>
        <FieldTable
          nameHeader={tr('stateColumn')}
          descriptionHeader={tr('stateMeaningColumn')}
          rows={[
            { name: tr('stateUnchecked'), description: tr('stateUncheckedText'), isMono: false },
            { name: tr('stateOk'), description: tr('stateOkText'), isMono: false },
            {
              name: tr('stateUnauthorized'),
              description: tr('stateUnauthorizedText'),
              isMono: false,
            },
            {
              name: tr('stateUnreachable'),
              description: tr('stateUnreachableText'),
              isMono: false,
            },
            { name: tr('stateDisabled'), description: tr('stateDisabledText'), isMono: false },
          ]}
        />
      </HelpSection>

      {/* Проверки контура стоят до значков компромиссов: человек приходит сюда
          из карточки «Проверки», и первый же вопрос у него — чьи они и где
          выключаются. */}
      <HelpSection title={tr('checksTitle')} caption={tr('checksCaption')}>
        <FieldTable
          nameHeader={tr('checksColumn')}
          descriptionHeader={tr('checksMeaningColumn')}
          rows={[
            { name: tr('checksBlocked'), description: tr('checksBlockedText'), isMono: false },
            {
              name: tr('checksInterrupted'),
              description: tr('checksInterruptedText'),
              isMono: false,
            },
            { name: tr('checksMasked'), description: tr('checksMaskedText'), isMono: false },
            { name: tr('checksUnknown'), description: tr('checksUnknownText'), isMono: false },
          ]}
        />
        <Callout tone="info" title={tr('checksSilenceTitle')}>
          {tr('checksSilenceText')}
        </Callout>
        <Callout tone="warning" title={tr('checksTextTitle')}>
          {tr('checksTextText')}
        </Callout>
      </HelpSection>

      {/* Агенты — после проверок и до значков: человек приходит сюда из
          карточки «Агенты контура», и первые его вопросы — откуда брать
          идентификатор и почему «недоступно» не покрашено красным. */}
      <HelpSection title={tr('agentsTitle')} caption={tr('agentsCaption')}>
        <FieldTable
          nameHeader={tr('agentsColumn')}
          descriptionHeader={tr('agentsMeaningColumn')}
          rows={[
            { name: tr('agentsRoster'), description: tr('agentsRosterText'), isMono: false },
            { name: tr('agentsSession'), description: tr('agentsSessionText'), isMono: false },
            { name: tr('agentsOutcomes'), description: tr('agentsOutcomesText'), isMono: false },
            { name: tr('agentsBridge'), description: tr('agentsBridgeText'), isMono: false },
          ]}
        />
        <Callout tone="info" title={tr('agentsLimitTitle')}>
          {tr('agentsLimitText')}
        </Callout>
      </HelpSection>

      <PlatformLimitsSections tr={tr} />

      <HelpSection title={tr('marksTitle')} caption={tr('marksCaption')}>
        <Callout tone="info" title={tr('marksNote')} />
      </HelpSection>

      <HelpSection title={tr('listTitle')} caption={tr('listCaption')}>
        <CompromiseList />
      </HelpSection>
    </>
  );
}
