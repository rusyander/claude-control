import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { HelpSection, Callout, GuideSteps, GuideStep, HelpShot } from '../../ui';

/**
 * Папка автотестов (e2e) в документе «Тесты»: где лежит код тестов, как он
 * становится кейсами и кто его пишет — генерация раздела и агент обычного чата.
 *
 * Отдельным файлом по той же причине, что `TestsNotesSection`: документ
 * упирается в предел длины файла. Кадры — настоящая съёмка
 * `tools/help-shots/tests-panel.mjs` (сценарий `e2e`); за поведением следит
 * `apps/web/public/help/sources.json` (раздел `tests`).
 */
export function TestsE2eSection() {
  const { t } = useTranslation();
  const e = (key: string): string => t(`help.topics.tests.e2e.${key}`);

  return (
    <>
      <HelpSection title={e('title')} caption={e('caption')}>
        <GuideSteps>
          <GuideStep title={e('missing')} text={e('missingText')}>
            <HelpShot topic="tests" scenario="e2e" frame="01-missing" side="panel" />
          </GuideStep>
          <GuideStep title={e('created')} text={e('createdText')}>
            <HelpShot topic="tests" scenario="e2e" frame="02-created" side="panel" />
          </GuideStep>
          <GuideStep title={e('synced')} text={e('syncedText')}>
            <HelpShot topic="tests" scenario="e2e" frame="03-synced" side="panel" />
          </GuideStep>
          <GuideStep title={e('remove')} text={e('removeText')}>
            <HelpShot topic="tests" scenario="e2e" frame="04-remove-confirm" side="panel" />
          </GuideStep>
          <GuideStep title={e('run')} text={e('runText')}>
            <HelpShot topic="tests" scenario="e2e" frame="05-run-done" side="panel" />
          </GuideStep>
          <GuideStep title={e('history')} text={e('historyText')}>
            <HelpShot topic="tests" scenario="e2e" frame="06-run-history" side="panel" />
          </GuideStep>
          <GuideStep title={e('retry')} text={e('retryText')}>
            <HelpShot topic="tests" scenario="e2e" frame="09-retry-quarantine" side="panel" />
          </GuideStep>
          <GuideStep title={e('pyramid')} text={e('pyramidText')}>
            <HelpShot topic="tests" scenario="e2e" frame="10-pyramid" side="panel" />
          </GuideStep>
          <GuideStep title={e('mutation')} text={e('mutationText')}>
            <HelpShot topic="tests" scenario="e2e" frame="11-mutation-result" side="panel" />
          </GuideStep>
          <GuideStep title={e('chatTest')} text={e('chatTestText')}>
            <HelpShot topic="tests" scenario="e2e" frame="07-chat-test" side="panel" />
          </GuideStep>
          <GuideStep title={e('chatCase')} text={e('chatCaseText')}>
            <HelpShot topic="tests" scenario="e2e" frame="08-chat-case" side="panel" />
          </GuideStep>
        </GuideSteps>
      </HelpSection>

      <HelpSection title={e('flowTitle')}>
        <Stack gap="var(--spacing-xs)">
          <Callout tone="info" title={e('generateTitle')}>
            {e('generateText')}
          </Callout>
          <Callout tone="info" title={e('chatTitle')}>
            {e('chatText')}
          </Callout>
          <Callout tone="info" title={e('addTitle')}>
            {e('addText')}
          </Callout>
          <Callout tone="info" title={e('cliTitle')}>
            {e('cliText')}
          </Callout>
          <Callout tone="warning" title={e('limitsTitle')}>
            {e('limitsText')}
          </Callout>
        </Stack>
      </HelpSection>
    </>
  );
}
