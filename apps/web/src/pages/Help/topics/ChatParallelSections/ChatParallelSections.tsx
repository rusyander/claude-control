import { useTranslation } from 'react-i18next';
import {
  HelpSection,
  Callout,
  OptionCards,
  GuideSteps,
  GuideStep,
  HelpShot,
  HelpDiagram,
} from '../../ui';

/**
 * Соседние разделы документа «Чат» об одном и том же: как работа одного проекта
 * расходится по нескольким разговорам — копии репозитория руками, что из прежних
 * групп и деревьев перешло в ядро задач (и чего у ядра нет — по имени), подбор
 * модели, отложенные вызовы D-n и продолжение закрытого этапа в чистой сессии.
 * Вынесены из `ChatTopic` целиком: вместе они переваливали документ за предел
 * длины файла.
 */
export function ChatParallelSections() {
  const { t } = useTranslation();
  const tr = (key: string): string => t(`help.topics.chat.${key}`);

  return (
    <>
      <HelpSection title={tr('parallelTitle')} caption={tr('parallelCaption')}>
        <OptionCards
          minWidth={320}
          items={[
            { title: tr('parallelWhy'), text: tr('parallelWhyText') },
            { title: tr('parallelCreate'), text: tr('parallelCreateText') },
            { title: tr('parallelWork'), text: tr('parallelWorkText') },
            { title: tr('parallelRemove'), text: tr('parallelRemoveText') },
            { title: tr('parallelMirror'), text: tr('parallelMirrorText') },
            { title: tr('parallelNever'), text: tr('parallelNeverText') },
            { title: tr('parallelLinks'), text: tr('parallelLinksText') },
            { title: tr('parallelAccess'), text: tr('parallelAccessText') },
            { title: tr('parallelReady'), text: tr('parallelReadyText') },
            { title: tr('parallelBootstrap'), text: tr('parallelBootstrapText') },
            { title: tr('parallelMemory'), text: tr('parallelMemoryText') },
          ]}
        />
        <Callout tone="warning" title={tr('parallelNote')} />
      </HelpSection>

      {/* Разделение, деревья групп и автономность ушли из чата в ядро задач (этап 10):
          раздел говорит, где теперь каждое из них, и что ядро не делает — по имени,
          чтобы человек не искал пропавшую кнопку. */}
      <HelpSection title={tr('coreMovedTitle')} caption={tr('coreMovedCaption')}>
        <OptionCards
          minWidth={320}
          items={[
            { title: tr('coreMovedSplit'), text: tr('coreMovedSplitText') },
            { title: tr('coreMovedAutonomy'), text: tr('coreMovedAutonomyText') },
            { title: tr('coreMovedWatch'), text: tr('coreMovedWatchText') },
            { title: tr('coreMovedContinue'), text: tr('coreMovedContinueText') },
            { title: tr('coreMovedForeign'), text: tr('coreMovedForeignText') },
            { title: tr('coreMovedRefused'), text: tr('coreMovedRefusedText') },
          ]}
        />
        <Callout tone="warning" title={tr('coreMovedNote')} />
      </HelpSection>

      {/* Модель шага и работа по частям — у ядра (этап 10): правила выбора модели
          (`economy/tier.ts`), деление (`split-check`), ревью и публикация — шаги сценария;
          от прежних разделений остались сводка для чтения и пауза дерева. */}
      <HelpSection title={tr('cascadeTitle')} caption={tr('cascadeCaption')}>
        <OptionCards
          minWidth={320}
          items={[
            { title: tr('cascadeWhat'), text: tr('cascadeWhatText') },
            { title: tr('cascadeCeiling'), text: tr('cascadeCeilingText') },
            { title: tr('cascadeKinds'), text: tr('cascadeKindsText') },
            { title: tr('cascadeLimits'), text: tr('cascadeLimitsText') },
            { title: tr('cascadeForeign'), text: tr('cascadeForeignText') },
            { title: tr('cascadeLevels'), text: tr('cascadeLevelsText') },
            { title: tr('cascadeOverlap'), text: tr('cascadeOverlapText') },
            { title: tr('cascadeReview'), text: tr('cascadeReviewText') },
            { title: tr('cascadeDelivery'), text: tr('cascadeDeliveryText') },
            { title: tr('cascadeHub'), text: tr('cascadeHubText') },
            { title: tr('cascadeControl'), text: tr('cascadeControlText') },
            { title: tr('cascadePause'), text: tr('cascadePauseText') },
            { title: tr('cascadeRules'), text: tr('cascadeRulesText') },
            { title: tr('cascadeEconomy'), text: tr('cascadeEconomyText') },
            { title: tr('cascadeWatch'), text: tr('cascadeWatchText') },
          ]}
        />
        <Callout tone="warning" title={tr('cascadeNote')} />
      </HelpSection>

      {/* Отложенные вызовы D-n — наследие панели до ядра: новых записей нет, старые видны
          до истечения, решение по ним только записывается. Кадр плашки и схема — прежний путь. */}
      <HelpSection title={tr('deferredTitle')} caption={tr('deferredCaption')}>
        <HelpDiagram topic="chat" name="deferred-asks" />
        <GuideSteps>
          <GuideStep title={tr('deferredWhen')} text={tr('deferredWhenText')} />
          <GuideStep title={tr('deferredList')} text={tr('deferredListText')}>
            <HelpShot topic="chat" scenario="deferred" frame="01-banner" side="panel" />
          </GuideStep>
          <GuideStep title={tr('deferredDecide')} text={tr('deferredDecideText')} />
          <GuideStep title={tr('deferredLimits')} text={tr('deferredLimitsText')} />
        </GuideSteps>
        <Callout tone="warning" title={tr('deferredNote')} />
      </HelpSection>

      {/* Продолжение в чистой сессии: там работа расходится вширь, здесь —
          вперёд, оставляя позади дорогой контекст закрытого этапа. */}
      <HelpSection title={tr('handoffTitle')} caption={tr('handoffCaption')}>
        <OptionCards
          minWidth={320}
          items={[
            { title: tr('handoffWhen'), text: tr('handoffWhenText') },
            { title: tr('handoffSize'), text: tr('handoffSizeText') },
            { title: tr('handoffCard'), text: tr('handoffCardText') },
            { title: tr('handoffWhat'), text: tr('handoffWhatText') },
            { title: tr('handoffAuto'), text: tr('handoffAutoText') },
            { title: tr('handoffTidy'), text: tr('handoffTidyText') },
            { title: tr('handoffOff'), text: tr('handoffOffText') },
          ]}
        />
        <Callout tone="warning" title={tr('handoffNote')} />
      </HelpSection>
    </>
  );
}
