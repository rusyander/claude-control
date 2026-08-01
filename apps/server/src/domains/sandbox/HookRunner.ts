import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { killChildTree } from '../../lib/process-tree.ts';
import { readDecision, tryParse } from './HookDecision.ts';
import { CUSTOM_FIXTURE_ID, TIMEOUT_MS, isWindows } from './HookProbe.constants.ts';
import type { EventFixture, ProbeResult } from './HookProbe.types.ts';

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
      // Хук запускается через оболочку: убить нужно дерево, иначе на Windows
      // умрёт только `cmd.exe`, а сам скрипт продолжит держать запрос открытым.
      killChildTree(child);
    }, TIMEOUT_MS);

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    // Хук волен не читать stdin и выйти сразу (частый случай — SessionStart и
    // Stop его игнорируют). Тогда запись ниже бьёт в закрытый канал, и поток
    // stdin выбрасывает `error` (EPIPE на POSIX, EOF на Windows). Необработанное
    // событие потока роняет весь процесс сервера — поэтому глушим его здесь:
    // для прогона важен код выхода и вывод хука, а не судьба недописанного ввода.
    child.stdin.on('error', () => undefined);

    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({
        fixtureId: fixture.id,
        exitCode: -1,
        stdout: '',
        stderr: error.message,
        // Процесс не поднялся вовсе — это не «пропустил», а несостоявшийся прогон.
        decision: 'error',
        reason: 'Хук не запустился',
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
        // Требование подтверждения — тоже вмешательство: действие не пройдёт
        // молча. Несостоявшийся прогон (`error`) ожиданию не соответствует
        // никогда: хук ничего не ответил, сверять не с чем.
        matchesExpectation:
          decision !== 'error' &&
          (decision === 'block' || decision === 'ask') === fixture.expectsBlock,
        durationMs: Date.now() - startedAt,
        parsed,
        timedOut,
      });
    });

    // try — на случай, если процесс не поднялся и потока ввода нет вовсе:
    // синхронный бросок здесь ушёл бы мимо обработчика `error` выше.
    try {
      child.stdin.write(JSON.stringify(fixture.payload));
      child.stdin.end();
    } catch {
      // Записать вход не удалось — решение примем по коду выхода и выводу.
    }
  });
}

/**
 * Прогон хука на произвольном пользовательском событии. Тот же механизм, что и
 * заготовки: событие оборачивается в разовую заготовку без ожидания вердикта
 * (проверяем не «угадал ли автор», а как хук ответит на конкретный ввод).
 */
export function runCustomHookProbe(
  command: string,
  payload: Record<string, unknown>,
  cwd: string,
): Promise<ProbeResult> {
  const event = typeof payload.hook_event_name === 'string' ? payload.hook_event_name : 'custom';

  return runHookProbe(
    command,
    {
      id: CUSTOM_FIXTURE_ID,
      event,
      title: 'Свой ввод',
      description: '',
      // У произвольного ввода нет «правильного» ответа, поэтому и ожидания нет.
      expectsBlock: false,
      payload,
    },
    cwd,
  );
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
  // TypeScript исполняем без сборки: Node в проекте 22.6+, ему хватает
  // --experimental-strip-types (типы срезаются, JS выполняется). Иначе `.ts`
  // числился поддержанным, а по факту уходил в `bash script.ts` и не работал.
  if (/\.(mts|cts|ts)$/i.test(scriptPath)) return `node --experimental-strip-types ${quoted}`;
  if (/\.ps1$/i.test(scriptPath)) {
    const shell = powershellCommand();
    return shell ? `${shell} -File ${quoted}` : '';
  }
  if (/\.py$/i.test(scriptPath)) return `python ${quoted}`;
  return `bash ${quoted}`;
}
