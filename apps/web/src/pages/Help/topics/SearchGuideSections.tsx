import { HelpSection, Callout, GuideSteps, GuideStep, HelpShot, HelpDiagram } from '../ui';

interface SectionProps {
  /** Перевод ключа `help.topics.search.<key>` — словарь у документа один. */
  tr: (key: string) => string;
}

/**
 * Середина документа «Поиск»: схема охвата и единственный путь в снимках.
 *
 * Сценарий здесь один, и это не экономия: у поиска ровно один вход — строка
 * запроса. Делить его на два было бы враньём про интерфейс. Зато внутри пути
 * показаны три исхода, за которые чаще всего принимают поломку: находки в двух
 * разделах, переменные без значений и честное «ничего не найдено».
 */
export function SearchGuideSections({ tr }: SectionProps) {
  const g = (key: string): string => tr(`guide.${key}`);

  return (
    <>
      <HelpSection title={tr('mapTitle')} caption={tr('mapCaption')}>
        <HelpDiagram topic="search" name="what-search-covers" />
        {/* Тот же охват словами: справку читают и без картинок. */}
        <Callout tone="info" title={tr('pathTextTitle')}>
          {tr('pathTextText')}
        </Callout>
      </HelpSection>

      <HelpSection title={g('findTitle')} caption={g('findCaption')}>
        <GuideSteps>
          <GuideStep title={g('findPrompt')} text={g('findPromptText')}>
            <HelpShot topic="search" scenario="find" frame="01-prompt" side="panel" />
          </GuideStep>
          <GuideStep title={g('findTwo')} text={g('findTwoText')}>
            <HelpShot topic="search" scenario="find" frame="02-two-sections" side="panel" />
          </GuideStep>
          <GuideStep title={g('findEnv')} text={g('findEnvText')}>
            <HelpShot topic="search" scenario="find" frame="03-variables" side="panel" />
          </GuideStep>
          <GuideStep title={g('findEmpty')} text={g('findEmptyText')}>
            <HelpShot topic="search" scenario="find" frame="04-empty" side="panel" />
          </GuideStep>
        </GuideSteps>
      </HelpSection>
    </>
  );
}
