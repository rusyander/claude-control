import { HelpSection, Callout, GuideSteps, GuideStep, HelpShot, HelpDiagram } from '../ui';

interface SectionProps {
  /** Перевод ключа `help.topics.groups.<key>` — словарь у документа один. */
  tr: (key: string) => string;
}

/**
 * Середина документа «Группы»: как это устроено и оба пути в снимках.
 *
 * Сценария два, и делятся они по входу. `bundle` — набор под задачу, который
 * включают руками: состав, конфликт прав, переменные и, главное, что тумблер
 * группы делает с разделом «Правила». `auto` — группа, которая включается сама:
 * привязка к проектам, порядок работы шагами и сценарий, ставший хуком. Первый
 * путь проходят все, второй — только те, кому нужна автоматика, и мешать их в
 * одну простыню значило бы заставлять листать чужое.
 *
 * Схемы стоят ПЕРЕД шагами: два самых частых вопроса раздела — «почему участник
 * не включился» и «откуда в settings.json этот хук» — не видны ни в одном
 * состоянии экрана. Обе схемы отвечают именно на них.
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

      <HelpSection title={g('bundleTitle')} caption={g('bundleCaption')}>
        <GuideSteps>
          <GuideStep title={g('bEmpty')} text={g('bEmptyText')}>
            <HelpShot topic="groups" scenario="bundle" frame="01-empty" side="panel" />
          </GuideStep>
          <GuideStep title={g('bForm')} text={g('bFormText')}>
            <HelpShot topic="groups" scenario="bundle" frame="02-form" side="panel" />
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
          <GuideStep title={g('aSteps')} text={g('aStepsText')}>
            <HelpShot topic="groups" scenario="auto" frame="02-steps" side="panel" />
          </GuideStep>
          <GuideStep title={g('aTrigger')} text={g('aTriggerText')}>
            <HelpShot topic="groups" scenario="auto" frame="03-trigger-error" side="panel" />
          </GuideStep>
          <GuideStep title={g('aCard')} text={g('aCardText')}>
            <HelpShot topic="groups" scenario="auto" frame="04-card" side="panel" />
          </GuideStep>
          <GuideStep title={g('aSkill')} text={g('aSkillText')}>
            <HelpShot topic="groups" scenario="auto" frame="05-skill" side="panel" />
          </GuideStep>
          <GuideStep title={g('aForm')} text={g('aFormText')}>
            <HelpShot topic="groups" scenario="auto" frame="06-automation-form" side="panel" />
          </GuideStep>
          <GuideStep title={g('aAutomation')} text={g('aAutomationText')}>
            <HelpShot topic="groups" scenario="auto" frame="07-automation-card" side="panel" />
          </GuideStep>
          <GuideStep title={g('aHooks')} text={g('aHooksText')}>
            <HelpShot topic="groups" scenario="auto" frame="08-hooks" side="panel" />
          </GuideStep>
        </GuideSteps>
      </HelpSection>

      <Callout tone="info" title={g('shotsTitle')}>
        {g('shotsText')}
      </Callout>
    </>
  );
}
