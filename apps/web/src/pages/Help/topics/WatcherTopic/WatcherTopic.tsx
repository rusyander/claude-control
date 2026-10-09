import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { HelpSection, Callout, GuideSteps, GuideStep, HelpShot, HelpDiagram } from '../../ui';

/**
 * Документ «Наблюдатель» (владелец 09.10.2026: наблюдатель переехал из
 * настроек на свою страницу, и раздел настроек про него стал отдельным
 * документом): запуск, строка в боковой панели, баг словами, отчёт — кадрами
 * настоящей панели, затем пределы словами.
 *
 * Пределы стоят после шагов намеренно: «модель только читает» и «расход —
 * оценка» — ответы на вопрос, который появляется, когда строка уже тикает, а
 * не до запуска. Схема — из словаря настроек: её исходник лежит в общем
 * `settings-guide.drawio`, и переносить страницу схемы ради адреса незачем.
 */
export function WatcherTopic() {
  const { t } = useTranslation();
  const tr = (key: string): string => t(`help.topics.watcher.${key}`);

  return (
    <>
      <Callout tone="info" title={tr('guideTitle')}>
        {tr('guideText')}
      </Callout>

      <HelpSection title={tr('stepsTitle')} caption={tr('stepsCaption')}>
        <Stack gap="var(--spacing-md)">
          <HelpDiagram topic="settings" name="how-the-watcher-works" />
          <GuideSteps>
            <GuideStep title={tr('on')} text={tr('onText')}>
              <HelpShot topic="watcher" scenario="page" frame="01-page-off" side="panel" />
            </GuideStep>
            <GuideStep title={tr('control')} text={tr('controlText')}>
              <HelpShot topic="watcher" scenario="page" frame="02-control-on" side="panel" />
            </GuideStep>
            <GuideStep title={tr('indicator')} text={tr('indicatorText')}>
              <HelpShot topic="watcher" scenario="page" frame="03-indicator" side="panel" />
            </GuideStep>
            <GuideStep title={tr('bug')} text={tr('bugText')}>
              <HelpShot topic="watcher" scenario="page" frame="04-bug-check" side="panel" />
            </GuideStep>
            <GuideStep title={tr('page')} text={tr('pageText')}>
              <HelpShot topic="watcher" scenario="page" frame="05-report" side="panel" />
            </GuideStep>
          </GuideSteps>
        </Stack>
      </HelpSection>

      <HelpSection title={t('help.common.howTitle')}>
        <Stack gap="var(--spacing-xs)">
          <Callout tone="info" title={tr('report')}>
            {tr('reportText')}
          </Callout>
          <Callout tone="info" title={tr('read')}>
            {tr('readText')}
          </Callout>
        </Stack>
      </HelpSection>

      <HelpSection title={t('help.common.notesTitle')}>
        <Stack gap="var(--spacing-xs)">
          <Callout tone="info" title={tr('readOnly')}>
            {tr('readOnlyText')}
          </Callout>
          <Callout tone="info" title={tr('spend')}>
            {tr('spendText')}
          </Callout>
          <Callout tone="warning" title={tr('trouble')}>
            {tr('troubleText')}
          </Callout>
        </Stack>
      </HelpSection>
    </>
  );
}
