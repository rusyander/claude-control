import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { HelpSection, Callout } from '../ui';

/**
 * Хвост документа «Тесты»: то, что человек узнаёт не из описания кнопок, а
 * когда что-то пошло не так — битый файл, статусы, чем прогон человека
 * отличается от агентского, и почему всё это лежит в git.
 *
 * Отдельным файлом по той же причине, что `TestsManualSections` и
 * `TestsSetupSection`: документ упирается в предел длины файла.
 */
export function TestsNotesSection() {
  const { t } = useTranslation();
  const tr = (key: string): string => t(`help.topics.tests.${key}`);

  return (
    <HelpSection title={tr('notesTitle')}>
      <Stack gap="var(--spacing-xs)">
        <Callout tone="warning" title={tr('noteBrokenTitle')}>
          {tr('noteBrokenText')}
        </Callout>
        <Callout tone="info" title={tr('noteStatusTitle')}>
          {tr('noteStatusText')}
        </Callout>
        <Callout tone="info" title={tr('noteHumanTitle')}>
          {tr('noteHumanText')}
        </Callout>
        <Callout tone="info" title={tr('noteGitTitle')}>
          {tr('noteGitText')}
        </Callout>
      </Stack>
    </HelpSection>
  );
}
