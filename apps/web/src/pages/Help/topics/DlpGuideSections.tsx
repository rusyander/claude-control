import { HelpSection, Callout, GuideSteps, GuideStep, HelpShot, HelpDiagram } from '../ui';

interface SectionProps {
  /** Перевод ключа `help.topics.dlp.<key>`. */
  tr: (key: string) => string;
}

/**
 * Середина документа «Защита данных»: схема зон видимости и два пути.
 *
 * Пути делятся по средству, а не по экрану, потому что средства отвечают на
 * разные вопросы: прокси — «что уходит в модель вообще», гейт — «что человек
 * отправил руками». Читатель, пришедший за вторым, не должен сначала поднимать
 * первое, и наоборот.
 */
export function DlpGuideSections({ tr }: SectionProps) {
  const g = (key: string): string => tr(`guide.${key}`);

  return (
    <>
      <HelpSection title={tr('seenMapTitle')} caption={tr('seenMapCaption')}>
        <HelpDiagram topic="dlp" name="what-the-proxy-sees-and-what-the-gate-sees" />
        {/* Тот же путь словами: справку читают и без картинок. */}
        <Callout tone="info" title={tr('pathTextTitle')}>
          {tr('pathTextText')}
        </Callout>
      </HelpSection>

      <HelpSection title={g('firstTitle')} caption={g('firstCaption')}>
        <GuideSteps>
          <GuideStep title={g('firstEmpty')} text={g('firstEmptyText')}>
            <HelpShot topic="dlp" scenario="first" frame="01-empty" side="panel" />
          </GuideStep>
          <GuideStep title={g('firstStarter')} text={g('firstStarterText')}>
            <HelpShot topic="dlp" scenario="first" frame="02-starter" side="panel" />
          </GuideStep>
          <GuideStep title={g('firstTerms')} text={g('firstTermsText')}>
            <HelpShot topic="dlp" scenario="first" frame="03-terms" side="panel" />
          </GuideStep>
          <GuideStep title={g('firstPreview')} text={g('firstPreviewText')}>
            <HelpShot topic="dlp" scenario="first" frame="04-preview" side="panel" />
          </GuideStep>
          <GuideStep title={g('firstRunning')} text={g('firstRunningText')}>
            <HelpShot topic="dlp" scenario="first" frame="05-running" side="panel" />
          </GuideStep>
          <GuideStep title={g('firstJournal')} text={g('firstJournalText')}>
            <HelpShot topic="dlp" scenario="first" frame="06-journal" side="panel" />
          </GuideStep>
          <GuideStep title={g('firstCounters')} text={g('firstCountersText')}>
            <HelpShot topic="dlp" scenario="first" frame="07-counters" side="panel" />
          </GuideStep>
        </GuideSteps>
      </HelpSection>

      <HelpSection title={g('gateTitle')} caption={g('gateCaption')}>
        <GuideSteps>
          <GuideStep title={g('gateOff')} text={g('gateOffText')}>
            <HelpShot topic="dlp" scenario="gate" frame="01-gate-off" side="panel" />
          </GuideStep>
          <GuideStep title={g('gateOn')} text={g('gateOnText')}>
            <HelpShot topic="dlp" scenario="gate" frame="02-gate-on" side="panel" />
          </GuideStep>
          <GuideStep title={g('gateHook')} text={g('gateHookText')}>
            <HelpShot topic="dlp" scenario="gate" frame="03-hook" side="panel" />
          </GuideStep>
          <GuideStep title={g('gateClaudeOnly')} text={g('gateClaudeOnlyText')}>
            <HelpShot topic="dlp" scenario="gate" frame="04-claude-only" side="panel" />
          </GuideStep>
        </GuideSteps>
      </HelpSection>
    </>
  );
}
