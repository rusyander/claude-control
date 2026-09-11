import { HelpSection, Callout, GuideSteps, GuideStep, HelpShot, HelpDiagram } from '../ui';

interface SectionProps {
  /** Перевод ключа `help.topics.providers.<key>`. */
  tr: (key: string) => string;
}

/**
 * Середина документа «Провайдеры»: схема переключения и путь в кадрах.
 *
 * Путь здесь один, потому что вход в раздел один: человек приходит сюда, уже
 * решив попробовать другой CLI. Разбивать его на «выбрать» и «проверить» было бы
 * делением по экранам, а не по задачам — проверка без выбора не существует.
 *
 * Рукописного списка шагов у этого пути больше нет: те же шаги показаны кадрами
 * настоящей панели, и расходиться им теперь не с чем.
 */
export function ProvidersGuideSections({ tr }: SectionProps) {
  const g = (key: string): string => tr(`guide.${key}`);

  return (
    <>
      <HelpSection title={tr('switchMapTitle')} caption={tr('switchMapCaption')}>
        <HelpDiagram topic="providers" name="what-switching-changes" />
        {/* Тот же путь словами: справку читают и без картинок. */}
        <Callout tone="info" title={tr('pathTextTitle')}>
          {tr('pathTextText')}
        </Callout>
      </HelpSection>

      <HelpSection title={g('switchTitle')} caption={g('switchCaption')}>
        <GuideSteps>
          <GuideStep title={g('switchSelector')} text={g('switchSelectorText')}>
            <HelpShot topic="providers" scenario="switch" frame="01-selector" side="panel" />
          </GuideStep>
          <GuideStep title={g('switchChosen')} text={g('switchChosenText')}>
            <HelpShot topic="providers" scenario="switch" frame="02-chosen" side="panel" />
          </GuideStep>
          <GuideStep title={g('switchCheck')} text={g('switchCheckText')}>
            <HelpShot topic="providers" scenario="switch" frame="03-check" side="panel" />
          </GuideStep>
          <GuideStep title={g('switchResult')} text={g('switchResultText')}>
            <HelpShot topic="providers" scenario="switch" frame="04-check-result" side="panel" />
          </GuideStep>
          <GuideStep title={g('switchKeys')} text={g('switchKeysText')}>
            <HelpShot topic="providers" scenario="switch" frame="05-keys" side="panel" />
          </GuideStep>
          <GuideStep title={g('switchFormat')} text={g('switchFormatText')}>
            <HelpShot topic="providers" scenario="switch" frame="06-format" side="panel" />
          </GuideStep>
          <GuideStep title={g('switchPanel')} text={g('switchPanelText')}>
            <HelpShot topic="providers" scenario="switch" frame="07-panel" side="panel" />
          </GuideStep>
        </GuideSteps>
      </HelpSection>
    </>
  );
}
