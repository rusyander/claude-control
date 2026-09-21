import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { EnvNeed } from '@agentdeck/contracts/portable-env';
import { isEnvNeed } from '@agentdeck/contracts/portable-env';

/**
 * ЖИВОЕ НАБЛЮДЕНИЕ требований скрипта — вторая половина правила «слабейший
 * способ не достаточен» (П0.2). Статический разбор говорит, что в тексте видно;
 * здесь скрипту подсовывают нагрузку через ОБЪЕКТ-ПЕРЕХВАТЧИК и записывают,
 * какие поля он на самом деле прочитал.
 *
 * Как это устроено. Скрипт запускается своим обычным способом — отдельным
 * процессом node, — но перед ним загружается переходник, который подменяет
 * `JSON.parse`: разобранная нагрузка возвращается `Proxy`, и каждое чтение поля
 * уходит в список. Список печатается в stderr отдельной строкой с меткой, чтобы
 * не смешаться с собственным выводом скрипта.
 *
 * ГРАНИЦЫ, которые здесь важнее удобства:
 *
 *  - наблюдение ИСПОЛНЯЕТ произвольный код, поэтому вызывается ТОЛЬКО по
 *    отдельному решению человека (инвариант 9), никогда при обычном чтении
 *    паспорта среды;
 *  - перехватчик существует только для скриптов на node. Оболочечный,
 *    питоновский или бинарный хук наблюдать этим способом нельзя, и проба
 *    ОТКАЗЫВАЕТСЯ с названной причиной, а не возвращает пустой список: пустой
 *    список здесь означал бы «ничего не нужно», то есть ложь.
 */

/** Расширения, для которых переходник существует. Всё прочее — отказ с причиной. */
const NODE_EXTENSIONS = ['.js', '.mjs', '.cjs'];

/** Ключи нагрузки, за чтением которых следим: ключ → факт канона. */
const PROBE_PAYLOAD: Record<string, EnvNeed> = {
  tool_name: 'tool_name',
  tool_input: 'tool_input',
  tool_response: 'tool_result',
  prompt: 'prompt',
  transcript_path: 'transcript',
  cwd: 'cwd',
  session_id: 'session_id',
  subagent_type: 'subagent',
  trigger: 'compact',
};

/** Метка строки отчёта переходника — по ней читаем результат из stderr. */
const MARK = '__portability_needs__';

/** Итог пробы: либо наблюдённые факты, либо названный отказ. */
export type NeedsProbeResult =
  | { readonly observed: true; readonly facts: readonly EnvNeed[] }
  | { readonly observed: false; readonly why: string };

/** Текст переходника. Пишется во временный файл — в дереве сервера ему не место. */
function harnessSource(): string {
  const fields = Object.keys(PROBE_PAYLOAD)
    .map((key) => JSON.stringify(key))
    .join(',');
  return [
    `const FIELDS = new Set([${fields}]);`,
    'const seen = new Set();',
    'const parse = JSON.parse;',
    'JSON.parse = function (text, reviver) {',
    '  const value = parse(text, reviver);',
    '  if (!value || typeof value !== "object" || Array.isArray(value)) return value;',
    '  return new Proxy(value, {',
    '    get(target, key) {',
    '      if (typeof key === "string" && FIELDS.has(key)) seen.add(key);',
    '      return Reflect.get(target, key);',
    '    },',
    '  });',
    '};',
    `process.on("exit", () => { process.stderr.write("\\n${MARK}" + JSON.stringify([...seen]) + "\\n"); });`,
  ].join('\n');
}

/** Нагрузка, которую подсовывают скрипту: значения-заглушки, ничего настоящего. */
function probePayload(event: string): string {
  return JSON.stringify({
    hook_event_name: event,
    tool_name: 'Read',
    tool_input: { file_path: 'probe.txt' },
    tool_response: { ok: true },
    prompt: 'probe',
    transcript_path: 'probe.jsonl',
    cwd: process.cwd(),
    session_id: 'probe',
    subagent_type: 'probe',
    trigger: 'manual',
  });
}

/**
 * Прогнать скрипт с перехватчиком и вернуть, какие поля он прочитал.
 *
 * Скрипт запускается с ограничением по времени и без наследования окружения
 * панели: проба — не рабочий прогон хука, её задача одна — увидеть чтения.
 */
export async function probeHookNeeds(params: {
  scriptPath: string;
  event: string;
  timeoutMs?: number;
}): Promise<NeedsProbeResult> {
  const lower = params.scriptPath.toLowerCase();
  if (!NODE_EXTENSIONS.some((extension) => lower.endsWith(extension))) {
    return {
      observed: false,
      why: 'перехватчик существует только для скриптов на node; для этого интерпретатора наблюдение не проводилось',
    };
  }

  const dir = mkdtempSync(join(tmpdir(), 'agentdeck-needs-'));
  const harnessPath = join(dir, 'harness.mjs');
  try {
    writeFileSync(harnessPath, harnessSource(), 'utf8');
    const stderr = await runScript(params.scriptPath, harnessPath, probePayload(params.event), {
      timeoutMs: params.timeoutMs ?? 5_000,
    });
    if (stderr.timedOut) {
      return { observed: false, why: 'скрипт не завершился за отведённое время' };
    }
    const line = stderr.text
      .split(/\r?\n/)
      .reverse()
      .find((row) => row.startsWith(MARK));
    if (!line) {
      return {
        observed: false,
        why: 'переходник не вернул отчёт: скрипт не разбирал нагрузку JSON',
      };
    }
    const raw: unknown = JSON.parse(line.slice(MARK.length));
    if (!Array.isArray(raw)) return { observed: false, why: 'отчёт переходника неразборчив' };
    const facts = raw
      .filter((key): key is string => typeof key === 'string')
      .map((key) => PROBE_PAYLOAD[key])
      .filter((need): need is EnvNeed => need !== undefined && isEnvNeed(need));
    return { observed: true, facts: [...new Set(facts)] };
  } catch (error) {
    return { observed: false, why: error instanceof Error ? error.message : String(error) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Запустить скрипт под переходником, скормив нагрузку в stdin. */
function runScript(
  scriptPath: string,
  harnessPath: string,
  payload: string,
  options: { timeoutMs: number },
): Promise<{ text: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [`--import=${pathToFileURL(harnessPath).href}`, scriptPath],
      { stdio: ['pipe', 'ignore', 'pipe'] },
    );

    let text = '';
    let timedOut = false;
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      text += chunk;
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, options.timeoutMs);

    child.on('error', () => {
      clearTimeout(timer);
      resolve({ text, timedOut });
    });
    child.on('close', () => {
      clearTimeout(timer);
      resolve({ text, timedOut });
    });

    child.stdin.end(payload);
  });
}
