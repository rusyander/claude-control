import { HelpSection, Callout, GuideSteps, GuideStep, HelpShot, FieldTable } from '../../ui';
import type { SectionProps } from './HistoryChangelogSections.types';

/**
 * Вкладка «Что нового» документа «История изменений»: путь по ленте выпусков и
 * разбор записи. Остальной документ — про вкладку «Настройки».
 */
export function HistoryChangelogSections({ tr }: SectionProps) {
  const c = (key: string): string => tr(`changelog.${key}`);

  return (
    <>
      <HelpSection title={c('title')} caption={c('caption')}>
        <GuideSteps>
          <GuideStep title={c('feed')} text={c('feedText')}>
            <HelpShot topic="history" scenario="changelog" frame="01-feed" side="panel" />
          </GuideStep>
          <GuideStep title={c('entry')} text={c('entryText')}>
            <HelpShot topic="history" scenario="changelog" frame="02-entry" side="panel" />
          </GuideStep>
          <GuideStep title={c('filter')} text={c('filterText')}>
            <HelpShot topic="history" scenario="changelog" frame="03-filter" side="panel" />
          </GuideStep>
        </GuideSteps>
      </HelpSection>

      <HelpSection title={c('cardTitle')} caption={c('cardCaption')}>
        <FieldTable
          nameHeader={c('cardColumn')}
          descriptionHeader={c('cardMeaningColumn')}
          rows={[
            { name: c('cardDate'), description: c('cardDateText'), isMono: false },
            { name: c('cardPending'), description: c('cardPendingText'), isMono: false },
            { name: c('cardTree'), description: c('cardTreeText'), isMono: false },
            { name: c('cardGit'), description: c('cardGitText'), isMono: false },
            { name: c('cardKinds'), description: c('cardKindsText'), isMono: false },
            { name: c('cardTotals'), description: c('cardTotalsText'), isMono: false },
            { name: c('cardAreas'), description: c('cardAreasText'), isMono: false },
            { name: c('cardCommits'), description: c('cardCommitsText'), isMono: false },
          ]}
        />
        <Callout tone="info" title={c('writeTitle')}>
          {c('writeText')}
        </Callout>
        <Callout tone="warning" title={c('brokenTitle')}>
          {c('brokenText')}
        </Callout>
      </HelpSection>
    </>
  );
}
