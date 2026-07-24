import type { InstructionsFileInfo } from '@claude-control/contracts';

/**
 * Тексты раздела «Глобальные инструкции», адаптированные под активного провайдера.
 *
 * Раздел универсален: у Claude это CLAUDE.md, у Codex — AGENTS.md, у Gemini —
 * GEMINI.md. Заголовок/подпись/пояснение подстраиваются под файл и провайдера.
 *
 * Для Claude — РОВНО те же ключи i18n, что и раньше (`claudeMd.title/subtitle/
 * explain`), без подсказки о CLI: вид и тексты остаются как есть (регресс-ноль).
 * Для прочих провайдеров — ключи `*For` с параметрами (имя файла, провайдер,
 * путь). Если CLI не обнаружен — неалармирующая подсказка `cliMissing`; при этом
 * сохранение остаётся доступным (намерение пользователя явное).
 *
 * Возвращаются ключи i18n и параметры (без вызова перевода) — так вид легко
 * покрыть чистым тестом, не поднимая i18n/DOM.
 */
export interface TextKey {
  key: string;
  params?: Record<string, unknown>;
}

export interface InstructionsView {
  /** Активный провайдер — Claude (быстрый путь, тексты как раньше). */
  isClaude: boolean;
  title: TextKey;
  subtitle: TextKey;
  explain: TextKey;
  /** Подсказка «CLI не найден» — только для не-Claude провайдера без обнаруженного CLI. */
  cliHint?: TextKey;
}

export function instructionsView(info: InstructionsFileInfo): InstructionsView {
  if (info.providerId === 'claude') {
    return {
      isClaude: true,
      title: { key: 'claudeMd.title' },
      subtitle: { key: 'claudeMd.subtitle' },
      explain: { key: 'claudeMd.explain' },
    };
  }

  return {
    isClaude: false,
    title: {
      key: 'claudeMd.titleFor',
      params: { fileName: info.fileName, provider: info.providerName },
    },
    subtitle: { key: 'claudeMd.subtitleFor', params: { provider: info.providerName } },
    explain: { key: 'claudeMd.explainFor', params: { path: info.filePath } },
    cliHint: info.cliDetected
      ? undefined
      : {
          key: 'claudeMd.cliMissing',
          params: { provider: info.providerName, path: info.filePath },
        },
  };
}
