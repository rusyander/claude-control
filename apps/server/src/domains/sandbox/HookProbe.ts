import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

/**
 * Прямой прогон хука или скрипта на заготовленном событии.
 *
 * Хук — обычная программа: получает событие JSON на вход, пишет ответ в вывод,
 * а кодом 2 останавливает действие. Значит его можно проверить без модели —
 * мгновенно и бесплатно, подсунув событие руками. Это единственный вид
 * проверки в песочнице, который ничего не стоит и не расходует лимит.
 */

const isWindows = process.platform === 'win32';

/**
 * Путь в примере события — в стиле той системы, где панель запущена.
 *
 * Раньше во всех заготовках стоял `C:/work/...`: на Linux и macOS такой путь
 * выглядит чужеродно, а хук-страж, который смотрит на пути, может на него и
 * не сработать — тогда прогон покажет не то, что покажет в бою.
 */
function demoPath(name: string): string {
  return isWindows ? `C:/work/demo/${name}` : `/home/user/demo/${name}`;
}

/**
 * Приманка для стража секретов, собранная из кусков.
 *
 * Записанная целиком, она валидна с виду и поднимает тревогу у secret scanning
 * на GitHub. Токен выдуман и никуда не ведёт, но объясняться с каждой такой
 * тревогой — лишняя работа.
 */
const FAKE_TOKEN = ['glpat', 'x7Kd93mQpL2vRnT4wZbA'].join('-');

/** Готовые события: по одному на каждый распространённый случай. */
export interface EventFixture {
  id: string;
  event: string;
  title: string;
  description: string;
  /** Ожидание автора заготовки: должен ли хук остановить действие. */
  expectsBlock: boolean;
  payload: Record<string, unknown>;
}

export const EVENT_FIXTURES: EventFixture[] = [
  {
    id: 'bash-safe',
    event: 'PreToolUse',
    title: 'Безобидная команда',
    description: 'Обычный вызов Bash — страж не должен вмешиваться.',
    expectsBlock: false,
    payload: {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'git status', description: 'Показать статус' },
    },
  },
  {
    id: 'bash-destructive',
    event: 'PreToolUse',
    title: 'Рекурсивное удаление',
    description: 'Опасная команда — страж разрушительных операций должен остановить.',
    expectsBlock: true,
    payload: {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'rm -rf /c/work/project', description: 'Удалить папку' },
    },
  },
  {
    id: 'bash-git-push',
    event: 'PreToolUse',
    title: 'Мутирующая операция git',
    description: 'Пуш в удалённый репозиторий — по правилам агент этого делать не должен.',
    expectsBlock: true,
    payload: {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'git push origin main', description: 'Отправить изменения' },
    },
  },
  {
    id: 'write-secret',
    event: 'PreToolUse',
    title: 'Запись секрета в файл',
    description: 'В содержимом похожий на токен ключ — страж секретов должен вмешаться.',
    expectsBlock: true,
    payload: {
      hook_event_name: 'PreToolUse',
      tool_name: 'Write',
      tool_input: {
        // Строка намеренно не содержит слов вроде «example» и «test»: стражи
        // секретов считают их заготовками и пропускают — а нам нужно, чтобы
        // проверка выглядела как настоящий ключ.
        //
        // И ровно поэтому она собирается из кусков: целиком записанный
        // `glpat-…` — валидная с виду приманка, на которую реагирует secret
        // scanning на GitHub. Утечки здесь нет (токен выдуман), но разбираться
        // с ложной тревогой в каждом форке никому не нужно.
        file_path: demoPath('config.ts'),
        content: `export const gitlabToken = "${FAKE_TOKEN}";`,
      },
    },
  },
  {
    id: 'write-placeholder',
    event: 'PreToolUse',
    title: 'Ключ-заготовка в примере',
    description: 'Значение-плейсхолдер в .env.example — страж не должен мешать.',
    expectsBlock: false,
    payload: {
      hook_event_name: 'PreToolUse',
      tool_name: 'Write',
      tool_input: {
        file_path: demoPath('.env.example'),
        content: 'GITLAB_TOKEN=your-token-here',
      },
    },
  },
  {
    id: 'write-plain',
    event: 'PostToolUse',
    title: 'Обычная правка файла',
    description: 'Правка исходника — сюда обычно вешают автоформатирование.',
    expectsBlock: false,
    payload: {
      hook_event_name: 'PostToolUse',
      tool_name: 'Edit',
      tool_input: { file_path: demoPath('index.ts') },
      tool_response: { success: true },
    },
  },
  {
    id: 'prompt-figma',
    event: 'UserPromptSubmit',
    title: 'Запрос со ссылкой на Figma',
    description: 'Подсказки на ввод пользователя срабатывают здесь.',
    expectsBlock: false,
    payload: {
      hook_event_name: 'UserPromptSubmit',
      prompt: 'Свёрстай по макету https://www.figma.com/design/abc/Example',
    },
  },
  {
    id: 'session-start',
    event: 'SessionStart',
    title: 'Начало сессии',
    description: 'Брифинги и напоминания при старте.',
    expectsBlock: false,
    payload: { hook_event_name: 'SessionStart', source: 'startup' },
  },
  {
    id: 'stop',
    event: 'Stop',
    title: 'Конец ответа',
    description: 'Проверки, которые запускаются после ответа модели.',
    expectsBlock: false,
    payload: { hook_event_name: 'Stop', stop_hook_active: false },
  },
];

/**
 * Как хук отнёсся к событию.
 *
 * Способов сообщить решение два, и оба в ходу: старый — выйти с кодом 2,
 * новый — вернуть JSON с полем permissionDecision. Стенд обязан понимать оба,
 * иначе хук, который честно требует подтверждения, выглядел бы бездействующим.
 */
export type HookDecision = 'block' | 'ask' | 'pass';

export interface ProbeResult {
  fixtureId: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  decision: HookDecision;
  /** Пояснение хука: почему он вмешался. */
  reason?: string;
  /** Текст, который хук добавляет в контекст (подсказки и брифинги). */
  addedContext?: string;
  /** Вмешался ли хук так, как задумано заготовкой. */
  matchesExpectation: boolean;
  durationMs: number;
  parsed?: unknown;
  timedOut: boolean;
}

/** Дольше этого хук не ждём: в реальной работе он тоже не должен висеть. */
const TIMEOUT_MS = 15_000;

export async function runHookProbe(
  command: string,
  fixture: EventFixture,
  cwd: string,
): Promise<ProbeResult> {
  const startedAt = Date.now();

  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      windowsHide: true,
      env: {
        ...process.env,
        // Скрипты берут отсюда каталог проекта — подсовываем папку песочницы,
        // чтобы проверка не трогала настоящие файлы.
        CLAUDE_PROJECT_DIR: cwd,
      },
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, TIMEOUT_MS);

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({
        fixtureId: fixture.id,
        exitCode: -1,
        stdout: '',
        stderr: error.message,
        decision: 'pass',
        matchesExpectation: false,
        durationMs: Date.now() - startedAt,
        timedOut,
      });
    });

    child.on('close', (code) => {
      clearTimeout(timer);

      const exitCode = code ?? 0;
      const parsed = tryParse(stdout);
      const { decision, reason, addedContext } = readDecision(exitCode, parsed);

      resolve({
        fixtureId: fixture.id,
        exitCode,
        stdout: stdout.slice(0, 20_000),
        stderr: stderr.slice(0, 20_000),
        decision,
        reason,
        addedContext,
        // Требование подтверждения — тоже вмешательство: действие не пройдёт молча.
        matchesExpectation: (decision !== 'pass') === fixture.expectsBlock,
        durationMs: Date.now() - startedAt,
        parsed,
        timedOut,
      });
    });

    child.stdin.write(JSON.stringify(fixture.payload));
    child.stdin.end();
  });
}

/**
 * Чем запускать `.ps1` вне Windows.
 *
 * Раньше здесь всегда стояло `powershell`, которого на Linux и macOS нет, —
 * и такой хук в песочнице просто не запускался. PowerShell там ставится
 * отдельно и называется `pwsh`; если его нет, честнее сказать об этом прямо,
 * чем показать невнятную ошибку запуска.
 */
function powershellCommand(): string | undefined {
  if (isWindows) return 'powershell';

  const probe = spawnSync('pwsh', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], {
    encoding: 'utf8',
    timeout: 5000,
  });

  return probe.status === 0 ? 'pwsh' : undefined;
}

/** Прогон скрипта из hooks/ — то же самое, но команда собирается сама. */
export function scriptCommand(scriptPath: string): string {
  if (!existsSync(scriptPath)) return '';

  const quoted = isWindows ? `"${scriptPath}"` : `'${scriptPath}'`;
  if (/\.(mjs|cjs|js)$/i.test(scriptPath)) return `node ${quoted}`;
  if (/\.ps1$/i.test(scriptPath)) {
    const shell = powershellCommand();
    return shell ? `${shell} -File ${quoted}` : '';
  }
  if (/\.py$/i.test(scriptPath)) return `python ${quoted}`;
  return `bash ${quoted}`;
}

interface HookOutput {
  hookSpecificOutput?: {
    permissionDecision?: string;
    permissionDecisionReason?: string;
    additionalContext?: string;
  };
  decision?: string;
  reason?: string;
  continue?: boolean;
  stopReason?: string;
}

/**
 * Решение хука по его ответу. Код 2 останавливает действие сразу, а в JSON
 * решение приходит словом: deny — запрет, ask — нужно подтверждение
 * пользователя, allow — согласие. Молчание означает «не вмешиваюсь».
 *
 * Экспортируется ради тестов: это чистая логика, которую хочется проверить
 * без запуска настоящего процесса хука.
 */
export function readDecision(
  exitCode: number,
  parsed: unknown,
): { decision: HookDecision; reason?: string; addedContext?: string } {
  if (exitCode === 2) return { decision: 'block', reason: 'Хук вышел с кодом 2' };

  const output = parsed as HookOutput | undefined;
  const specific = output?.hookSpecificOutput;
  const verdict = specific?.permissionDecision ?? output?.decision;
  const reason = specific?.permissionDecisionReason ?? output?.reason;
  const addedContext = specific?.additionalContext;

  if (verdict === 'deny' || verdict === 'block') return { decision: 'block', reason, addedContext };
  if (verdict === 'ask') return { decision: 'ask', reason, addedContext };
  if (output?.continue === false) {
    return { decision: 'block', reason: output.stopReason ?? reason, addedContext };
  }

  return { decision: 'pass', reason, addedContext };
}

function tryParse(text: string): unknown {
  const start = text.indexOf('{');
  if (start < 0) return undefined;

  try {
    return JSON.parse(text.slice(start, text.lastIndexOf('}') + 1));
  } catch {
    return undefined;
  }
}
