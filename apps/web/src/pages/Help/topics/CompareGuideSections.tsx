import { HelpSection, Callout, GuideSteps, GuideStep, HelpShot, HelpDiagram } from '../ui';

interface SectionProps {
  /** Перевод ключа `help.topics.compare.<key>` — словарь у документа один. */
  tr: (key: string) => string;
}

/**
 * Середина документа «Сравнение конфигураций»: схема охвата и два пути в снимках.
 *
 * Сценарии делятся ПО ВХОДУ, но разница между ними — цена ошибки. «Посмотреть» —
 * чтение: на диске не меняется ничего. «Перенести» — запись в файл ЧУЖОГО CLI,
 * который человек до этого вёл руками, поэтому путь идёт через предпросмотр, и
 * половина его кадров про то, чего панель делать откажется.
 */
export function CompareGuideSections({ tr }: SectionProps) {
  const g = (key: string): string => tr(`guide.${key}`);

  return (
    <>
      <HelpSection title={tr('mapTitle')} caption={tr('mapCaption')}>
        <HelpDiagram topic="compare" name="what-crosses-and-what-does-not" />
        {/* Тот же охват словами: справку читают и без картинок. */}
        <Callout tone="info" title={tr('pathTextTitle')}>
          {tr('pathTextText')}
        </Callout>
      </HelpSection>

      <HelpSection title={g('lookTitle')} caption={g('lookCaption')}>
        <GuideSteps>
          <GuideStep title={g('lookMcp')} text={g('lookMcpText')}>
            <HelpShot topic="compare" scenario="look" frame="01-mcp" side="panel" />
          </GuideStep>
          <GuideStep title={g('lookEnv')} text={g('lookEnvText')}>
            <HelpShot topic="compare" scenario="look" frame="02-env" side="panel" />
          </GuideStep>
          <GuideStep title={g('lookInstructions')} text={g('lookInstructionsText')}>
            <HelpShot topic="compare" scenario="look" frame="03-instructions" side="panel" />
          </GuideStep>
        </GuideSteps>
      </HelpSection>

      <HelpSection title={g('moveTitle')} caption={g('moveCaption')}>
        <GuideSteps>
          <GuideStep title={g('moveBlocked')} text={g('moveBlockedText')}>
            <HelpShot topic="compare" scenario="move" frame="01-blocked" side="panel" />
          </GuideStep>
          <GuideStep title={g('moveSelected')} text={g('moveSelectedText')}>
            <HelpShot topic="compare" scenario="move" frame="02-selected" side="panel" />
          </GuideStep>
          <GuideStep title={g('movePreview')} text={g('movePreviewText')}>
            <HelpShot topic="compare" scenario="move" frame="03-preview" side="panel" />
          </GuideStep>
          <GuideStep title={g('moveApplied')} text={g('moveAppliedText')}>
            <HelpShot topic="compare" scenario="move" frame="04-applied" side="panel" />
          </GuideStep>
        </GuideSteps>
      </HelpSection>
    </>
  );
}
