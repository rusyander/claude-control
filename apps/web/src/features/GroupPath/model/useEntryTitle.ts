import { useTranslation } from 'react-i18next';
import type { LocalizedText, PathEntry } from '@agentdeck/contracts';

/** Сторона текста на языке интерфейса; пустая — вторая, чтобы строка не была безымянной. */
export function pickLang(text: LocalizedText, language: string): string {
  const own = language.startsWith('en') ? text.en : text.ru;
  const other = language.startsWith('en') ? text.ru : text.en;
  return own.trim() || other.trim();
}

/** Подпись строки пути на языке интерфейса — и для списка, и для доступных имён кнопок. */
export function useEntryTitle(): (entry: PathEntry) => string {
  const { t, i18n } = useTranslation();
  return (entry) => {
    if (entry.kind === 'builtin') return t(`groupPath.stage.${entry.stage}`);
    if (entry.kind === 'skill-step') return entry.title;
    return pickLang(entry.step.title, i18n.language) || pickLang(entry.step.prompt, i18n.language);
  };
}
