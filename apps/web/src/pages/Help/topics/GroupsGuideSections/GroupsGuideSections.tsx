import { HelpSection, GuideSteps, GuideStep, HelpShot } from '../../ui';
import type { SectionProps } from './GroupsGuideSections.types';

/**
 * Страница групп в кадрах (`groups/page`): задачи ядра с прежними запусками, сетка прежних групп и
 * окно «В ядро». Кадры сняты на одноразовом стенде с настоящим ядром — шаги в окне перевода
 * пришли из его `fromPath`, а не нарисованы.
 */
export function GroupsGuideSections({ tr }: SectionProps) {
  return (
    <HelpSection title={tr('pageTitle')} caption={tr('pageCaption')}>
      <GuideSteps>
        <GuideStep title={tr('pageTasks')} text={tr('pageTasksText')}>
          <HelpShot topic="groups" scenario="page" frame="01-core-tasks" side="panel" />
        </GuideStep>
        <GuideStep title={tr('pageGrid')} text={tr('pageGridText')}>
          <HelpShot topic="groups" scenario="page" frame="02-legacy-grid" side="panel" />
        </GuideStep>
        <GuideStep title={tr('pageImport')} text={tr('pageImportText')}>
          <HelpShot topic="groups" scenario="page" frame="03-core-import" side="panel" />
        </GuideStep>
      </GuideSteps>
    </HelpSection>
  );
}
