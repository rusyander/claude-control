import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnCliProcess } from '../../../lib/cli-spawn/cli-spawn.ts';
import { killChildTree } from '../../../lib/process-tree/process-tree.ts';
import type { TestsAgentEvent, TestsAgentRun, TestsAgentStartOptions } from './agent-run.types.ts';
import {
  QWEN_TESTS_EXCLUDED_TOOLS,
  composeQwenGateSettings,
  unexpectedQwenTools,
} from './foreign-gate.ts';

/**
 * Агент тестов на Qwen Code: одноразовый `qwen` в режиме `yolo`, где каждый
 * вызов инструмента проходит хук проверки прав (`qwen-gate-hook.mjs`) к
 * приёмнику прогона.
 *
 * `yolo` здесь не «без проверки»: вопросы CLI заменены решением панели, как у
 * Claude приёмником брокера. Но держит всё ОДИН хук, а сам Qwen при сбое хука
 * вызов пропускает (проба P3). Поэтому поверх хука три страховки:
 * - хук сам отказывает на любой сбой (код 2);
 * - канарейка `init`: незнакомый встроенный инструмент новой версии — прогон
 *   не идёт;
 * - сторож: результат вызова, по которому приёмник НЕ разрешал (`gate.decided`
 *   по `tool_use.id`, он же `tool_call_id` хука), — прогон убивается сразу.
 *   Сторож действует ПОСЛЕ факта: одна запись успеет лечь, зато не вторая и не
 *   молча.
 *
 * `--safe-mode` и `--bare` здесь НЕЛЬЗЯ: оба выставляют `disableAllHooks=true`
 * и снимают хук вместе с проверкой (`.agent/provider-formats.agent.md`).
 */

const HOOK_SCRIPT = fileURLToPath(new URL('./qwen-gate-hook.mjs', import.meta.url));

/** argv прогона: задание идёт в stdin, в argv только флаги. */
export function qwenTestsArgs(): string[] {
  return [
    '--approval-mode',
    'yolo',
    '--output-format',
    'stream-json',
    '--chat-recording=false',
    '--exclude-tools',
    QWEN_TESTS_EXCLUDED_TOOLS.join(','),
  ];
}

/** Команда хука: пути в кавычках, косые вперёд — так её разбирает и cmd, и sh. */
export function qwenHookCommand(gateFile: string, hookScript = HOOK_SCRIPT): string {
  const slash = (path: string): string => path.replace(/\\/g, '/');
  return `"${slash(process.execPath)}" "${slash(hookScript)}" "${slash(gateFile)}"`;
}

interface StreamBlock {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  is_error?: boolean;
}

interface StreamEvent {
  type?: string;
  subtype?: string;
  tools?: unknown;
  message?: { content?: StreamBlock[] };
  result?: unknown;
  is_error?: boolean;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

const count = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;

export interface QwenTestsRunDeps {
  /** Чем гасить дерево процесса; подменяется в тестах. */
  kill?: (child: ChildProcessWithoutNullStreams) => void;
  /** Скрипт хука; подменяется проверкой-мутантом. */
  hookScript?: string;
}

export class QwenTestsRun implements TestsAgentRun {
  private child: ChildProcessWithoutNullStreams | undefined;
  private stopped = false;

  private readonly deps: QwenTestsRunDeps;

  constructor(deps: QwenTestsRunDeps = {}) {
    this.deps = deps;
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.child) (this.deps.kill ?? killChildTree)(this.child);
  }

  start(options: TestsAgentStartOptions, onEvent: (event: TestsAgentEvent) => void): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), 'cc-tests-qwen-'));
    const cleanup = (): void => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Во временной папке только адрес приёмника; не удалилась — не повод ронять прогон.
      }
    };
    const gateFile = join(dir, 'gate.json');
    writeFileSync(
      gateFile,
      JSON.stringify({ url: options.gate.baseUrl, runId: options.gate.runId }),
      'utf8',
    );
    const settingsFile = join(dir, 'system-settings.json');
    writeFileSync(
      settingsFile,
      JSON.stringify(
        composeQwenGateSettings(
          { ...process.env, ...options.env },
          qwenHookCommand(gateFile, this.deps.hookScript),
        ),
      ),
      'utf8',
    );

    const spawned = spawnCliProcess(options.command, qwenTestsArgs(), {
      spawnImpl: options.spawnImpl,
      cwd: options.cwd,
      env: {
        ...options.env,
        // Один системный слой на прогон: всё, что лежало в нём у человека, плюс хук.
        QWEN_CODE_SYSTEM_SETTINGS_PATH: settingsFile,
        QWEN_CODE_SUPPRESS_YOLO_WARNING: '1',
      },
    });
    if (spawned.error) {
      cleanup();
      onEvent({ kind: 'error', message: spawned.error.message });
      return Promise.resolve();
    }
    const child = spawned.child;
    this.child = child;
    const startedAt = Date.now();
    const provider = options.providerName;

    return new Promise((resolve) => {
      let settled = false;
      let pending = Buffer.alloc(0);
      const errChunks: Buffer[] = [];
      const names = new Map<string, string>();
      let result: StreamEvent | undefined;

      const settle = (event?: TestsAgentEvent): void => {
        if (settled) return;
        settled = true;
        cleanup();
        if (event && !this.stopped) onEvent(event);
        resolve();
      };

      /** Обрыв по нарушению: событие сразу, процесс — следом. */
      const abort = (event: TestsAgentEvent): void => {
        settle(event);
        this.stop();
      };

      const handle = (event: StreamEvent): void => {
        if (event.type === 'system' && event.subtype === 'init') {
          const extra = unexpectedQwenTools(event.tools);
          if (extra.length > 0) {
            abort({
              kind: 'error',
              message: `Прогон остановлен: ${provider} предложил агенту инструменты, которых панель не проверяет (${extra.join(', ')}).`,
              messageCode: 'tests-agent-gate-bypassed',
              params: { provider, tool: extra.join(', ') },
            });
          }
          return;
        }
        if (event.type === 'assistant') {
          for (const block of event.message?.content ?? []) {
            if (block.type === 'text' && block.text) onEvent({ kind: 'text', text: block.text });
            if (block.type === 'tool_use' && block.name && block.id) {
              names.set(block.id, block.name);
              onEvent({ kind: 'tool', name: block.name, input: block.input ?? {}, id: block.id });
            }
          }
          return;
        }
        if (event.type === 'user') {
          for (const block of event.message?.content ?? []) {
            if (block.type !== 'tool_result' || !block.tool_use_id) continue;
            // Отказ хука приходит результатом с ошибкой — вызов не исполнился.
            if (block.is_error === true) continue;
            if (options.gate.decided(block.tool_use_id) === 'allow') continue;
            const tool = names.get(block.tool_use_id) ?? block.tool_use_id;
            return abort({
              kind: 'error',
              message: `Прогон остановлен: ${provider} выполнил «${tool}» мимо проверки прав панели. Проверьте рабочую копию — изменение могло лечь вне разрешённых папок.`,
              messageCode: 'tests-agent-gate-bypassed',
              params: { provider, tool },
            });
          }
          return;
        }
        if (event.type === 'result') result = event;
      };

      const line = (text: string): void => {
        if (settled || !text.trim()) return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          return;
        }
        if (parsed && typeof parsed === 'object') handle(parsed as StreamEvent);
      };

      // Строки режем по байту `\n`, декодируем целой строкой: граница чтения рвёт UTF-8.
      child.stdout.on('data', (chunk: Buffer) => {
        pending = Buffer.concat([pending, chunk]);
        let at = pending.indexOf(0x0a);
        while (at >= 0) {
          line(pending.subarray(0, at).toString('utf8'));
          pending = pending.subarray(at + 1);
          at = pending.indexOf(0x0a);
        }
      });
      child.stderr.on('data', (chunk: Buffer) => {
        if (errChunks.length < 64) errChunks.push(chunk);
      });
      child.on('error', (error) => settle({ kind: 'error', message: error.message }));
      child.on('close', (code) => {
        if (pending.length) line(pending.toString('utf8'));
        if (settled) return;
        if (this.stopped) return settle();
        if (result && result.is_error !== true) {
          const usage = result.usage ?? {};
          onEvent({
            kind: 'usage',
            input: count(usage.input_tokens),
            output: count(usage.output_tokens),
            cacheRead: count(usage.cache_read_input_tokens),
            cacheCreation: 0,
          });
          // Сессии нет (`--chat-recording=false`): открыть прогон в чате нечем.
          return settle({
            kind: 'done',
            costUsd: 0,
            durationMs: Date.now() - startedAt,
            sessionId: '',
          });
        }
        const said =
          (result && typeof result.result === 'string' ? result.result : '') ||
          Buffer.concat(errChunks).toString('utf8').trim().slice(0, 500);
        settle({
          kind: 'error',
          message: said || `${provider} завершился с кодом ${code ?? '?'} без итога.`,
        });
      });

      // Ошибка записи в stdin — CLI закрылся раньше; необработанная роняла бы сервер.
      child.stdin.on('error', () => {});
      child.stdin.end(options.prompt);
    });
  }
}
