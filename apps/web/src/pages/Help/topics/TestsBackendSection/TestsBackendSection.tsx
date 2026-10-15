import { useTranslation } from 'react-i18next';
import { HelpSection, Callout, GuideSteps, GuideStep, HelpShot } from '../../ui';

/**
 * Тесты бэкенда в документе «Тесты»: рецепт команды по файлам проекта, запись,
 * прогон, «Завести кейсы» и кейсы-наборы каталогов. Отдельным файлом — документ
 * упирается в предел длины. Кадры — настоящая съёмка `tools/help-shots/tests-panel.mjs`
 * (сценарий `backend`); за поведением следит `apps/web/public/help/sources.json`
 * (раздел `tests`).
 */
export function TestsBackendSection() {
  const { t } = useTranslation();
  const b = (key: string): string => t(`help.topics.tests.backend.${key}`);

  return (
    <HelpSection title={b('title')} caption={b('caption')}>
      <GuideSteps>
        <GuideStep title={b('recipes')} text={b('recipesText')}>
          <HelpShot topic="tests" scenario="backend" frame="01-recipes" side="panel" />
        </GuideStep>
        <GuideStep title={b('run')} text={b('runText')}>
          <HelpShot topic="tests" scenario="backend" frame="02-run-adopt" side="panel" />
        </GuideStep>
        <GuideStep title={b('adopt')} text={b('adoptText')}>
          <HelpShot topic="tests" scenario="backend" frame="03-adopted" side="panel" />
        </GuideStep>
        <GuideStep title={b('library')} text={b('libraryText')}>
          <HelpShot topic="tests" scenario="backend" frame="04-library" side="panel" />
        </GuideStep>
      </GuideSteps>
      <Callout tone="info" title={b('suitesTitle')}>
        {b('suitesText')}
      </Callout>
      <Callout tone="warning" title={b('limitsTitle')}>
        {b('limitsText')}
      </Callout>
    </HelpSection>
  );
}
