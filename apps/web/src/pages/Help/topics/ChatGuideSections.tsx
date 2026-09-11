import { HelpSection, Callout, GuideSteps, GuideStep, HelpShot, HelpDiagram } from '../ui';

interface SectionProps {
  /** Перевод ключа `help.topics.chat.<key>` — словарь у документа один. */
  tr: (key: string) => string;
}

/**
 * Середина документа «Чат»: как это устроено и весь путь в снимках.
 *
 * Сценариев съёмки два, и делятся они не по объёму, а по входу. `basics` —
 * один разговор от пустого окна до конца прогона: его читают с первого дня.
 * `split` — разговор, который стал несколькими: человек, никогда не делящий
 * задачи, туда не заходит вовсе, и держать оба пути одной простынёй значило бы
 * заставлять его пролистывать чужое.
 *
 * Схемы стоят ПЕРЕД шагами: семнадцать снимков подряд отвечают на вопрос «куда
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
        <HelpDiagram topic="chat" name="split-conveyor" />
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
          <GuideStep title={g('bActions')} text={g('bActionsText')}>
            <HelpShot topic="chat" scenario="basics" frame="08-menu-actions" side="panel" />
          </GuideStep>
          <GuideStep title={g('bAgents')} text={g('bAgentsText')}>
            <HelpShot topic="chat" scenario="basics" frame="09-agents" side="panel" />
          </GuideStep>
          <GuideStep title={g('bHandoff')} text={g('bHandoffText')}>
            <HelpShot topic="chat" scenario="basics" frame="10-handoff" side="panel" />
          </GuideStep>
        </GuideSteps>
      </HelpSection>

      <HelpSection title={g('splitTitle')} caption={g('splitCaption')}>
        <GuideSteps>
          <GuideStep title={g('sProposal')} text={g('sProposalText')}>
            <HelpShot topic="chat" scenario="split" frame="01-proposal" side="panel" />
          </GuideStep>
          <GuideStep title={g('sTree')} text={g('sTreeText')}>
            <HelpShot topic="chat" scenario="split" frame="02-tree" side="panel" />
          </GuideStep>
          <GuideStep title={g('sHub')} text={g('sHubText')}>
            <HelpShot topic="chat" scenario="split" frame="03-hub" side="panel" />
          </GuideStep>
          <GuideStep title={g('sAsk')} text={g('sAskText')}>
            <HelpShot topic="chat" scenario="split" frame="04-child-ask" side="panel" />
          </GuideStep>
          <GuideStep title={g('sOverlap')} text={g('sOverlapText')}>
            <HelpShot topic="chat" scenario="split" frame="05-overlap" side="panel" />
          </GuideStep>
          <GuideStep title={g('sPause')} text={g('sPauseText')}>
            <HelpShot topic="chat" scenario="split" frame="06-paused" side="panel" />
          </GuideStep>
          <GuideStep title={g('sWorktrees')} text={g('sWorktreesText')}>
            <HelpShot topic="chat" scenario="split" frame="07-worktrees" side="panel" />
          </GuideStep>
        </GuideSteps>
      </HelpSection>

      <Callout tone="info" title={g('shotsTitle')}>
        {g('shotsText')}
      </Callout>
    </>
  );
}
