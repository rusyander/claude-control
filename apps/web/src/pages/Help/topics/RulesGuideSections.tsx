import { HelpSection, Callout, GuideSteps, GuideStep, HelpShot, HelpDiagram } from '../ui';

interface SectionProps {
  /** Перевод ключа `help.topics.rules.<key>` — словарь у документа один. */
  tr: (key: string) => string;
}

/**
 * Середина документа «Правила»: как это устроено и оба пути в снимках.
 *
 * Сценариев съёмки два, и делятся они по входу, а не по объёму. `first` — путь
 * от пустого раздела до правила, проверенного разговором: его проходят один раз
 * и потом не вспоминают. `living` — готовый свод: поиск, выключение и самый
 * частый вопрос живого файла, «правил ноль, хотя файл не пустой». Человеку со
 * сводом первый путь уже не нужен, и держать оба одной простынёй значило бы
 * заставлять его листать чужое.
 *
 * Схемы стоят ПЕРЕД шагами: снимки отвечают на вопрос «куда нажимать», но не на
 * вопрос «что панель считает правилом», а второй возникает первым — и ответа на
 * него нет ни в одном состоянии экрана.
 *
 * Ни одного пути к картинке здесь нет: `HelpShot` и `HelpDiagram` собирают и
 * адрес файла, и ключ подписи по одному правилу. Целость связки
 * «кадр ↔ подпись ↔ файл» проверяет `node tools/qa/check-help-shots.mjs`.
 */
export function RulesGuideSections({ tr }: SectionProps) {
  const g = (key: string): string => tr(`guide.${key}`);

  return (
    <>
      <HelpSection title={g('mapTitle')} caption={g('mapCaption')}>
        <HelpDiagram topic="rules" name="rule-round-trip" />
        <HelpDiagram topic="rules" name="rule-states" />
        {/* Тот же путь словами: читатель справки вполне может не видеть
            картинку вовсе, и тогда схема без текста — пустое место. */}
        <Callout tone="info" title={g('pathTextTitle')}>
          {g('pathTextText')}
        </Callout>
      </HelpSection>

      <HelpSection title={g('firstTitle')} caption={g('firstCaption')}>
        <GuideSteps>
          <GuideStep title={g('fEmpty')} text={g('fEmptyText')}>
            <HelpShot topic="rules" scenario="first" frame="01-empty" side="panel" />
          </GuideStep>
          <GuideStep title={g('fForm')} text={g('fFormText')}>
            <HelpShot topic="rules" scenario="first" frame="02-form" side="panel" />
          </GuideStep>
          <GuideStep title={g('fBuilder')} text={g('fBuilderText')}>
            <HelpShot topic="rules" scenario="first" frame="03-builder" side="panel" />
          </GuideStep>
          <GuideStep title={g('fAssistant')} text={g('fAssistantText')}>
            <HelpShot topic="rules" scenario="first" frame="04-assistant" side="panel" />
          </GuideStep>
          <GuideStep title={g('fCard')} text={g('fCardText')}>
            <HelpShot topic="rules" scenario="first" frame="05-card" side="panel" />
          </GuideStep>
          <GuideStep title={g('fBulk')} text={g('fBulkText')}>
            <HelpShot topic="rules" scenario="first" frame="06-bulk" side="panel" />
          </GuideStep>
          <GuideStep title={g('fSandbox')} text={g('fSandboxText')}>
            <HelpShot topic="rules" scenario="first" frame="07-sandbox" side="panel" />
          </GuideStep>
        </GuideSteps>
      </HelpSection>

      <HelpSection title={g('livingTitle')} caption={g('livingCaption')}>
        <GuideSteps>
          <GuideStep title={g('lList')} text={g('lListText')}>
            <HelpShot topic="rules" scenario="living" frame="01-list" side="panel" />
          </GuideStep>
          <GuideStep title={g('lSearch')} text={g('lSearchText')}>
            <HelpShot topic="rules" scenario="living" frame="02-search" side="panel" />
          </GuideStep>
          <GuideStep title={g('lOff')} text={g('lOffText')}>
            <HelpShot topic="rules" scenario="living" frame="03-off" side="panel" />
          </GuideStep>
          <GuideStep title={g('lFile')} text={g('lFileText')}>
            <HelpShot topic="rules" scenario="living" frame="04-file-disabled" side="panel" />
          </GuideStep>
          <GuideStep title={g('lZero')} text={g('lZeroText')}>
            <HelpShot topic="rules" scenario="living" frame="05-zero" side="panel" />
          </GuideStep>
        </GuideSteps>
      </HelpSection>

      <Callout tone="info" title={g('shotsTitle')}>
        {g('shotsText')}
      </Callout>
    </>
  );
}
