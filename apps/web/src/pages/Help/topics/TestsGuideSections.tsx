import { useTranslation } from 'react-i18next';
import { HelpSection, Callout, GuideSteps, GuideStep, HelpShot, HelpDiagram } from '../ui';

/**
 * Середина документа «Тесты»: весь путь в снимках, двумя сценариями.
 *
 * Сценариев два, потому что путей два, и ходят по ним разные люди. «Первый
 * набор» проходят один раз, заводя раздел в проекте. «Набор, который уже живёт»
 * — то, что делают потом и регулярно: карантин, вердикт вехи, покрытие, обмен с
 * CI. Один длинный сценарий склеил бы их и заставил первого читателя листать
 * чужую половину.
 *
 * Схемы стоят ПЕРЕД шагами: восемнадцать снимков отвечают на «куда нажимать», но
 * не на «что вообще происходит», а второй вопрос возникает первым.
 *
 * Снимки берутся из общего каталога справки по одному правилу (`HelpShot`
 * собирает и адрес файла, и ключ подписи), поэтому здесь нет ни одного пути к
 * картинке. Целость связки «кадр ↔ подпись ↔ файл» проверяет
 * `node tools/qa/check-help-shots.mjs`.
 */
export function TestsGuideSections() {
  const { t } = useTranslation();
  const tr = (key: string): string => t(`help.topics.tests.${key}`);
  const g = (key: string): string => tr(`guide.${key}`);

  return (
    <>
      <HelpSection title={g('mapTitle')} caption={g('mapCaption')}>
        <HelpDiagram topic="tests" name="where-cases-live" />
        <HelpDiagram topic="tests" name="what-turns-red" />
        {/* Тот же путь словами: читатель справки вполне может не видеть
            картинку вовсе, и тогда схема без текста — пустое место. */}
        <Callout tone="info" title={g('mapTextTitle')}>
          {g('mapTextText')}
        </Callout>
      </HelpSection>

      <HelpSection title={g('startTitle')} caption={g('startCaption')}>
        <GuideSteps>
          <GuideStep title={g('wEmpty')} text={g('wEmptyText')}>
            <HelpShot topic="tests" scenario="workspace" frame="01-empty" side="panel" />
          </GuideStep>
          <GuideStep title={g('wEnvironment')} text={g('wEnvironmentText')}>
            <HelpShot topic="tests" scenario="workspace" frame="02-environment" side="panel" />
          </GuideStep>
          <GuideStep title={g('wGroup')} text={g('wGroupText')}>
            <HelpShot topic="tests" scenario="workspace" frame="03-group" side="panel" />
          </GuideStep>
          <GuideStep title={g('wCase')} text={g('wCaseText')}>
            <HelpShot topic="tests" scenario="workspace" frame="04-case" side="panel" />
          </GuideStep>
          <GuideStep title={g('wLibrary')} text={g('wLibraryText')}>
            <HelpShot topic="tests" scenario="workspace" frame="05-library" side="panel" />
          </GuideStep>
          <GuideStep title={g('wRunner')} text={g('wRunnerText')}>
            <HelpShot topic="tests" scenario="workspace" frame="06-runner" side="panel" />
          </GuideStep>
          <GuideStep title={g('wFailed')} text={g('wFailedText')}>
            <HelpShot topic="tests" scenario="workspace" frame="07-runner-failed" side="panel" />
          </GuideStep>
          <GuideStep title={g('wAfter')} text={g('wAfterText')}>
            <HelpShot topic="tests" scenario="workspace" frame="08-library-after" side="panel" />
          </GuideStep>
          <GuideStep title={g('wRecord')} text={g('wRecordText')}>
            <HelpShot topic="tests" scenario="workspace" frame="09-run-record" side="panel" />
          </GuideStep>
          <GuideStep title={g('wReport')} text={g('wReportText')}>
            <HelpShot topic="tests" scenario="workspace" frame="10-report" side="panel" />
          </GuideStep>
        </GuideSteps>
      </HelpSection>

      <HelpSection title={g('liveTitle')} caption={g('liveCaption')}>
        <GuideSteps>
          <GuideStep title={g('hChanged')} text={g('hChangedText')}>
            <HelpShot topic="tests" scenario="health" frame="01-changed-only" side="panel" />
          </GuideStep>
          <GuideStep title={g('hQuarantine')} text={g('hQuarantineText')}>
            <HelpShot topic="tests" scenario="health" frame="02-quarantine" side="panel" />
          </GuideStep>
          <GuideStep title={g('hMuted')} text={g('hMutedText')}>
            <HelpShot topic="tests" scenario="health" frame="03-muted" side="panel" />
          </GuideStep>
          <GuideStep title={g('hRelease')} text={g('hReleaseText')}>
            <HelpShot topic="tests" scenario="health" frame="04-release" side="panel" />
          </GuideStep>
          <GuideStep title={g('hHealth')} text={g('hHealthText')}>
            <HelpShot topic="tests" scenario="health" frame="05-health" side="panel" />
          </GuideStep>
          <GuideStep title={g('hCoverage')} text={g('hCoverageText')}>
            <HelpShot topic="tests" scenario="health" frame="06-coverage" side="panel" />
          </GuideStep>
          <GuideStep title={g('hExchange')} text={g('hExchangeText')}>
            <HelpShot topic="tests" scenario="health" frame="07-exchange" side="panel" />
          </GuideStep>
          <GuideStep title={g('hImported')} text={g('hImportedText')}>
            <HelpShot topic="tests" scenario="health" frame="08-runs-import" side="panel" />
          </GuideStep>
        </GuideSteps>
        {/* Цена карантина названа рядом с шагом, на котором его ставят, а не в
            конце документа: узнать её лучше до, а не после. */}
        <Callout tone="warning" title={g('priceTitle')}>
          {g('priceText')}
        </Callout>
      </HelpSection>

      <Callout tone="info" title={g('shotsTitle')}>
        {g('shotsText')}
      </Callout>
    </>
  );
}
