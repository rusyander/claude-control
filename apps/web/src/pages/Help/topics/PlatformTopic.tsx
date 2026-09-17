import { useTranslation } from 'react-i18next';
import { CompromiseList } from '@features/CompromiseList';
import { HelpSection, OptionCards, Callout, FieldTable } from '../ui';
import { PlatformGuideSections } from './PlatformGuideSections';
import { PlatformSetupSections } from './PlatformSetupSections';
import { PlatformLimitsSections } from './PlatformLimitsSections';
import { PlatformTabsSections } from './PlatformTabsSections';

/**
 * Документ «Контур» — один на весь раздел, и намеренно длинный.
 *
 * Путеводитель по снимкам был отдельным документом ровно один день: человек,
 * пришедший подключать контур, читает подряд, а две страницы означают два
 * оглавления и вопрос «это я уже читал?» на каждом переходе. Теперь порядок
 * один: зачем это нужно → чем отличается от соседнего → весь путь в снимках
 * (подключение, затем работа через контур) → что ещё живёт в админке → что с
 * ключом → куда идёт запрос → что показывает раздел → ограничения и отказы →
 * как отключить → подписанные компромиссы и просьбы к платформе.
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

      <PlatformTabsSections tr={tr} />

      <HelpSection title={tr('screenTitle')} caption={tr('screenCaption')}>
        <FieldTable
          nameHeader={tr('screenColumn')}
          descriptionHeader={tr('screenPurposeColumn')}
          rows={[
            { name: tr('screenCard'), description: tr('screenCardText'), isMono: false },
            { name: tr('screenSmoke'), description: tr('screenSmokeText'), isMono: false },
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

      {/* Активный контур стоит ДО состояний связи: «не активен» — первое, что
          человек читает на карточке соседа, и объяснять его после таблицы
          состояний значило бы объяснять задним числом. */}
      <HelpSection title={tr('activeTitle')} caption={tr('activeCaption')}>
        <FieldTable
          nameHeader={tr('activeColumn')}
          descriptionHeader={tr('activeMeaningColumn')}
          rows={[
            { name: tr('activeMake'), description: tr('activeMakeText'), isMono: false },
            { name: tr('activeBadgeRow'), description: tr('activeBadgeRowText'), isMono: false },
            { name: tr('activeSmokeRow'), description: tr('activeSmokeRowText'), isMono: false },
            { name: tr('activeReturnRow'), description: tr('activeReturnRowText'), isMono: false },
          ]}
        />
        <Callout tone="info" title={tr('activeWhyTitle')}>
          {tr('activeWhyText')}
        </Callout>
        <Callout tone="warning" title={tr('activeMigratedTitle')}>
          {tr('activeMigratedText')}
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
            { name: tr('stateNoKey'), description: tr('stateNoKeyText'), isMono: false },
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

      {/* Модель и глубина — сразу после агентов и до ограничений: это первое,
          что человек спрашивает, увидев в шапке чата подпись «запрос уйдёт с
          другой моделью». Ограничения читаются после, а не вместо. */}
      <HelpSection title={tr('modelsTitle')} caption={tr('modelsCaption')}>
        <FieldTable
          nameHeader={tr('modelsColumn')}
          descriptionHeader={tr('modelsMeaningColumn')}
          rows={[
            { name: tr('modelsDefault'), description: tr('modelsDefaultText'), isMono: false },
            { name: tr('modelsConsumer'), description: tr('modelsConsumerText'), isMono: false },
            { name: tr('modelsMap'), description: tr('modelsMapText'), isMono: false },
          ]}
        />
        <Callout tone="warning" title={tr('modelsUnknownTitle')}>
          {tr('modelsUnknownText')}
        </Callout>
        <Callout tone="info" title={tr('modelsEffortTitle')}>
          {tr('modelsEffortText')}
        </Callout>
      </HelpSection>

      {/* Правила контура — сразу после модели: оба раздела об одном и том же
          запросе, и человек, прочитавший «чем пойдёт», следом спрашивает «что с
          ним сделают по дороге». Матрица конфликтов здесь же: её единственная
          красная строка — про инструменты, а остальные три нужны ровно затем,
          чтобы человек НЕ выключил одну из сторон. */}
      <HelpSection title={tr('rulesTitle')} caption={tr('rulesCaption')}>
        <FieldTable
          nameHeader={tr('rulesColumn')}
          descriptionHeader={tr('rulesMeaningColumn')}
          rows={[
            { name: tr('rulesTools'), description: tr('rulesToolsText'), isMono: false },
            { name: tr('rulesMode'), description: tr('rulesModeText'), isMono: false },
            { name: tr('rulesPreset'), description: tr('rulesPresetText'), isMono: false },
            { name: tr('rulesThinking'), description: tr('rulesThinkingText'), isMono: false },
            { name: tr('rulesObserved'), description: tr('rulesObservedText'), isMono: false },
          ]}
        />
        <Callout tone="warning" title={tr('rulesExclusiveTitle')}>
          {tr('rulesExclusiveText')}
        </Callout>
        <Callout tone="info" title={tr('rulesLayersTitle')}>
          {tr('rulesLayersText')}
        </Callout>
      </HelpSection>

      {/* Наши слои — следом за правилами контура: там сказано, что с запросом
          делает ЧУЖАЯ сторона, здесь — что из своего мы в него не кладём.
          Порядок не декоративный: человек, снявший слои, читает про них после
          того, как понял, зачем экономить промпт. */}
      <HelpSection title={tr('layersTitle')} caption={tr('layersCaption')}>
        <FieldTable
          nameHeader={tr('layersColumn')}
          descriptionHeader={tr('layersMeaningColumn')}
          rows={[
            { name: tr('layersAll'), description: tr('layersAllText'), isMono: false },
            { name: tr('layerSettings'), description: tr('layerSettingsText'), isMono: false },
            { name: tr('layerSkills'), description: tr('layerSkillsText'), isMono: false },
            { name: tr('layerMcp'), description: tr('layerMcpText'), isMono: false },
            { name: tr('layerPrompt'), description: tr('layerPromptText'), isMono: false },
          ]}
        />
        <Callout tone="info" title={tr('layersFlagsTitle')}>
          {tr('layersFlagsText')}
        </Callout>
        <Callout tone="warning" title={tr('layersMissingTitle')}>
          {tr('layersMissingText')}
        </Callout>
      </HelpSection>

      <PlatformLimitsSections tr={tr} />

      <HelpSection title={tr('marksTitle')} caption={tr('marksCaption')}>
        <Callout tone="info" title={tr('marksNote')} />
      </HelpSection>

      <HelpSection title={tr('listTitle')} caption={tr('listCaption')}>
        <CompromiseList />
      </HelpSection>

      {/* Просьбы к платформе — сразу за списком подписей: у каждой строки
          здесь есть подпись там, и человек, дочитавший «что мы обходим»,
          следом спрашивает «а просили ли снять». Весь список живёт в документе
          репозитория; здесь — пять строк, которые меняют работу больше всего. */}
      <HelpSection title={tr('asksTitle')} caption={tr('asksCaption')}>
        <FieldTable
          nameHeader={tr('asksColumn')}
          descriptionHeader={tr('asksMeaningColumn')}
          rows={[
            { name: tr('askTools'), description: tr('askToolsText'), isMono: false },
            { name: tr('askCache'), description: tr('askCacheText'), isMono: false },
            { name: tr('askTimeout'), description: tr('askTimeoutText'), isMono: false },
            { name: tr('askBudget'), description: tr('askBudgetText'), isMono: false },
            { name: tr('askEffort'), description: tr('askEffortText'), isMono: false },
            { name: tr('askMask'), description: tr('askMaskText'), isMono: false },
          ]}
        />
        <Callout tone="info" title={tr('asksDocTitle')}>
          {tr('asksDocText')}
        </Callout>
      </HelpSection>
    </>
  );
}
