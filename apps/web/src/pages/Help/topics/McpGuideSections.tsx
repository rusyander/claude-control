import { HelpSection, Callout, GuideSteps, GuideStep, HelpShot, HelpDiagram } from '../ui';

interface SectionProps {
  /** Перевод ключа `help.topics.mcp.<key>` — словарь у документа один. */
  tr: (key: string) => string;
}

/**
 * Середина документа «MCP-серверы»: схемы механизма и два пути в снимках.
 *
 * Сценариев два, и делятся они ПО ВХОДУ: «подключить» проходят один раз на
 * сервер, «не отвечает» — каждый раз, когда карточка краснеет. Второй читают в
 * состоянии «уже сломалось», и листать ради него первый не приходится.
 *
 * Схемы стоят ПЕРЕД шагами, потому что обе отвечают на вопросы, которые
 * возникают раньше «куда нажимать»: что именно делает кнопка проверки (а не
 * «пингует порт») и кто держит сервер во время настоящей работы — из второго
 * растёт «панель закрыта, почему агент всё ещё видит инструменты».
 */
export function McpGuideSections({ tr }: SectionProps) {
  const g = (key: string): string => tr(`guide.${key}`);

  return (
    <>
      <HelpSection title={tr('mapTitle')} caption={tr('mapCaption')}>
        <HelpDiagram topic="mcp" name="probe-path" />
        <HelpDiagram topic="mcp" name="who-runs-what" />
        {/* Тот же путь словами: справку читают и без картинок. */}
        <Callout tone="info" title={tr('pathTextTitle')}>
          {tr('pathTextText')}
        </Callout>
      </HelpSection>

      <HelpSection title={g('connectTitle')} caption={g('connectCaption')}>
        <GuideSteps>
          <GuideStep title={g('connectEmpty')} text={g('connectEmptyText')}>
            <HelpShot topic="mcp" scenario="connect" frame="01-empty" side="panel" />
          </GuideStep>
          <GuideStep title={g('connectForm')} text={g('connectFormText')}>
            <HelpShot topic="mcp" scenario="connect" frame="02-form-presets" side="panel" />
          </GuideStep>
          <GuideStep title={g('connectImport')} text={g('connectImportText')}>
            <HelpShot topic="mcp" scenario="connect" frame="03-import" side="panel" />
          </GuideStep>
          <GuideStep title={g('connectCard')} text={g('connectCardText')}>
            <HelpShot topic="mcp" scenario="connect" frame="04-card-unknown" side="panel" />
          </GuideStep>
          <GuideStep title={g('connectHealth')} text={g('connectHealthText')}>
            <HelpShot topic="mcp" scenario="connect" frame="05-connected" side="panel" />
          </GuideStep>
          <GuideStep title={g('connectTools')} text={g('connectToolsText')}>
            <HelpShot topic="mcp" scenario="connect" frame="06-tools" side="panel" />
          </GuideStep>
        </GuideSteps>
      </HelpSection>

      <HelpSection title={g('troubleTitle')} caption={g('troubleCaption')}>
        <GuideSteps>
          <GuideStep title={g('troubleFailed')} text={g('troubleFailedText')}>
            <HelpShot topic="mcp" scenario="trouble" frame="01-failed" side="panel" />
          </GuideStep>
          <GuideStep title={g('troubleVar')} text={g('troubleVarText')}>
            <HelpShot topic="mcp" scenario="trouble" frame="02-missing-var" side="panel" />
          </GuideStep>
          <GuideStep title={g('troubleRejected')} text={g('troubleRejectedText')}>
            <HelpShot topic="mcp" scenario="trouble" frame="03-token-rejected" side="panel" />
          </GuideStep>
          <GuideStep title={g('troubleOauth')} text={g('troubleOauthText')}>
            <HelpShot topic="mcp" scenario="trouble" frame="04-oauth" side="panel" />
          </GuideStep>
          <GuideStep title={g('troubleDisabled')} text={g('troubleDisabledText')}>
            <HelpShot topic="mcp" scenario="trouble" frame="05-disabled" side="panel" />
          </GuideStep>
          <GuideStep title={g('troubleHeaders')} text={g('troubleHeadersText')}>
            <HelpShot topic="mcp" scenario="trouble" frame="06-headers" side="panel" />
          </GuideStep>
        </GuideSteps>
      </HelpSection>
    </>
  );
}
