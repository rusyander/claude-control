import { useTranslation } from 'react-i18next';
import {
  HelpSection,
  Callout,
  GuideSteps,
  GuideStep,
  HelpShot,
  HelpDiagram,
  FieldTable,
} from '../../ui';

/**
 * Коды отказов прохода (ядро: `adapters/browser/*`, `walk-tools.ts`) → ключ объяснения. Коды —
 * настоящие строки, которые получает модель: по ним человек находит отказ в ленте задачи.
 */
const REFUSALS: ReadonlyArray<readonly [string, string]> = [
  ['no-browser', 'refusalNoBrowser'],
  ['origin-not-allowed', 'refusalOrigin'],
  ['secret-not-for-this-page', 'refusalNotForPage'],
  ['secret-missing', 'refusalMissing'],
  ['secret-unwired', 'refusalUnwired'],
  ['secret-no-project', 'refusalNoProject'],
  ['secret-unreadable', 'refusalUnreadable'],
  ['secret-unmaskable', 'refusalUnmaskable'],
  ['unsupported', 'refusalUnsupported'],
];

/**
 * Вкладка «Сценарии» в документе «Тесты» (этап 12, R3–R4): записанные проходы по стенду —
 * запись, полоска прогонов, «Прогнать все» без модели и решение по первому расхождению; где
 * ходит проход, как набирается доступ стенда и коды отказов прохода.
 *
 * Отдельным файлом по той же причине, что `TestsE2eSection`: документ упирается в предел длины
 * файла. Кадры — съёмка `tools/help-shots/tests-recorded.mjs` (сценарий `recorded`) на
 * одноразовом стенде с подменами `tools/qa/check-tests-recorded.mjs`; за поведением следит
 * `apps/web/public/help/sources.json` (раздел `tests`).
 */
export function TestsRecordedSection() {
  const { t } = useTranslation();
  const r = (key: string): string => t(`help.topics.tests.recorded.${key}`);

  return (
    <HelpSection title={r('title')} caption={r('caption')}>
      <HelpDiagram topic="tests" name="recorded-replay" />
      <GuideSteps>
        <GuideStep title={r('record')} text={r('recordText')}>
          <HelpShot topic="tests" scenario="recorded" frame="02-record" side="panel" />
        </GuideStep>
        <GuideStep title={r('list')} text={r('listText')}>
          <HelpShot topic="tests" scenario="recorded" frame="01-list" side="panel" />
        </GuideStep>
        <GuideStep title={r('replay')} text={r('replayText')}>
          <HelpShot topic="tests" scenario="recorded" frame="03-mismatch" side="panel" />
        </GuideStep>
        <GuideStep title={r('mismatch')} text={r('mismatchText')}>
          <HelpShot topic="tests" scenario="recorded" frame="04-rerecord" side="panel" />
        </GuideStep>
      </GuideSteps>
      <Callout tone="info" title={r('walkTitle')}>
        {r('walkText')}
      </Callout>
      <Callout tone="info" title={r('secretsTitle')}>
        {r('secretsText')}
      </Callout>
      <FieldTable
        caption={r('refusalsCaption')}
        nameHeader={r('refusalsCode')}
        descriptionHeader={r('refusalsMeaning')}
        rows={REFUSALS.map(([name, key]) => ({ name, description: r(key) }))}
      />
      <Callout tone="warning" title={r('limitsTitle')}>
        {r('limitsText')}
      </Callout>
    </HelpSection>
  );
}
