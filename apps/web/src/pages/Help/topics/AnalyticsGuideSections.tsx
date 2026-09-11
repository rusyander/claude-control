import { HelpSection, Callout, GuideSteps, GuideStep, HelpShot, HelpDiagram } from '../ui';

interface SectionProps {
  /** Перевод ключа `help.topics.analytics.<key>` — словарь у документа один. */
  tr: (key: string) => string;
}

/**
 * Середина документа «Аналитика»: схема происхождения чисел и два пути в снимках.
 *
 * Сценариев два, и делятся они ПО ВХОДУ. «Отчёт» открывают, чтобы посмотреть
 * назад: период, разрезы, сессии. «Живой срез» открывают, чтобы посмотреть на
 * сейчас: работает ли кто-нибудь на этой машине. Источник у них разный — файлы на
 * диске против списка процессов, — и путать их дороже всего.
 */
export function AnalyticsGuideSections({ tr }: SectionProps) {
  const g = (key: string): string => tr(`guide.${key}`);

  return (
    <>
      <HelpSection title={tr('mapTitle')} caption={tr('mapCaption')}>
        <HelpDiagram topic="analytics" name="how-the-report-is-built" />
        {/* Тот же путь словами: справку читают и без картинок. */}
        <Callout tone="info" title={tr('pathTextTitle')}>
          {tr('pathTextText')}
        </Callout>
      </HelpSection>

      <HelpSection title={g('reportTitle')} caption={g('reportCaption')}>
        <GuideSteps>
          <GuideStep title={g('reportToday')} text={g('reportTodayText')}>
            <HelpShot topic="analytics" scenario="report" frame="01-today" side="panel" />
          </GuideStep>
          <GuideStep title={g('reportMonth')} text={g('reportMonthText')}>
            <HelpShot topic="analytics" scenario="report" frame="02-month" side="panel" />
          </GuideStep>
          <GuideStep title={g('reportDetail')} text={g('reportDetailText')}>
            <HelpShot topic="analytics" scenario="report" frame="03-detail" side="panel" />
          </GuideStep>
          <GuideStep title={g('reportHours')} text={g('reportHoursText')}>
            <HelpShot topic="analytics" scenario="report" frame="04-hours" side="panel" />
          </GuideStep>
          <GuideStep title={g('reportSessions')} text={g('reportSessionsText')}>
            <HelpShot topic="analytics" scenario="report" frame="05-sessions" side="panel" />
          </GuideStep>
        </GuideSteps>
      </HelpSection>

      <HelpSection title={g('liveTitle')} caption={g('liveCaption')}>
        <GuideSteps>
          <GuideStep title={g('liveIdle')} text={g('liveIdleText')}>
            <HelpShot topic="analytics" scenario="live" frame="01-idle" side="panel" />
          </GuideStep>
          <GuideStep title={g('liveRunning')} text={g('liveRunningText')}>
            <HelpShot topic="analytics" scenario="live" frame="02-running" side="panel" />
          </GuideStep>
        </GuideSteps>
      </HelpSection>
    </>
  );
}
