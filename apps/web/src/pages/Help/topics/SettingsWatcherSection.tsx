import { Stack } from '@shared/ui/stack';
import { HelpSection, Callout, GuideSteps, GuideStep, HelpShot, HelpDiagram } from '../ui';

interface SectionProps {
  /** Перевод ключа `help.topics.settings.<key>` — словарь у документа один. */
  tr: (key: string) => string;
}

/**
 * Фоновый наблюдатель в документе «Настройки»: включить, увидеть индикатор,
 * прочитать отчёт — кадрами настоящей панели, затем пределы словами.
 *
 * Пределы стоят после шагов намеренно: «модель только читает» и «расход —
 * оценка» — ответы на вопрос, который появляется, когда индикатор уже
 * тикает, а не до включения.
 */
export function SettingsWatcherSection({ tr }: SectionProps) {
  const w = (key: string): string => tr(`watcher.${key}`);

  return (
    <HelpSection title={w('title')} caption={w('caption')}>
      <Stack gap="var(--spacing-md)">
        <HelpDiagram topic="settings" name="how-the-watcher-works" />
        <GuideSteps>
          <GuideStep title={w('on')} text={w('onText')}>
            <HelpShot topic="settings" scenario="watcher" frame="01-card-off" side="panel" />
          </GuideStep>
          <GuideStep title={w('indicator')} text={w('indicatorText')}>
            <HelpShot topic="settings" scenario="watcher" frame="03-indicator" side="panel" />
          </GuideStep>
          <GuideStep title={w('report')} text={w('reportText')} />
          <GuideStep title={w('read')} text={w('readText')}>
            <HelpShot topic="settings" scenario="watcher" frame="02-card-on" side="panel" />
          </GuideStep>
        </GuideSteps>

        <Callout tone="info" title={w('readOnly')}>
          {w('readOnlyText')}
        </Callout>
        <Callout tone="info" title={w('spend')}>
          {w('spendText')}
        </Callout>
        <Callout tone="warning" title={w('trouble')}>
          {w('troubleText')}
        </Callout>
      </Stack>
    </HelpSection>
  );
}
