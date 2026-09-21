import type { InstructionsFileInfo } from '@agentdeck/contracts';

/**
 * Тексты раздела «Глобальные инструкции», адаптированные под активного провайдера.
 *
 * Раздел универсален: у Claude это `CLAUDE.md` или `AGENTS.md` (имя решает CLI,
 * П2.7), у Codex — AGENTS.md, у Gemini — GEMINI.md. Заголовок/подпись/пояснение
 * подстраиваются под файл и провайдера.
 *
 * Для Claude — те же ключи i18n, что и раньше (`claudeMd.subtitle/explain`), без
 * подсказки о CLI: вид и тексты остаются как есть. Исключение — ИМЯ файла: дом на
 * одном `AGENTS.md` не должен читаться под заголовком «CLAUDE.md», поэтому и
 * заголовок, и пояснение получают РАЗРЕШЁННОЕ имя параметром.
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
  /** Подпись под редактором: чей перезапуск нужен — Claude Code или чужого CLI. */
  restartHint: TextKey;
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
      title: { key: 'claudeMd.titleName', params: { file: info.fileName } },
      subtitle: { key: 'claudeMd.subtitle' },
      explain: { key: 'claudeMd.explain', params: { file: info.fileName } },
      restartHint: { key: 'common.needsRestart' },
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
    restartHint: { key: 'providers.needsRestartFor', params: { provider: info.providerName } },
    cliHint: info.cliDetected
      ? undefined
      : {
          key: 'claudeMd.cliMissing',
          params: { provider: info.providerName, path: info.filePath },
        },
  };
}
