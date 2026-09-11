import { HelpSection, Callout, GuideSteps, GuideStep, HelpShot, HelpDiagram } from '../ui';

interface SectionProps {
  /** Перевод ключа `help.topics.history.<key>` — словарь у документа один. */
  tr: (key: string) => string;
}

/**
 * Середина документа «История изменений»: схема происхождения ленты и путь в
 * снимках.
 *
 * Сценарий один, потому что вход один: лента. Зато он доведён до конца — до
 * возврата одного блока и до того, как этот возврат сам становится новой записью
 * ленты. Именно на последнем шаге чаще всего спотыкаются: откат не стирает
 * историю, а дописывает её.
 */
export function HistoryGuideSections({ tr }: SectionProps) {
  const g = (key: string): string => tr(`guide.${key}`);

  return (
    <>
      <HelpSection title={tr('mapTitle')} caption={tr('mapCaption')}>
        <HelpDiagram topic="history" name="where-the-feed-comes-from" />
        {/* Тот же путь словами: справку читают и без картинок. */}
        <Callout tone="info" title={tr('pathTextTitle')}>
          {tr('pathTextText')}
        </Callout>
      </HelpSection>

      <HelpSection title={g('traceTitle')} caption={g('traceCaption')}>
        <GuideSteps>
          <GuideStep title={g('traceFeed')} text={g('traceFeedText')}>
            <HelpShot topic="history" scenario="trace" frame="01-feed" side="panel" />
          </GuideStep>
          <GuideStep title={g('traceDiff')} text={g('traceDiffText')}>
            <HelpShot topic="history" scenario="trace" frame="02-diff" side="panel" />
          </GuideStep>
          <GuideStep title={g('traceRevert')} text={g('traceRevertText')}>
            <HelpShot topic="history" scenario="trace" frame="03-revert" side="panel" />
          </GuideStep>
          <GuideStep title={g('traceAfter')} text={g('traceAfterText')}>
            <HelpShot topic="history" scenario="trace" frame="04-after" side="panel" />
          </GuideStep>
        </GuideSteps>
      </HelpSection>
    </>
  );
}
