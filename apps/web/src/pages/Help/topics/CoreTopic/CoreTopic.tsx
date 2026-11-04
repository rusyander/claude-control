import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import {
  HelpSection,
  FieldTable,
  Callout,
  OptionCards,
  GuideSteps,
  GuideStep,
  HelpShot,
  HelpDiagram,
} from '../../ui';

/**
 * Документ «Задачи ядра».
 *
 * Первое, на чём спотыкается читатель, — «раздел пустой»: ядро — свой процесс, и `pnpm dev` его
 * не запускает. Поэтому запуск ядра стоит раньше экрана запуска задачи, а карточка «не запущено» —
 * в том же разделе. Плашка «звено не записано» — отдельным разделом: без неё отказ команды
 * `signature-required` выглядит поломкой.
 */
export function CoreTopic() {
  const { t } = useTranslation();
  const tr = (key: string): string => t(`help.topics.core.${key}`);
  const common = (key: string): string => t(`help.common.${key}`);
  const row = (key: string, isMono = false) => ({
    name: tr(key),
    description: tr(`${key}Text`),
    isMono,
  });

  return (
    <>
      <Callout tone="info" title={tr('guideTitle')}>
        {tr('guideText')}
      </Callout>

      <HelpSection title={common('whyTitle')}>
        <OptionCards
          items={[
            { title: tr('whyJournal'), text: tr('whyJournalText') },
            { title: tr('whyReason'), text: tr('whyReasonText') },
            { title: tr('whyHuman'), text: tr('whyHumanText') },
          ]}
        />
      </HelpSection>

      <HelpSection title={tr('mapTitle')} caption={tr('mapCaption')}>
        <HelpDiagram topic="core" name="panel-to-core" />
        {/* Тот же путь словами: справку читают и без картинок. */}
        <Callout tone="info" title={tr('pathTextTitle')}>
          {tr('pathTextText')}
        </Callout>
      </HelpSection>

      <HelpSection title={tr('startTitle')} caption={tr('startCaption')}>
        <GuideSteps>
          <GuideStep title={tr('startRun')} text={tr('startRunText')} />
          <GuideStep title={tr('startOpen')} text={tr('startOpenText')}>
            <HelpShot topic="core" scenario="tasks" frame="01-list" side="panel" />
          </GuideStep>
          <GuideStep title={tr('startFault')} text={tr('startFaultText')}>
            <HelpShot topic="core" scenario="fault" frame="01-fault" side="panel" />
          </GuideStep>
          <GuideStep title={tr('startAbsent')} text={tr('startAbsentText')}>
            <HelpShot topic="core" scenario="absent" frame="01-card" side="panel" />
          </GuideStep>
        </GuideSteps>
        <FieldTable
          nameHeader={tr('cmdHeader')}
          descriptionHeader={tr('cmdWhat')}
          rows={[row('cmdCore', true), row('cmdDev', true), row('cmdKeepalive', true)]}
        />
      </HelpSection>

      <HelpSection title={tr('launchTitle')} caption={tr('launchCaption')}>
        <GuideSteps>
          <GuideStep title={tr('launchForm')} text={tr('launchFormText')}>
            <HelpShot topic="core" scenario="launch" frame="01-form" side="panel" />
          </GuideStep>
          <GuideStep title={tr('launchReview')} text={tr('launchReviewText')}>
            <HelpShot topic="core" scenario="launch" frame="07-review-link" side="panel" />
          </GuideStep>
          <GuideStep title={tr('launchEstimate')} text={tr('launchEstimateText')}>
            <HelpShot topic="core" scenario="launch" frame="02-estimate" side="panel" />
          </GuideStep>
          <GuideStep title={tr('launchRoads')} text={tr('launchRoadsText')}>
            <HelpShot topic="core" scenario="launch" frame="03-roads" side="panel" />
          </GuideStep>
          <GuideStep title={tr('launchRejected')} text={tr('launchRejectedText')}>
            <HelpShot topic="core" scenario="launch" frame="04-rejected" side="panel" />
          </GuideStep>
          <GuideStep title={tr('launchSplit')} text={tr('launchSplitText')}>
            <HelpShot topic="core" scenario="launch" frame="05-split" side="panel" />
          </GuideStep>
          <GuideStep title={tr('launchGo')} text={tr('launchGoText')}>
            <HelpShot topic="core" scenario="launch" frame="06-launch" side="panel" />
          </GuideStep>
          <GuideStep title={tr('launchMcp')} text={tr('launchMcpText')}>
            <HelpShot topic="core" scenario="launch" frame="08-mcp-picks" side="panel" />
          </GuideStep>
        </GuideSteps>
      </HelpSection>

      {/* Схема — после шагов: путь задачи целиком читается, когда экран уже знаком. */}
      <HelpSection title={tr('launchDiagramTitle')}>
        <HelpDiagram topic="core" name="launch-to-steps" />
      </HelpSection>

      <HelpSection title={tr('askTitle')} caption={tr('askCaption')}>
        <GuideSteps>
          <GuideStep title={tr('askLaunch')} text={tr('askLaunchText')}>
            <HelpShot topic="core" scenario="ask" frame="01-launch" side="panel" />
          </GuideStep>
          <GuideStep title={tr('askCap')} text={tr('askCapText')}>
            <HelpShot topic="core" scenario="cap" frame="01-round-cap" side="panel" />
          </GuideStep>
        </GuideSteps>
        <FieldTable
          nameHeader={tr('askKindsHeader')}
          descriptionHeader={tr('askKindsWhat')}
          rows={[
            row('askKindLaunch'),
            row('askKindCap'),
            row('askKindPermit'),
            row('askKindHuman'),
          ]}
        />
      </HelpSection>

      <HelpSection title={tr('timelineTitle')} caption={tr('timelineCaption')}>
        <GuideSteps>
          <GuideStep title={tr('timelineOverview')} text={tr('timelineOverviewText')}>
            <HelpShot topic="core" scenario="timeline" frame="01-overview" side="panel" />
          </GuideStep>
          <GuideStep title={tr('timelineDecision')} text={tr('timelineDecisionText')}>
            <HelpShot topic="core" scenario="timeline" frame="02-decision" side="panel" />
          </GuideStep>
          <GuideStep title={tr('timelineCheck')} text={tr('timelineCheckText')}>
            <HelpShot topic="core" scenario="timeline" frame="03-check" side="panel" />
          </GuideStep>
          <GuideStep title={tr('timelineReport')} text={tr('timelineReportText')}>
            <HelpShot topic="core" scenario="timeline" frame="04-report" side="panel" />
          </GuideStep>
        </GuideSteps>
        <FieldTable
          nameHeader={tr('checkHeader')}
          descriptionHeader={tr('checkWhat')}
          rows={[row('checkRun'), row('checkReplay'), row('checkNarrow')]}
        />
      </HelpSection>

      <HelpSection title={tr('scenariosTitle')} caption={tr('scenariosCaption')}>
        <GuideSteps>
          <GuideStep title={tr('scenariosLibrary')} text={tr('scenariosLibraryText')}>
            <HelpShot topic="core" scenario="scenarios" frame="01-library" side="panel" />
          </GuideStep>
          <GuideStep title={tr('scenariosNew')} text={tr('scenariosNewText')}>
            <HelpShot topic="core" scenario="scenarios" frame="02-new" side="panel" />
          </GuideStep>
          <GuideStep title={tr('scenariosTask')} text={tr('scenariosTaskText')} />
        </GuideSteps>
      </HelpSection>

      <HelpSection title={tr('hopsTitle')} caption={tr('hopsCaption')}>
        <GuideSteps>
          <GuideStep title={tr('hopsWhat')} text={tr('hopsWhatText')}>
            <HelpShot topic="core" scenario="tasks" frame="02-hops" side="panel" />
          </GuideStep>
          <GuideStep title={tr('hopsDo')} text={tr('hopsDoText')} />
        </GuideSteps>
      </HelpSection>

      <HelpSection title={tr('limitsTitle')}>
        <Stack gap="var(--spacing-xs)">
          <Callout tone="info" title={tr('limitEnglishTitle')}>
            {tr('limitEnglishText')}
          </Callout>
          <Callout tone="info" title={tr('limitNumbersTitle')}>
            {tr('limitNumbersText')}
          </Callout>
        </Stack>
      </HelpSection>
    </>
  );
}
