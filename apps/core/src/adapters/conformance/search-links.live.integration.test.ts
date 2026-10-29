import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { claudeRunFacts } from '@agentdeck/providers/claude';
import { qwenRunFacts } from '@agentdeck/providers/qwen';
import { startStubModel, type StubModel } from '@agentdeck/stub-model';
import { hasCli } from '../../stub-tasks/__fixtures__/e2e/stand.ts';
import type { CliAdapter, SessionSpec } from '../adapter.types.ts';
import { CLAUDE_CHANNELS, createClaudeAdapter } from '../claude/claude.ts';
import { createQwenAdapter, QWEN_CHANNELS } from '../qwen/qwen.ts';
import { EventTap, HOOK_LOG, liveRoot, liveSpec, type LiveRoot } from './__fixtures__/live.ts';

/**
 * Ходит ли поиск CLI по ссылке, уводящей из копии (F-87 pass 2): в копии `link` — ссылка
 * (Windows — junction, POSIX — symlink) на внешний каталог с `leak-secret.txt`, рядом свой
 * `inside-secret.txt`; в обоих строка `MARKER_42`. Модель-заглушка зовёт поиск от cwd и судит
 * ТОЛЬКО по результату инструмента в следующем запросе (не по всему запросу: Qwen кладёт в
 * контекст листинг cwd): FOLLOWED — внешний файл в выдаче, NOT_FOLLOWED — только свой,
 * NO_RESULT — поиск не дал ничего (проба не доказывает ничего). Контроль: `link` — настоящий
 * каталог в копии, детектор обязан увидеть FOLLOWED.
 */

const roots: LiveRoot[] = [];
const stubs: StubModel[] = [];

afterAll(async () => {
  for (const stub of stubs) await stub.close();
  for (const root of roots) rmSync(root.root, { recursive: true, force: true, maxRetries: 5 });
}, 60_000);

type Verdict = 'FOLLOWED' | 'NOT_FOLLOWED' | 'NO_RESULT';

interface Probe {
  adapter: () => CliAdapter;
  channel: NonNullable<SessionSpec['endpoint']>['channel'];
  dialect: 'anthropic-messages' | 'openai-chat';
}

const CLAUDE: Probe = {
  adapter: () => createClaudeAdapter(),
  channel: CLAUDE_CHANNELS[0]!,
  dialect: 'anthropic-messages',
};
const QWEN: Probe = {
  adapter: () => createQwenAdapter(),
  channel: QWEN_CHANNELS.find((c) => c.dialect === 'openai-chat')!,
  dialect: 'openai-chat',
};

/** Текст результатов инструментов запроса: `tool_result` Anthropic, сообщения `role: tool` OpenAI. */
function toolResults(body: unknown): string {
  const messages = (body as { messages?: unknown[] } | null)?.messages ?? [];
  const out: string[] = [];
  for (const message of messages as { role?: string; content?: unknown }[]) {
    if (message.role === 'tool') out.push(JSON.stringify(message.content));
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content as { type?: string; content?: unknown }[]) {
      if (part.type === 'tool_result') out.push(JSON.stringify(part.content));
    }
  }
  return out.join('\n');
}

function verdictOf(result: string): Verdict {
  if (result.includes('leak-secret') || result.includes('MARKER_42 outside')) return 'FOLLOWED';
  if (result.includes('inside-secret') || result.includes('MARKER_42 inside'))
    return 'NOT_FOLLOWED';
  return 'NO_RESULT';
}

async function probe(
  cli: Probe,
  tool: string,
  args: (cwd: string) => Record<string, unknown>,
  realDir = false,
): Promise<{ verdict: Verdict; result: string }> {
  const live = liveRoot('links-');
  roots.push(live);
  const outside = realDir ? join(live.cwd, 'link') : join(live.root, 'outside');
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, 'leak-secret.txt'), 'MARKER_42 outside\n');
  writeFileSync(join(live.cwd, 'inside-secret.txt'), 'MARKER_42 inside\n');
  if (!realDir) {
    symlinkSync(outside, join(live.cwd, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  }
  let result = '';
  const stub = await startStubModel({
    script: (ctx) => {
      if (ctx.index === 0) return { tool: { name: tool, args: args(live.cwd) } };
      result = toolResults(ctx.request.body);
      return 'PROBED';
    },
  });
  stubs.push(stub);
  const adapter = cli.adapter();
  const launched = await adapter.launch(
    liveSpec(live, {
      coreHook: `node ${HOOK_LOG} core --log ${live.logs.core}`,
      endpoint: {
        channel: cli.channel,
        endpoint: { baseUrl: stub.baseUrl, dialect: cli.dialect, model: 'stub-model', key: 'k' },
      },
    }),
  );
  if (!launched.ok) throw new Error(launched.reason);
  const tap = new EventTap(adapter, launched.handle);
  try {
    await adapter.send(launched.handle, 'search', crypto.randomUUID());
    await tap.until((e) => e.type === 'turn.ended', 120_000);
  } finally {
    await adapter.stop(launched.handle, 'tree');
  }
  return { verdict: verdictOf(result), result };
}

const SEARCHES: { cli: Probe; present: boolean; tool: string; args: Record<string, unknown> }[] = [
  {
    cli: CLAUDE,
    present: hasCli(claudeRunFacts.binary.command),
    tool: 'Grep',
    args: { pattern: 'MARK.R_42' },
  },
  {
    cli: CLAUDE,
    present: hasCli(claudeRunFacts.binary.command),
    tool: 'Grep',
    args: { pattern: 'MARK.R_42', output_mode: 'content' },
  },
  {
    cli: CLAUDE,
    present: hasCli(claudeRunFacts.binary.command),
    tool: 'Glob',
    args: { pattern: '**/*.txt' },
  },
  {
    cli: QWEN,
    present: hasCli(qwenRunFacts.binary.command),
    tool: 'grep_search',
    args: { pattern: 'MARK.R_42' },
  },
  {
    cli: QWEN,
    present: hasCli(qwenRunFacts.binary.command),
    tool: 'glob',
    args: { pattern: '**/*.txt' },
  },
];

describe('search tools of the real CLIs over a link leaving the copy', () => {
  for (const s of SEARCHES) {
    const name = `${s.tool} ${JSON.stringify(s.args)}`;
    it.skipIf(!s.present)(
      `control: ${name} over a REAL dir in the copy reports it`,
      async () => {
        const run = await probe(s.cli, s.tool, (cwd) => ({ ...s.args, path: cwd }), true);
        expect(run.verdict, run.result).toBe('FOLLOWED');
      },
      200_000,
    );
    it.skipIf(!s.present)(
      `${name} from cwd does not walk into the link`,
      async () => {
        const run = await probe(s.cli, s.tool, (cwd) => ({ ...s.args, path: cwd }));
        expect(run.verdict, run.result).toBe('NOT_FOLLOWED');
      },
      200_000,
    );
  }
});
