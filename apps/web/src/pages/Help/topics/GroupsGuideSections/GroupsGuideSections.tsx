import { HelpSection, GuideSteps, GuideStep, HelpShot, HelpDiagram } from '../../ui';
import type { SectionProps } from './GroupsGuideSections.types';

/**
 * Группы на доске в кадрах (`groups/lanes`, этап 12): полосы «По группам», «Закрытые» с прежними
 * запусками и «Импорт пунктов» в два окна. Кадры снимает `tools/help-shots/core-board.mjs` на
 * заглушках. Схема полос лежит в наборе «Ядро» — доска одна на оба документа.
 */
export function GroupsGuideSections({ tr }: SectionProps) {
  return (
    <HelpSection title={tr('lanesTitle')} caption={tr('lanesCaption')}>
      <HelpDiagram topic="core" name="group-lanes" />
      <GuideSteps>
        <GuideStep title={tr('lanesBoard')} text={tr('lanesBoardText')}>
          <HelpShot topic="groups" scenario="lanes" frame="01-lanes" side="panel" />
        </GuideStep>
        <GuideStep title={tr('lanesClosed')} text={tr('lanesClosedText')}>
          <HelpShot topic="groups" scenario="lanes" frame="02-closed" side="panel" />
        </GuideStep>
        <GuideStep title={tr('lanesPick')} text={tr('lanesPickText')}>
          <HelpShot topic="groups" scenario="lanes" frame="03-import-pick" side="panel" />
        </GuideStep>
        <GuideStep title={tr('lanesSteps')} text={tr('lanesStepsText')}>
          <HelpShot topic="groups" scenario="lanes" frame="04-import-steps" side="panel" />
        </GuideStep>
      </GuideSteps>
    </HelpSection>
  );
}
