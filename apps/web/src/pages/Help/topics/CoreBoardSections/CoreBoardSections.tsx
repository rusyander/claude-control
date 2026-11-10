import { useTranslation } from 'react-i18next';
import { HelpSection, GuideSteps, GuideStep, HelpShot, HelpDiagram } from '../../ui';

/**
 * Доска задач в документе «Задачи ядра»: колонки и пределы, входящие из трекера, «В очередь» с
 * экрана запуска, ручное вмешательство и карточка «ждёт окна лимита». Кадры входящих снимает
 * `tools/help-shots/core-inbox.mjs`, связанных карточек — `tools/help-shots/core-related.mjs`.
 *
 * Стоит сразу за запуском ядра: доска — первое, что человек видит в разделе, и без неё
 * непонятно, почему задача «Очереди» не стартует. Кадры снимает `tools/help-shots/core-board.mjs`
 * на заглушках — ни одного настоящего проекта. Схема окна лимита общая с документом «Чат».
 */
export function CoreBoardSections() {
  const { t } = useTranslation();
  const tr = (key: string): string => t(`help.topics.core.${key}`);

  return (
    <>
      <HelpSection title={tr('boardTitle')} caption={tr('boardCaption')}>
        <HelpDiagram topic="core" name="board-flow" />
        <GuideSteps>
          <GuideStep title={tr('boardColumns')} text={tr('boardColumnsText')}>
            <HelpShot topic="core" scenario="board" frame="01-board" side="panel" />
          </GuideStep>
          <GuideStep title={tr('boardEntry')} text={tr('boardEntryText')}>
            <HelpShot topic="core" scenario="board" frame="02-entry-window" side="panel" />
          </GuideStep>
          <GuideStep title={tr('boardTask')} text={tr('boardTaskText')}>
            <HelpShot topic="core" scenario="board" frame="03-task-window" side="panel" />
          </GuideStep>
          <GuideStep title={tr('boardLimits')} text={tr('boardLimitsText')}>
            <HelpShot topic="core" scenario="board" frame="06-defaults" side="panel" />
          </GuideStep>
        </GuideSteps>
      </HelpSection>

      <HelpSection title={tr('inboxTitle')} caption={tr('inboxCaption')}>
        <GuideSteps>
          <GuideStep title={tr('inboxRow')} text={tr('inboxRowText')}>
            <HelpShot topic="core" scenario="inbox" frame="01-row" side="panel" />
          </GuideStep>
          <GuideStep title={tr('inboxSources')} text={tr('inboxSourcesText')}>
            <HelpShot topic="core" scenario="inbox" frame="02-sources" side="panel" />
          </GuideStep>
          <GuideStep title={tr('inboxSearch')} text={tr('inboxSearchText')}>
            <HelpShot topic="core" scenario="inbox" frame="03-search" side="panel" />
          </GuideStep>
          <GuideStep title={tr('inboxPreset')} text={tr('inboxPresetText')}>
            <HelpShot topic="core" scenario="inbox" frame="04-preset" side="panel" />
          </GuideStep>
        </GuideSteps>
        <HelpDiagram topic="core" name="inbox-flow" />
      </HelpSection>

      <HelpSection title={tr('relatedTitle')} caption={tr('relatedCaption')}>
        <GuideSteps>
          <GuideStep title={tr('relatedChip')} text={tr('relatedChipText')}>
            <HelpShot topic="core" scenario="related" frame="01-chip" side="panel" />
          </GuideStep>
          <GuideStep title={tr('relatedMerge')} text={tr('relatedMergeText')}>
            <HelpShot topic="core" scenario="related" frame="02-merge" side="panel" />
          </GuideStep>
          <GuideStep title={tr('relatedRefused')} text={tr('relatedRefusedText')}>
            <HelpShot topic="core" scenario="related" frame="03-refused" side="panel" />
          </GuideStep>
        </GuideSteps>
        <HelpDiagram topic="core" name="related-merge" />
      </HelpSection>

      <HelpSection title={tr('queueTitle')} caption={tr('queueCaption')}>
        <GuideSteps>
          <GuideStep title={tr('queueForm')} text={tr('queueFormText')}>
            <HelpShot topic="core" scenario="queue" frame="01-queue" side="panel" />
          </GuideStep>
          <GuideStep title={tr('queueStart')} text={tr('queueStartText')} />
        </GuideSteps>
      </HelpSection>

      <HelpSection title={tr('takeoverTitle')} caption={tr('takeoverCaption')}>
        <GuideSteps>
          <GuideStep title={tr('takeoverTake')} text={tr('takeoverTakeText')}>
            <HelpShot topic="core" scenario="board" frame="04-takeover-open" side="panel" />
          </GuideStep>
          <GuideStep title={tr('takeoverBack')} text={tr('takeoverBackText')} />
          <GuideStep title={tr('takeoverRework')} text={tr('takeoverReworkText')} />
        </GuideSteps>
        <HelpDiagram topic="core" name="takeover-loop" />
      </HelpSection>

      <HelpSection title={tr('windowTitle')} caption={tr('windowCaption')}>
        <GuideSteps>
          <GuideStep title={tr('windowCard')} text={tr('windowCardText')}>
            <HelpShot topic="core" scenario="board" frame="05-window-card" side="panel" />
          </GuideStep>
          <GuideStep title={tr('windowSwitch')} text={tr('windowSwitchText')} />
        </GuideSteps>
        <HelpDiagram topic="core" name="limit-window" />
      </HelpSection>
    </>
  );
}
