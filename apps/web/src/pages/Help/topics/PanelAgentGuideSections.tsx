import { HelpSection, Callout, GuideSteps, GuideStep, HelpShot, HelpDiagram } from '../ui';

interface SectionProps {
  /** Перевод ключа `help.topics.panelAgent.<key>`. */
  tr: (key: string) => string;
}

/**
 * Середина документа «Агент панели»: схема пути действия и два пути в снимках.
 *
 * Пути делятся по входу: один пришёл, чтобы панель сделала что-то по его словам,
 * другой — потому что агент отказал или «не сделал». Второму не нужно листать
 * первый, чтобы узнать, что ключ контура агенту не отдаётся намеренно.
 */
export function PanelAgentGuideSections({ tr }: SectionProps) {
  const g = (key: string): string => tr(`guide.${key}`);
  return (
    <>
      <HelpSection title={tr('pathMapTitle')} caption={tr('pathMapCaption')}>
        <HelpDiagram topic="panelAgent" name="action-path" />
        {/* Тот же путь словами: справку читают и без картинок. */}
        <Callout tone="info" title={tr('pathTextTitle')}>
          {tr('pathTextText')}
        </Callout>
      </HelpSection>

      <HelpSection title={g('firstTitle')} caption={g('firstCaption')}>
        <GuideSteps>
          <GuideStep title={g('firstLauncher')} text={g('firstLauncherText')}>
            <HelpShot topic="panelAgent" scenario="first" frame="01-launcher" side="panel" />
          </GuideStep>
          <GuideStep title={g('firstEmpty')} text={g('firstEmptyText')}>
            <HelpShot topic="panelAgent" scenario="first" frame="02-empty" side="panel" />
          </GuideStep>
          <GuideStep title={g('firstChange')} text={g('firstChangeText')}>
            <HelpShot topic="panelAgent" scenario="first" frame="03-change-card" side="panel" />
          </GuideStep>
          <GuideStep title={g('firstDone')} text={g('firstDoneText')}>
            <HelpShot topic="panelAgent" scenario="first" frame="04-done" side="panel" />
          </GuideStep>
          <GuideStep title={g('firstDiff')} text={g('firstDiffText')}>
            <HelpShot topic="panelAgent" scenario="first" frame="05-diff-card" side="panel" />
          </GuideStep>
          <GuideStep title={g('firstSaved')} text={g('firstSavedText')}>
            <HelpShot topic="panelAgent" scenario="first" frame="06-rule-saved" side="panel" />
          </GuideStep>
          <GuideStep title={g('firstDanger')} text={g('firstDangerText')}>
            <HelpShot topic="panelAgent" scenario="first" frame="07-danger-card" side="panel" />
          </GuideStep>
          <GuideStep title={g('firstRejected')} text={g('firstRejectedText')}>
            <HelpShot topic="panelAgent" scenario="first" frame="08-rejected" side="panel" />
          </GuideStep>
          <GuideStep title={g('firstJournal')} text={g('firstJournalText')}>
            <HelpShot topic="panelAgent" scenario="first" frame="09-journal" side="panel" />
          </GuideStep>
          <GuideStep title={g('firstHistory')} text={g('firstHistoryText')}>
            <HelpShot topic="panelAgent" scenario="first" frame="10-history" side="panel" />
          </GuideStep>
        </GuideSteps>
      </HelpSection>

      <HelpSection title={g('guardsTitle')} caption={g('guardsCaption')}>
        <GuideSteps>
          <GuideStep title={g('guardsContour')} text={g('guardsContourText')}>
            <HelpShot topic="panelAgent" scenario="guards" frame="01-contour-card" side="panel" />
          </GuideStep>
          <GuideStep title={g('guardsKeyField')} text={g('guardsKeyFieldText')}>
            <HelpShot topic="panelAgent" scenario="guards" frame="02-key-field" side="panel" />
          </GuideStep>
          <GuideStep title={g('guardsMasked')} text={g('guardsMaskedText')}>
            <HelpShot topic="panelAgent" scenario="guards" frame="03-key-masked" side="panel" />
          </GuideStep>
          <GuideStep title={g('guardsStale')} text={g('guardsStaleText')}>
            <HelpShot topic="panelAgent" scenario="guards" frame="04-stale" side="panel" />
          </GuideStep>
          <GuideStep title={g('guardsMcpCard')} text={g('guardsMcpCardText')}>
            <HelpShot topic="panelAgent" scenario="guards" frame="05-mcp-card" side="panel" />
          </GuideStep>
          <GuideStep title={g('guardsMcpSecret')} text={g('guardsMcpSecretText')}>
            <HelpShot topic="panelAgent" scenario="guards" frame="06-mcp-secret" side="panel" />
          </GuideStep>
          <GuideStep title={g('guardsOtherCli')} text={g('guardsOtherCliText')}>
            <HelpShot topic="panelAgent" scenario="guards" frame="07-other-cli" side="panel" />
          </GuideStep>
          <GuideStep title={g('guardsDlp')} text={g('guardsDlpText')}>
            <HelpShot topic="panelAgent" scenario="guards" frame="08-dlp-broken" side="panel" />
          </GuideStep>
          <GuideStep title={g('guardsCli')} text={g('guardsCliText')}>
            <HelpShot topic="panelAgent" scenario="guards" frame="09-cli-not-found" side="panel" />
          </GuideStep>
          <GuideStep title={g('guardsEndpoint')} text={g('guardsEndpointText')}>
            <HelpShot
              topic="panelAgent"
              scenario="guards"
              frame="10-endpoint-unsupported"
              side="panel"
            />
          </GuideStep>
          <GuideStep title={g('guardsContourDown')} text={g('guardsContourDownText')}>
            <HelpShot
              topic="panelAgent"
              scenario="guards"
              frame="11-contour-unreachable"
              side="panel"
            />
          </GuideStep>
          <GuideStep title={g('guardsBusy')} text={g('guardsBusyText')}>
            <HelpShot topic="panelAgent" scenario="guards" frame="12-busy" side="panel" />
          </GuideStep>
        </GuideSteps>
      </HelpSection>

      <HelpSection title={tr('keysMapTitle')} caption={tr('keysMapCaption')}>
        <HelpDiagram topic="panelAgent" name="keys-and-files" />
      </HelpSection>
    </>
  );
}
