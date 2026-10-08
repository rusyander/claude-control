import { HelpSection, Callout, GuideSteps, GuideStep, HelpShot, HelpDiagram } from '../../ui';
import type { SectionProps } from './GroupsGuideSections.types';

/**
 * Середина документа «Группы»: как это устроено и четыре пути в снимках.
 *
 * Сценариев четыре, и делятся они по входу. `sources` — откуда берутся группы:
 * обнаружение, находка, пара «глобальная ↔ проектная», копия и слияние.
 * `path` — свой шаг в порядке работы, окно шага с ассистентом. `bundle` —
 * набор под задачу, который включают руками: состав, конфликт прав, переменные
 * и, главное, что тумблер группы делает с разделом «Правила». `auto` — группа,
 * которая включается сама: привязка, строка «Когда уместна», автоматизация,
 * ставшая хуком, и сценарий — группа из одних шагов. Мешать их в одну простыню значило бы заставлять листать чужое.
 *
 * Схемы стоят ПЕРЕД шагами: два самых частых вопроса раздела — «почему участник
 * не включился» и «куда уходит группа» — не видны ни в одном состоянии экрана.
 * Обе схемы отвечают именно на них.
 *
 * Ни одного пути к картинке здесь нет: `HelpShot` и `HelpDiagram` собирают и
 * адрес файла, и ключ подписи по одному правилу. Целость связки
 * «кадр ↔ подпись ↔ файл» проверяет `node tools/qa/check-help-shots.mjs`.
 */
export function GroupsGuideSections({ tr }: SectionProps) {
  const g = (key: string): string => tr(`guide.${key}`);

  return (
    <>
      <HelpSection title={g('mapTitle')} caption={g('mapCaption')}>
        <HelpDiagram topic="groups" name="two-marks" />
        <HelpDiagram topic="groups" name="compiled-set" />
        {/* Тот же путь словами: читатель справки вполне может не видеть
            картинку вовсе, и тогда схема без текста — пустое место. */}
        <Callout tone="info" title={g('pathTextTitle')}>
          {g('pathTextText')}
        </Callout>
      </HelpSection>

      <HelpSection title={g('sourcesTitle')} caption={g('sourcesCaption')}>
        <GuideSteps>
          <GuideStep title={g('sSections')} text={g('sSectionsText')}>
            <HelpShot topic="groups" scenario="sources" frame="01-sections" side="panel" />
          </GuideStep>
          <GuideStep title={g('sFound')} text={g('sFoundText')}>
            <HelpShot topic="groups" scenario="sources" frame="02-found" side="panel" />
          </GuideStep>
          <GuideStep title={g('sPair')} text={g('sPairText')}>
            <HelpShot topic="groups" scenario="sources" frame="03-pair" side="panel" />
          </GuideStep>
          <GuideStep title={g('sCopy')} text={g('sCopyText')}>
            <HelpShot topic="groups" scenario="sources" frame="04-copy" side="panel" />
          </GuideStep>
          <GuideStep title={g('sDuplicate')} text={g('sDuplicateText')}>
            <HelpShot topic="groups" scenario="sources" frame="07-duplicate" side="panel" />
          </GuideStep>
          <GuideStep title={g('sMerge')} text={g('sMergeText')}>
            <HelpShot topic="groups" scenario="sources" frame="05-merge" side="panel" />
          </GuideStep>
          <GuideStep title={g('sDetails')} text={g('sDetailsText')}>
            <HelpShot topic="groups" scenario="sources" frame="06-details" side="panel" />
          </GuideStep>
        </GuideSteps>
      </HelpSection>

      <HelpSection title={g('pathTitle')} caption={g('pathCaption')}>
        <GuideSteps>
          <GuideStep title={g('pPath')} text={g('pPathText')}>
            <HelpShot topic="groups" scenario="path" frame="01-path" side="panel" />
          </GuideStep>
          <GuideStep title={g('pAsk')} text={g('pAskText')}>
            <HelpShot topic="groups" scenario="path" frame="02-ask" side="panel" />
          </GuideStep>
          <GuideStep title={g('pProposal')} text={g('pProposalText')}>
            <HelpShot topic="groups" scenario="path" frame="03-proposal" side="panel" />
          </GuideStep>
          <GuideStep title={g('pTranslate')} text={g('pTranslateText')}>
            <HelpShot topic="groups" scenario="path" frame="04-translate" side="panel" />
          </GuideStep>
          <GuideStep title={g('pPromote')} text={g('pPromoteText')}>
            <HelpShot topic="groups" scenario="path" frame="05-promote" side="panel" />
          </GuideStep>
          <GuideStep title={g('pSummary')} text={g('pSummaryText')}>
            <HelpShot topic="groups" scenario="path" frame="06-summary" side="panel" />
          </GuideStep>
          <GuideStep title={g('pKnobs')} text={g('pKnobsText')}>
            <HelpShot topic="groups" scenario="path" frame="07-knobs" side="panel" />
          </GuideStep>
          <GuideStep title={g('pPick')} text={g('pPickText')}>
            <HelpShot topic="groups" scenario="path" frame="08-pick" side="panel" />
          </GuideStep>
          <GuideStep title={g('pHook')} text={g('pHookText')}>
            <HelpShot topic="groups" scenario="path" frame="09-hook" side="panel" />
          </GuideStep>
        </GuideSteps>
      </HelpSection>

      <HelpSection title={g('bundleTitle')} caption={g('bundleCaption')}>
        <GuideSteps>
          <GuideStep title={g('bEmpty')} text={g('bEmptyText')}>
            <HelpShot topic="groups" scenario="bundle" frame="01-empty" side="panel" />
          </GuideStep>
          <GuideStep title={g('bKind')} text={g('bKindText')}>
            <HelpShot topic="groups" scenario="bundle" frame="01-kind" side="panel" />
          </GuideStep>
          <GuideStep title={g('bForm')} text={g('bFormText')}>
            <HelpShot topic="groups" scenario="bundle" frame="02-form" side="panel" />
          </GuideStep>
          <GuideStep title={g('bOrder')} text={g('bOrderText')}>
            <HelpShot topic="groups" scenario="bundle" frame="02-order" side="panel" />
          </GuideStep>
          <GuideStep title={g('bConflict')} text={g('bConflictText')}>
            <HelpShot topic="groups" scenario="bundle" frame="03-conflict" side="panel" />
          </GuideStep>
          <GuideStep title={g('bEnv')} text={g('bEnvText')}>
            <HelpShot topic="groups" scenario="bundle" frame="04-env" side="panel" />
          </GuideStep>
          <GuideStep title={g('bCard')} text={g('bCardText')}>
            <HelpShot topic="groups" scenario="bundle" frame="05-card" side="panel" />
          </GuideStep>
          <GuideStep title={g('bOff')} text={g('bOffText')}>
            <HelpShot topic="groups" scenario="bundle" frame="06-off" side="panel" />
          </GuideStep>
          <GuideStep title={g('bRulesOff')} text={g('bRulesOffText')}>
            <HelpShot topic="groups" scenario="bundle" frame="07-rules-off" side="panel" />
          </GuideStep>
          <GuideStep title={g('bRulesOn')} text={g('bRulesOnText')}>
            <HelpShot topic="groups" scenario="bundle" frame="08-rules-on" side="panel" />
          </GuideStep>
          <GuideStep title={g('bDelete')} text={g('bDeleteText')}>
            <HelpShot topic="groups" scenario="bundle" frame="09-delete" side="panel" />
          </GuideStep>
        </GuideSteps>
      </HelpSection>

      <HelpSection title={g('autoTitle')} caption={g('autoCaption')}>
        <GuideSteps>
          <GuideStep title={g('aBinding')} text={g('aBindingText')}>
            <HelpShot topic="groups" scenario="auto" frame="01-binding" side="panel" />
          </GuideStep>
          <GuideStep title={g('aWhen')} text={g('aWhenText')}>
            <HelpShot topic="groups" scenario="auto" frame="02-when" side="panel" />
          </GuideStep>
          <GuideStep title={g('aDetails')} text={g('aDetailsText')}>
            <HelpShot topic="groups" scenario="auto" frame="03-details" side="panel" />
          </GuideStep>
          <GuideStep title={g('aScenario')} text={g('aScenarioText')}>
            <HelpShot topic="groups" scenario="auto" frame="07-scenario" side="panel" />
          </GuideStep>
        </GuideSteps>
      </HelpSection>

      <Callout tone="info" title={g('shotsTitle')}>
        {g('shotsText')}
      </Callout>
    </>
  );
}
