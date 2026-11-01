// Запись живого CLI для пробы этапа 8 (наблюдатель): настоящий `claude` / `qwen` через переходник
// (его `launch`, хост сессии, насос) над заглушкой модели; дом, каталог конфигурации и рабочая
// папка — одноразовые (`liveRoot`), настоящий конфиг человека не читается и не пишется.
// Ходы: упавшая команда (код 3), `sleep 25`, чтение с диапазоном и целиком, фоновая команда и её
// вывод, подагент, сжатие разговора. Итог: `adapters/<cli>/__fixtures__/s8-probe.jsonl` (stdout
// CLI, пути стенда → `<live>`), рядом `s8-probe.hooks.jsonl` (полезная нагрузка PreToolUse) и
// `s8-probe.tools.json` (схемы инструментов из первого запроса к модели).
// Запуск из `apps/core`: node --experimental-strip-types --no-warnings
//   src/adapters/conformance/__fixtures__/record-s8.ts <claude|qwen>
// После записи — `pnpm exec prettier --write` на `s8-probe.tools.json`: формат JSON задаёт
// prettier (короткие массивы в строку), а `format:check` CI иначе краснеет.
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startStubModel, type StepContext, type StepLike } from '@agentdeck/stub-model';
import type { AdapterEvent, CliAdapter, SessionHandle } from '../../adapter.types.ts';
import { CLAUDE_CHANNELS, createClaudeAdapter } from '../../claude/claude.ts';
import { createQwenAdapter, QWEN_CHANNELS } from '../../qwen/qwen.ts';
import {
  EventTap,
  HOOK_LOG,
  hookCommand,
  liveRoot,
  liveSpec,
  PERMIT_SERVER,
  livePin,
} from './live.ts';
import { s8FullWindow, s8Plan, s8Turns, type S8Cli } from './s8-scenario.ts';

const cli = process.argv[2] as S8Cli;
if (cli !== 'claude' && cli !== 'qwen') throw new Error('usage: record-s8.ts <claude|qwen>');

const live = liveRoot(`s8-${cli}-`);
const big = join(live.cwd, 'big.txt');
writeFileSync(
  big,
  Array.from({ length: 400 }, (_, i) => `line ${i + 1} ${'x'.repeat(90)}`).join('\n'),
);

interface Entry {
  kind: 'user' | 'tool-use' | 'tool-result';
  text: string;
}

/** Сообщения запроса обоих протоколов → плоский ряд: текст человека, вызов, результат. */
function entries(body: Record<string, unknown>): Entry[] {
  const out: Entry[] = [];
  const messages = (body.messages as Record<string, unknown>[] | undefined) ?? [];
  const textOf = (content: unknown): string =>
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content
            .filter((b) => (b as { type?: string }).type === 'text')
            .map((b) => String((b as { text?: unknown }).text ?? ''))
            .filter((t) => !t.trimStart().startsWith('<system-reminder>'))
            .join('\n')
        : '';
  for (const m of messages) {
    const content = m.content;
    if (m.role === 'tool') {
      out.push({ kind: 'tool-result', text: '' });
      continue;
    }
    if (m.role === 'assistant') {
      for (const call of (m.tool_calls as unknown[] | undefined) ?? [])
        out.push({ kind: 'tool-use', text: JSON.stringify(call) });
      if (Array.isArray(content))
        for (const b of content)
          if ((b as { type?: string }).type === 'tool_use')
            out.push({ kind: 'tool-use', text: '' });
      continue;
    }
    if (m.role !== 'user') continue;
    if (
      Array.isArray(content) &&
      content.some((b) => (b as { type?: string }).type === 'tool_result')
    )
      out.push({ kind: 'tool-result', text: '' });
    const text = textOf(content);
    if (text.trim() !== '') out.push({ kind: 'user', text });
  }
  return out;
}

const plan = s8Plan(cli, { big, cwd: live.cwd });
let firstTools: unknown = null;

function step(ctx: StepContext): StepLike {
  if (firstTools === null) firstTools = ctx.request.body.tools ?? null;
  const flat = entries(ctx.request.body);
  let last = -1;
  for (let i = flat.length - 1; i >= 0; i -= 1)
    if (flat[i]!.kind === 'user') {
      last = i;
      break;
    }
  const text = last >= 0 ? flat[last]!.text : '';
  const marker = /PROBE_[A-Z]+/.exec(text)?.[0];
  if (!marker || !plan[marker]) return `PLAIN_REPLY ${text.slice(0, 40).replace(/\s+/g, ' ')}`;
  const used = flat.slice(last + 1).filter((e) => e.kind === 'tool-use').length;
  const calls = plan[marker];
  if (used < calls.length) return { tool: calls[used]! };
  const usage = s8FullWindow(cli, marker);
  return usage ? { text: `DONE ${marker}`, usage } : `DONE ${marker}`;
}

const stub = await startStubModel({ script: step });
const adapter: CliAdapter = cli === 'claude' ? createClaudeAdapter() : createQwenAdapter();
const endpoint =
  cli === 'claude'
    ? {
        channel: CLAUDE_CHANNELS[0]!,
        endpoint: {
          baseUrl: stub.baseUrl,
          dialect: 'anthropic-messages' as const,
          model: 'stub-model',
          key: 'k',
        },
      }
    : {
        channel: QWEN_CHANNELS.find((c) => c.dialect === 'openai-chat')!,
        endpoint: {
          baseUrl: stub.baseUrl,
          dialect: 'openai-chat' as const,
          model: 'stub-model',
          key: 'k',
        },
      };
const configDir = join(live.home, cli === 'claude' ? '.claude' : '.qwen');
const spec = liveSpec(live, {
  endpoint,
  // Claude исполняет хук оболочкой bash (обратная косая — экранирование): пути в кавычках; Qwen —
  // через cmd без кавычек (как `resume-child.ts`).
  coreHook:
    cli === 'claude'
      ? hookCommand('core', live.logs.core)
      : `node ${HOOK_LOG} core --log ${live.logs.core}`,
  permitServer: { name: 'agentdeck-permit', tool: 'approve' },
  mcpServers: {
    'agentdeck-permit': {
      command: 'node',
      args: [PERMIT_SERVER],
      env: { PERMIT_DECISION: 'allow', PERMIT_LOG: live.logs.permit },
    },
  },
  env: { pin: livePin(live, cli === 'claude' ? { CLAUDE_CONFIG_DIR: configDir } : {}) },
});

const launched = await adapter.launch(spec);
if (!launched.ok) throw new Error(launched.reason);
const handle: SessionHandle = launched.handle;
const tap = new EventTap(adapter, handle);
const answer = (e: AdapterEvent): void => {
  if (e.type !== 'permit.request') return;
  const input = (e.raw as { input?: Record<string, unknown> }).input ?? {};
  void adapter.answerPermit?.(handle, e.requestId, { behavior: 'allow', updatedInput: input });
};
const log: string[] = [];
try {
  for (const turn of s8Turns()) {
    await adapter.send(handle, turn.message, crypto.randomUUID());
    const ended = await tap.until((e) => {
      answer(e);
      return e.type === 'turn.ended';
    }, 180_000);
    log.push(`${turn.message} -> ${JSON.stringify(ended)}`);
    if (turn.waitWakeMs) {
      try {
        const woke = await tap.until((e) => {
          answer(e);
          return e.type === 'turn.ended';
        }, turn.waitWakeMs);
        log.push(`  wake -> ${JSON.stringify(woke)}`);
      } catch (error) {
        log.push(`  no wake: ${String(error).slice(0, 200)}`);
      }
    }
  }
} finally {
  await adapter.stop(handle, 'tree');
  await stub.close();
}

const out = fileURLToPath(new URL(`../../${cli}/__fixtures__/`, import.meta.url));
const scrub = (raw: string): string => {
  let text = raw;
  const forms = [live.root, live.root.replaceAll('\\', '/'), live.root.replaceAll('\\', '\\\\')];
  for (const form of forms) text = text.split(form).join(form.includes('/') ? '<live>' : '<live>');
  // Короткое имя 8.3 того же каталога (CLI пишет и его).
  text = text.replace(
    /[A-Za-z]:(\\\\|\\|\/)[^"\s]*?~\d[^"\s]*?(?=\\\\work|\\work|\/work|")/g,
    '<live>',
  );
  // Профиль человека, который CLI пишет сам (`powershell_path`), и имя машины — не в запись.
  text = text.replace(/[A-Za-z]:(\\\\|\\)Users(\\\\|\\)[^\\"]+/g, '<home>');
  return text.split(hostname()).join('<host>');
};
const stdout = scrub(readFileSync(join(handle.dir, 'stdout.log'), 'utf8'));
const leaks = [hostname(), 'Users\\', 'Users/'].filter((w) => stdout.includes(w));
writeFileSync(join(out, 's8-probe.jsonl'), stdout);
const hooks = existsSync(live.logs.core) ? readFileSync(live.logs.core, 'utf8') : '';
writeFileSync(join(out, 's8-probe.hooks.jsonl'), scrub(hooks));
writeFileSync(join(out, 's8-probe.tools.json'), JSON.stringify(firstTools, null, 1));
process.stdout.write(
  `${JSON.stringify({ dir: handle.dir, turns: log, leaks, requests: stub.requests.length })}\n`,
);
if (process.env.S8_KEEP !== '1') rmSync(live.root, { recursive: true, force: true, maxRetries: 5 });
