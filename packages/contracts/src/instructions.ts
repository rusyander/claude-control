/**
 * Раздел «Глобальные инструкции» — универсальный по активному провайдеру.
 *
 * Первый кросс-провайдерный раздел панели: у Claude это `~/.claude/CLAUDE.md`,
 * у Codex — `~/.codex/AGENTS.md`, у Gemini — `~/.gemini/GEMINI.md`. Провайдер
 * без задокументированного файла инструкций раздел не поддерживает (сервер
 * отвечает 4xx, путь панель НЕ угадывает — fail-closed).
 *
 * Ответ несёт не только содержимое, но и метаданные для адаптации интерфейса:
 * имя файла (CLAUDE.md/AGENTS.md/GEMINI.md), его абсолютный путь, обнаружен ли
 * соответствующий CLI (для неалармирующей подсказки) и данные активного
 * провайдера (id/имя — заголовок раздела подстраивается под них).
 */
export interface InstructionsFileInfo {
  /** Содержимое файла (пустая строка, если файла ещё нет). */
  content: string;
  /** Существует ли файл на диске. `false` — раздел показывается пустым, не ошибка. */
  exists: boolean;
  /** Имя файла инструкций: `CLAUDE.md` / `AGENTS.md` / `GEMINI.md`. */
  fileName: string;
  /** Абсолютный путь к файлу инструкций активного провайдера. */
  filePath: string;
  /**
   * Обнаружен ли CLI провайдера в системе (по наличию его каталога конфигурации).
   * `false` → интерфейс покажет подсказку «CLI не найден, файл будет создан по
   * пути …»; сохранение всё равно доступно (намерение пользователя явное).
   */
  cliDetected: boolean;
  /** Id активного провайдера (`claude` / `codex` / `gemini`). */
  providerId: string;
  /** Человекочитаемое имя активного провайдера — для заголовка раздела. */
  providerName: string;
  /**
   * Только у Claude: имя файла инструкций перестало быть константой (2.1.277).
   * У прочих провайдеров поля нет — их файл действительно один.
   */
  instructionFiles?: InstructionFilesView;
}

/**
 * Ответ `GET /api/projects/:id/rules` — файл правил проекта целиком.
 *
 * Имя несёт не декорация: проект без своего `CLAUDE.md` живёт на `AGENTS.md`, и
 * человеку нужно видеть, какой файл он правит и какой при этом читает CLI.
 */
export interface ProjectRulesAnswer {
  content: string;
  fileName: string;
  filePath: string;
  instructionFiles: InstructionFilesView;
}

/**
 * Режимы ключа `instructionFiles` в настройках Claude Code (2.1.277+).
 *
 * `claude-md` — только `CLAUDE.md`; `claude-md-or-agents-md` (умолчание) — там,
 * где своего `CLAUDE.md` нет, читается `AGENTS.md`; `claude-md-and-agents-md` —
 * оба рядом; `managed-only` — собственные файлы инструкций CLI не читает вовсе.
 */
export const instructionFilesModes = [
  'claude-md',
  'claude-md-or-agents-md',
  'claude-md-and-agents-md',
  'managed-only',
] as const;

export type InstructionFilesMode = (typeof instructionFilesModes)[number];

/** Откуда взят режим: новый ключ, устаревший или умолчание самого CLI. */
export type InstructionFilesSource = 'instructionFiles' | 'projectInstructions' | 'default';

/** Один файл инструкций в корне: имя ОТ КОРНЯ (`.claude/AGENTS.md`) и полный путь. */
export interface InstructionFileEntry {
  fileName: string;
  filePath: string;
}

/**
 * Почему панель показывает именно это. Коды, а не готовый текст: у экрана две
 * локали, и формулировка принадлежит клиенту, а не серверу.
 */
export type InstructionFilesNote =
  | { code: 'managed-only' }
  | { code: 'legacy-key' }
  | { code: 'unrecognized'; value: string }
  | { code: 'unreadable-settings' }
  | { code: 'ignored-nearby'; files: string[] };

/**
 * Что происходит с именем файла инструкций в этом корне — для экрана.
 *
 * Панель НИКОГДА не переименовывает файл и не заводит второй: при двух файлах
 * показываются оба, и названо, какой из них читает CLI по текущему режиму.
 */
export interface InstructionFilesView {
  mode: InstructionFilesMode;
  source: InstructionFilesSource;
  /** Файлы, которые CLI действительно читает в этом корне, в порядке чтения. */
  read: InstructionFileEntry[];
  /** Файлы, лежащие рядом, которые CLI при этом режиме НЕ читает. */
  ignored: InstructionFileEntry[];
  /** Имена на выбор, когда файла ещё нет; пусто — выбора нет. */
  choices: string[];
  /** Файла на диске нет: `fileName` — предложение панели, а не находка. */
  proposed: boolean;
  notes: InstructionFilesNote[];
}
