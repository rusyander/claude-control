import { HelpSection, Callout, GuideSteps, GuideStep, HelpShot, HelpDiagram } from '../ui';

interface SectionProps {
  /** Перевод ключа `help.topics.platform.<key>` — словарь у документа один. */
  tr: (key: string) => string;
}

/**
 * Продолжение пути в снимках: контур подключён — что дальше. Активный контур и
 * пробный запрос, какой моделью уйдёт прогон, что с запросом делают по дороге,
 * агент, правящий файлы, картинки — и в самом конце удаление.
 *
 * Два источника кадров, и оба названы в документе. Живой стенд платформы компании даёт
 * всё, что умеет сам; чего он не умеет (рисующей модели у ключа нет, модель
 * 0.5B не делает вызовов) — снято на сценарном контуре `tools/qa/stub-platform.mjs`,
 * который отвечает заранее записанными ходами. Кадр со сценарного контура
 * всегда подписан так, что это видно: выдать его за живую модель значило бы
 * пообещать поведение, которого человек у себя не увидит.
 */
export function PlatformUseSections({ tr }: SectionProps) {
  const g = (key: string): string => tr(`guide.${key}`);

  return (
    <>
      <HelpSection title={g('useActiveTitle')} caption={g('useActiveCaption')}>
        <GuideSteps>
          <GuideStep title={g('aSmoke')} text={g('aSmokeText')}>
            <HelpShot topic="platform" scenario="activate" frame="01-smoke-ok" side="panel" />
          </GuideStep>
          <GuideStep title={g('aSmokeRed')} text={g('aSmokeRedText')}>
            <HelpShot topic="platform" scenario="scripted" frame="07-smoke-red" side="panel" />
          </GuideStep>
          <GuideStep title={g('aSwitch')} text={g('aSwitchText')}>
            <HelpShot topic="platform" scenario="scripted" frame="06-switch-button" side="panel" />
          </GuideStep>
          <GuideStep title={g('aReturn')} text={g('aReturnText')}>
            <HelpShot
              topic="platform"
              scenario="activate"
              frame="02-return-settings"
              side="panel"
            />
          </GuideStep>
        </GuideSteps>
      </HelpSection>

      <HelpSection title={g('useRouteTitle')} caption={g('useRouteCaption')}>
        <GuideSteps>
          <GuideStep title={g('rModel')} text={g('rModelText')}>
            <HelpShot topic="platform" scenario="route" frame="01-model-card" side="panel" />
          </GuideStep>
          <GuideStep title={g('rHeader')} text={g('rHeaderText')}>
            <HelpShot topic="platform" scenario="route" frame="02-chat-header" side="panel" />
          </GuideStep>
        </GuideSteps>
      </HelpSection>

      <HelpSection title={g('useRulesTitle')} caption={g('useRulesCaption')}>
        <GuideSteps>
          <GuideStep title={g('ruPanel')} text={g('ruPanelText')}>
            <HelpShot topic="platform" scenario="rules" frame="01-rules-panel" side="panel" />
          </GuideStep>
          <GuideStep title={g('ruOurs')} text={g('ruOursText')}>
            <HelpShot topic="platform" scenario="rules" frame="02-rules-ours" side="panel" />
          </GuideStep>
          <GuideStep title={g('ruConflicts')} text={g('ruConflictsText')}>
            <HelpShot topic="platform" scenario="rules" frame="03-rules-conflicts" side="panel" />
          </GuideStep>
        </GuideSteps>
      </HelpSection>

      {/* Схема прослойки стоит перед кадрами: пять снимков показывают, ЧТО
          вышло, а вопрос «кто здесь решает, выполнять ли» возникает первым.
          Удачный ход снят на сценарном контуре, неудачный — на живом стенде:
          честная пара, а не два удачных кадра. */}
      <HelpSection title={g('useAgentTitle')} caption={g('useAgentCaption')}>
        <HelpDiagram topic="platform" name="tool-shim" />
        <GuideSteps>
          <GuideStep title={g('agCall')} text={g('agCallText')}>
            <HelpShot topic="platform" scenario="scripted" frame="01-shim-call" side="panel" />
          </GuideStep>
          <GuideStep title={g('agQuote')} text={g('agQuoteText')}>
            <HelpShot topic="platform" scenario="scripted" frame="02-shim-quote" side="panel" />
          </GuideStep>
          <GuideStep title={g('agCard')} text={g('agCardText')}>
            <HelpShot topic="platform" scenario="scripted" frame="03-shim-card" side="panel" />
          </GuideStep>
          <GuideStep title={g('agLive')} text={g('agLiveText')}>
            <HelpShot topic="platform" scenario="agent" frame="01-chat-run" side="panel" />
          </GuideStep>
          <GuideStep title={g('agLiveCard')} text={g('agLiveCardText')}>
            <HelpShot topic="platform" scenario="agent" frame="02-shim-card" side="panel" />
          </GuideStep>
        </GuideSteps>
        <Callout tone="warning" title={g('agPriceTitle')}>
          {g('agPriceText')}
        </Callout>
      </HelpSection>

      <HelpSection title={g('useMediaTitle')} caption={g('useMediaCaption')}>
        <GuideSteps>
          <GuideStep title={g('mRow')} text={g('mRowText')}>
            <HelpShot topic="platform" scenario="media" frame="01-capability-row" side="panel" />
          </GuideStep>
          <GuideStep title={g('mMenu')} text={g('mMenuText')}>
            <HelpShot topic="platform" scenario="media" frame="02-mode-menu" side="panel" />
          </GuideStep>
          <GuideStep title={g('mStubMenu')} text={g('mStubMenuText')}>
            <HelpShot topic="platform" scenario="scripted" frame="04-image-menu" side="panel" />
          </GuideStep>
          <GuideStep title={g('mCard')} text={g('mCardText')}>
            <HelpShot topic="platform" scenario="scripted" frame="05-image-card" side="panel" />
          </GuideStep>
        </GuideSteps>
        {/* Кадра у презентации нет намеренно: колода — это обычный ответ чата
            плюс файлы, собранные у вас на машине, и от контура в ней зависит
            только то, что уже показано кадрами картинки. */}
        <Callout tone="info" title={g('mDecksTitle')}>
          {g('mDecksText')}
        </Callout>
      </HelpSection>

      <HelpSection title={g('useEndTitle')} caption={g('useEndCaption')}>
        <GuideSteps>
          <GuideStep title={g('pDelete')} text={g('pDeleteText')}>
            <HelpShot topic="platform" scenario="connect" frame="18-panel-delete" side="panel" />
          </GuideStep>
        </GuideSteps>
      </HelpSection>
    </>
  );
}
