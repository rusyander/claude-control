import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stringify as stringifyToml } from 'smol-toml';
import { spliceCodexTableRegion, upsertCodexRootScalar } from '../../lib/codex-toml.ts';
import type { ProviderEndpointApiKind } from '../../providers/types/assistant.ts';

/**
 * РЕЦЕПТЫ ПРИЁМОЧНОЙ ПРОБЫ: как запустить каждый целевой CLI без диалога и
 * какими именами он зовёт свои инструменты.
 *
 * ЕДИНСТВЕННОЕ место домена, где имя конкретного CLI законно, и живёт оно
 * отдельным модулем именно поэтому: сторож одиннадцатого CLI
 * (`tools/qa/check-portability-eleventh.mjs`) сторожит остальной перенос от
 * такого знания, а здесь прощает — с точной причиной. Так `probe.ts` остаётся
 * под охраной, а расширяемость нарушается ровно в одной, названной точке.
 *
 * Это не «таблица провайдер → уровень», которую план запрещает (§5.4): уровень
 * по-прежнему считает матрица из каталога возможностей. Здесь лежит то, что из
 * каталога не выводится и выводиться не может, — argv неинтерактивного запуска и
 * СОБСТВЕННЫЕ имена инструментов CLI. Выдумать их нельзя: заглушка, позвавшая
 * несуществующий инструмент, покрасит пробу про себя, а не про перенос. Поэтому
 * цель без рецепта честно «не проверена», а список сокращается правкой кода.
 */
export interface ProbeRecipe {
  /** Диалект заглушки; он же ключ в `endpointConfig` каталога. */
  readonly apiKind: ProviderEndpointApiKind;
  /** Неинтерактивный запуск с готовым промптом. */
  args(prompt: string): readonly string[];
  /** Вызов оболочки: имя инструмента цели и ЕГО форма аргументов. */
  readonly shellTool: ProbeTool;
  /** Вызов чтения файла. У цели без своего инструмента чтения — та же оболочка. */
  readonly readTool: ProbeTool;
  /** Чем запрос вызывает пробную слэш-команду. */
  readonly commandPrompt: string;
  /** Подготовить временный дом до запуска: снять мастера первого запуска и т.п. */
  prepare?(home: string, workdir: string): void;
}

/**
 * Инструмент цели в сценарии заглушки: имя И СБОРКА аргументов.
 *
 * Пары «поле → значение» здесь не хватило, и это выяснила живая проба
 * 22.09.2026 на `codex-cli 0.155.1`: у него нет ни инструмента `shell`
 * (единственная оболочка зовётся `exec_command`), ни инструмента чтения вовсе —
 * файл читается той же оболочкой. Значит из одного и того же «прочитай вот
 * этот путь» разные CLI собирают РАЗНЫЕ вызовы, и собрать их может только сам
 * рецепт.
 */
export interface ProbeTool {
  readonly name: string;
  call(argument: string): Record<string, unknown>;
}

export const PROBE_RECIPES: Readonly<Record<string, ProbeRecipe>> = {
  claude: {
    apiKind: 'anthropic',
    // `--allowedTools` разрешает ДВА инструмента, без которых проба слепа: без
    // них печатный режим откажет в вызове сам, и «хук заблокировал» стало бы
    // неотличимо от «до хука не дошло». Запрет пробного права при этом остаётся
    // в силе: правила `deny` у Claude Code сильнее любых разрешений.
    args: (prompt) => ['-p', prompt, '--output-format', 'json', '--allowedTools', 'Bash,Read'],
    shellTool: { name: 'Bash', call: (command) => ({ command }) },
    readTool: { name: 'Read', call: (path) => ({ file_path: path }) },
    commandPrompt: '/agentdeck-probe-command',
    prepare: (home) => {
      // Мастер первого запуска в пустом доме спросил бы про доверие к каталогу и
      // повис бы без ответа. Файл лежит РЯДОМ с домом, а не внутри него — так
      // его ищет сам CLI.
      //
      // ДОПИСЫВАЕМ, а не создаём заново: в этот же файл эмиттер только что
      // положил пробный MCP-сервер, и запись целиком стёрла бы его — проба
      // краснела бы на слое MCP от собственной подготовки.
      // Путь — по правилу самого CLI: при заданном `CLAUDE_CONFIG_DIR` файл
      // лежит ВНУТРИ каталога (`claude-paths.mcp-config.test.ts`), и проба
      // задаёт эту переменную. Сосед `~/.claude.json` здесь не читался бы вовсе,
      // а вместе с ним не читался бы и пробный MCP-сервер.
      const path = join(home, '.claude', '.claude.json');
      let current: Record<string, unknown> = {};
      try {
        const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
        if (parsed && typeof parsed === 'object') current = parsed as Record<string, unknown>;
      } catch {
        current = {};
      }
      writeFileSync(
        path,
        JSON.stringify({
          ...current,
          hasCompletedOnboarding: true,
          bypassPermissionsModeAccepted: true,
          projects: (current.projects as Record<string, unknown> | undefined) ?? {},
        }),
        'utf8',
      );
    },
  },
  codex: {
    apiKind: 'openai-compat',
    // `exec` — задокументированный неинтерактивный запуск. `--skip-git-repo-check`
    // обязателен: временный дом пробы репозиторием не является, а без флага этот
    // CLI вне git отказывается работать вовсе.
    args: (prompt) => ['exec', '--skip-git-repo-check', prompt],
    // Имена сняты ЖИВЫМ прогоном 22.09.2026 (`codex-cli 0.155.1`), а не взяты из
    // чужой документации: оболочка у него зовётся `exec_command` и ждёт команду
    // СТРОКОЙ в поле `cmd`. Вызов `shell` он отвергает — `unsupported call: shell`.
    shellTool: { name: 'exec_command', call: (cmd) => ({ cmd }) },
    // Инструмента чтения у codex НЕТ ВОВСЕ — файл читается той же оболочкой.
    readTool: { name: 'exec_command', call: (path) => ({ cmd: readFileCommand(path) }) },
    commandPrompt: '/agentdeck-probe-command',
    prepare: prepareCodexHome,
  },
};

/**
 * Прочитать файл ОБОЛОЧКОЙ — для цели, у которой своего инструмента чтения нет.
 *
 * Через node, а не `cat`/`type`: оболочка у каждого CLI своя (у codex на Windows
 * это может быть и `cmd.exe`, и PowerShell), а node один и тот же везде — ровно
 * то же решение, по которому пробная переменная печатается скриптом, а не `echo`.
 */
function readFileCommand(path: string): string {
  return `node -e "process.stdout.write(require('fs').readFileSync('${path}','utf8'))"`;
}

/**
 * Снять у codex всё, что спросило бы человека, — его «мастер первого запуска».
 *
 * Без `approval_policy`/`sandbox_mode` он спрашивает разрешение на каждый вызов
 * и виснет без ответа, а без доверия рабочему каталогу — спрашивает и о нём.
 *
 * ЧТО ЭТО СТОИТ, и умолчать нельзя: `danger-full-access` снимает и принуждение
 * прав тоже. Строка «право» у этой цели от того не слепнет — панель обещает ей
 * уровень «текстом», и проба меряет его присутствием запрета в запросе, а не
 * отказом. Появится у codex настоящее принуждение прав — эта подготовка станет
 * подлогом, и снимать её придётся вместе с переходом строки на `enforced`.
 */
function prepareCodexHome(home: string, workdir: string): void {
  const path = join(home, '.codex', 'config.toml');
  let text = existsSync(path) ? readFileSync(path, 'utf8') : '';
  // Регионом, а не перезаписью: в этом же файле эмиттер уже разложил пробный
  // MCP-сервер и пробную переменную окружения, и целая запись стёрла бы их —
  // проба краснела бы на двух слоях от собственной подготовки.
  text = spliceCodexTableRegion(
    text,
    stringifyToml({ projects: { [workdir]: { trust_level: 'trusted' } } }),
    'projects',
  );
  text = upsertCodexRootScalar(text, 'approval_policy', 'never');
  text = upsertCodexRootScalar(text, 'sandbox_mode', 'danger-full-access');
  writeFileSync(path, text, 'utf8');
}
