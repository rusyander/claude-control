import { PriorityLadder } from '@shared/ui/diagram';
import { HelpSection, Callout, GuideSteps, GuideStep, HelpShot, HelpDiagram } from '../ui';

interface SectionProps {
  /** Перевод ключа `help.topics.overview.<key>` — словарь у документа один. */
  tr: (key: string) => string;
}

/**
 * Середина документа «Обзор»: как получается число и два пути в снимках.
 *
 * Сценариев два, и делятся они ПО ВХОДУ, а не по объёму. «Первый вход» проходят
 * один раз, сразу после установки: вопрос — что панель вообще видит. «Числа не
 * те» открывают в другой день и по другому поводу: вопрос уже не «что здесь
 * есть», а «туда ли панель смотрит», и отвечает на него не плитка, а карточка
 * каталога над ней.
 */
export function OverviewGuideSections({ tr }: SectionProps) {
  const g = (key: string): string => tr(`guide.${key}`);

  return (
    <>
      <HelpSection title={tr('mapTitle')} caption={tr('mapCaption')}>
        <HelpDiagram topic="overview" name="where-numbers-come-from" />
        {/* Тот же путь словами: справку читают и без картинок. */}
        <Callout tone="info" title={tr('pathTextTitle')}>
          {tr('pathTextText')}
        </Callout>
      </HelpSection>

      <HelpSection title={tr('sourceTitle')} caption={tr('sourceCaption')}>
        <PriorityLadder
          ariaLabel={tr('sourceTitle')}
          topLabel={tr('sourceTop')}
          steps={[
            { id: 'manual', label: 'manual', caption: tr('sourceManual'), tone: 'accent' },
            { id: 'env', label: 'env', caption: tr('sourceEnv'), tone: 'info' },
            { id: 'home', label: 'home', caption: tr('sourceHome') },
          ]}
        />
        <Callout tone="info" title={tr('sourceNote')} />
      </HelpSection>

      <HelpSection title={g('tourTitle')} caption={g('tourCaption')}>
        <GuideSteps>
          <GuideStep title={g('tourTiles')} text={g('tourTilesText')}>
            <HelpShot topic="overview" scenario="tour" frame="01-tiles" side="panel" />
          </GuideStep>
          <GuideStep title={g('tourSection')} text={g('tourSectionText')}>
            <HelpShot topic="overview" scenario="tour" frame="02-section" side="panel" />
          </GuideStep>
          <GuideStep title={g('tourQuick')} text={g('tourQuickText')}>
            <HelpShot topic="overview" scenario="tour" frame="03-quick-add" side="panel" />
          </GuideStep>
          <GuideStep title={g('tourChanges')} text={g('tourChangesText')}>
            <HelpShot topic="overview" scenario="tour" frame="04-changes" side="panel" />
          </GuideStep>
        </GuideSteps>
      </HelpSection>

      <HelpSection title={g('troubleTitle')} caption={g('troubleCaption')}>
        <GuideSteps>
          <GuideStep title={g('troubleDir')} text={g('troubleDirText')}>
            <HelpShot topic="overview" scenario="trouble" frame="01-wrong-dir" side="panel" />
          </GuideStep>
          <GuideStep title={g('troubleHook')} text={g('troubleHookText')}>
            <HelpShot topic="overview" scenario="trouble" frame="02-broken-hook" side="panel" />
          </GuideStep>
          <GuideStep title={g('troubleHooks')} text={g('troubleHooksText')}>
            <HelpShot topic="overview" scenario="trouble" frame="03-hooks" side="panel" />
          </GuideStep>
        </GuideSteps>
      </HelpSection>
    </>
  );
}
