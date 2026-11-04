import { HelpSection, Callout, GuideSteps, GuideStep, HelpShot, HelpDiagram } from '../../ui';
import type { SectionProps } from './ChatGuideSections.types';

/**
 * Середина документа «Чат»: как это устроено и весь путь в снимках.
 *
 * Сценарий съёмки один — `basics`: один разговор от пустого окна до конца хода.
 * Путь «разговор стал несколькими» (`split`) ушёл вместе с разделением: группы
 * и деревья теперь сценарии ядра, их кадры — в справке «Ядро».
 *
 * Схема стоит ПЕРЕД шагами: десяток снимков подряд отвечают на вопрос «куда
 * нажимать», но не на вопрос «что вообще происходит», а второй возникает
 * первым — и ответа на него на экране нет ни в одном состоянии.
 *
 * Ни одного пути к картинке здесь нет: `HelpShot` и `HelpDiagram` собирают и
 * адрес файла, и ключ подписи по одному правилу. Целость связки
 * «кадр ↔ подпись ↔ файл» проверяет `node tools/qa/check-help-shots.mjs`.
 */
export function ChatGuideSections({ tr }: SectionProps) {
  const g = (key: string): string => tr(`guide.${key}`);

  return (
    <>
      <HelpSection title={g('mapTitle')} caption={g('mapCaption')}>
        <HelpDiagram topic="chat" name="message-path" />
        {/* Тот же путь словами: читатель справки вполне может не видеть
            картинку вовсе, и тогда схема без текста — пустое место. */}
        <Callout tone="info" title={g('pathTextTitle')}>
          {g('pathTextText')}
        </Callout>
      </HelpSection>

      <HelpSection title={g('basicsTitle')} caption={g('basicsCaption')}>
        <GuideSteps>
          <GuideStep title={g('bEmpty')} text={g('bEmptyText')}>
            <HelpShot topic="chat" scenario="basics" frame="01-project-empty" side="panel" />
          </GuideStep>
          <GuideStep title={g('bComposer')} text={g('bComposerText')}>
            <HelpShot topic="chat" scenario="basics" frame="02-composer" side="panel" />
          </GuideStep>
          <GuideStep title={g('bAnswer')} text={g('bAnswerText')}>
            <HelpShot topic="chat" scenario="basics" frame="03-answer" side="panel" />
          </GuideStep>
          <GuideStep title={g('bPermission')} text={g('bPermissionText')}>
            <HelpShot topic="chat" scenario="basics" frame="04-permission" side="panel" />
          </GuideStep>
          <GuideStep title={g('bQuestion')} text={g('bQuestionText')}>
            <HelpShot topic="chat" scenario="basics" frame="05-question" side="panel" />
          </GuideStep>
          <GuideStep title={g('bBranch')} text={g('bBranchText')}>
            <HelpShot topic="chat" scenario="basics" frame="06-branch" side="panel" />
          </GuideStep>
          <GuideStep title={g('bMenu')} text={g('bMenuText')}>
            <HelpShot topic="chat" scenario="basics" frame="07-menu" side="panel" />
          </GuideStep>
          <GuideStep title={g('bAgents')} text={g('bAgentsText')}>
            <HelpShot topic="chat" scenario="basics" frame="09-agents" side="panel" />
          </GuideStep>
          <GuideStep title={g('bTree')} text={g('bTreeText')}>
            <HelpShot topic="chat" scenario="agents" frame="01-tree" side="panel" />
          </GuideStep>
          <GuideStep title={g('bExtensions')} text={g('bExtensionsText')}>
            <HelpShot topic="chat" scenario="agents" frame="02-extensions" side="panel" />
          </GuideStep>
          <GuideStep title={g('bHandoff')} text={g('bHandoffText')}>
            <HelpShot topic="chat" scenario="basics" frame="10-handoff" side="panel" />
          </GuideStep>
        </GuideSteps>
      </HelpSection>

      <Callout tone="info" title={g('shotsTitle')}>
        {g('shotsText')}
      </Callout>
    </>
  );
}
