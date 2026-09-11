import { HelpSection, Callout, GuideSteps, GuideStep, HelpShot, HelpDiagram } from '../ui';

interface SectionProps {
  /** Перевод ключа `help.topics.endpoints.<key>`. */
  tr: (key: string) => string;
}

/**
 * Середина документа «Свой эндпоинт»: схема двух хранилищ и путь в кадрах.
 *
 * Схема стоит перед шагами намеренно. Главная путаница раздела не в полях формы,
 * а в границе: профиль у панели работает ровно до кнопки «Применить», и пока её
 * не нажали, ни один CLI об адресе не знает. Шаги без этой границы читаются как
 * «заполнил форму — всё заработало».
 */
export function EndpointsGuideSections({ tr }: SectionProps) {
  const g = (key: string): string => tr(`guide.${key}`);

  return (
    <>
      <HelpSection title={tr('writeMapTitle')} caption={tr('writeMapCaption')}>
        <HelpDiagram topic="endpoints" name="where-the-address-is-written" />
        {/* Тот же путь словами: справку читают и без картинок. */}
        <Callout tone="info" title={tr('pathTextTitle')}>
          {tr('pathTextText')}
        </Callout>
      </HelpSection>

      <HelpSection title={g('localTitle')} caption={g('localCaption')}>
        <GuideSteps>
          <GuideStep title={g('localEmpty')} text={g('localEmptyText')}>
            <HelpShot topic="endpoints" scenario="local" frame="01-empty" side="panel" />
          </GuideStep>
          <GuideStep title={g('localForm')} text={g('localFormText')}>
            <HelpShot topic="endpoints" scenario="local" frame="02-profile" side="panel" />
          </GuideStep>
          <GuideStep title={g('localProbe')} text={g('localProbeText')}>
            <HelpShot topic="endpoints" scenario="local" frame="03-probe" side="panel" />
          </GuideStep>
          <GuideStep title={g('localToken')} text={g('localTokenText')}>
            <HelpShot topic="endpoints" scenario="local" frame="04-token" side="panel" />
          </GuideStep>
          <GuideStep title={g('localKind')} text={g('localKindText')}>
            <HelpShot topic="endpoints" scenario="local" frame="05-targets" side="panel" />
          </GuideStep>
          <GuideStep title={g('localApplied')} text={g('localAppliedText')}>
            <HelpShot topic="endpoints" scenario="local" frame="06-applied" side="panel" />
          </GuideStep>
          <GuideStep title={g('localAssistant')} text={g('localAssistantText')}>
            <HelpShot topic="endpoints" scenario="local" frame="07-assistant" side="panel" />
          </GuideStep>
        </GuideSteps>
      </HelpSection>
    </>
  );
}
