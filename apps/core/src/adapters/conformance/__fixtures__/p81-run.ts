import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  AdapterChannelSummary,
  AdapterEvent,
  CliAdapter,
  BoundEndpoint,
  SessionSpec,
} from '../../adapter.types.ts';
import { readArtifact } from '../../launcher/session-io.ts';
import { READ_ONLY_DENIED } from '../../read-only.ts';
import { EventTap, HOOK_LOG, liveSpec, livePin, type LiveRoot } from './live.ts';
import { fakeGit, readMarker, realCoreHook, type FakeCore } from './p81-stand.ts';
import { withBinFirst } from './rpc-replay.ts';

/**
 * Прогон P81 одного режима права для переходника поверх ACP (goose, opencode): настоящий хук
 * ядра, подставное ядро и подставной git со стенда, модель — stub-model. Вопрос о праве в потоке
 * тест решает за судью ядра: всё, кроме публикации.
 */

export type P81Hook = 'core' | 'allow-all' | 'crash';

/**
 * Кто отвечает на вопрос о праве в потоке: `judge` — судья ядра (всё, кроме публикации), `all` —
 * разрешает всё (публикацию держит только хук), `none` — отвечающего нет, отказ на месте.
 */
export type P81Answer = 'judge' | 'all' | 'none';

export interface P81Mode {
  name: string;
  over: (spec: SessionSpec) => Partial<SessionSpec>;
  /** Хук: настоящий хук ядра, разрешающий всё (второй замок) или падающий (fail-closed). */
  hook: P81Hook;
  answer: P81Answer;
  /** Разрешённый `git status` обязан дойти до подставного git: иначе проверка пуста. */
  positive?: true;
}

const noAnswerer = (): Partial<SessionSpec> => ({ permitServer: undefined });

export const P81_MODES: P81Mode[] = [
  {
    name: 'write session, core answers asks',
    over: () => ({}),
    hook: 'core',
    answer: 'judge',
    positive: true,
  },
  {
    name: 'hook alone: every ask allowed, the core hook refuses publishing',
    over: () => ({}),
    hook: 'core',
    answer: 'all',
    positive: true,
  },
  {
    name: 'write session, no permit answerer (asks declined in place)',
    over: noAnswerer,
    hook: 'core',
    answer: 'none',
  },
  {
    name: 'read-only session',
    over: (spec) => ({ deny: { ...spec.deny, tools: [...READ_ONLY_DENIED] } }),
    hook: 'core',
    answer: 'all',
  },
  {
    name: 'second lock: the hook allows everything, the core permit refuses publishing',
    over: () => ({}),
    hook: 'allow-all',
    answer: 'judge',
    positive: true,
  },
  {
    name: 'fail-closed: every ask allowed, the core hook crashes, nothing runs',
    over: () => ({}),
    hook: 'crash',
    answer: 'all',
  },
];

export interface P81Input {
  live: LiveRoot;
  core: FakeCore;
  adapter: CliAdapter;
  channel: AdapterChannelSummary;
  dialect: BoundEndpoint['dialect'];
  baseUrl: string;
  index: number;
  mode: P81Mode;
  /** Переменные системы, без которых CLI не стартует (TEMP, PATHEXT, …) — из процесса теста. */
  keep?: readonly string[];
}

export interface P81Result {
  seen: AdapterEvent[];
  marker: string;
  dir: string;
  stdout: string;
}

const q = (path: string): string => `"${path}"`;

function hookOf(mode: P81Mode, dir: string, root: string): string {
  if (mode.hook === 'core') return realCoreHook(dir);
  // Путь node с пробелом (`Program Files`) без кавычек — «команда не найдена», не разрешение.
  if (mode.hook === 'allow-all') return `${q(process.execPath)} ${q(HOOK_LOG)} core`;
  // Скрипта нет — node выходит с ошибкой: хук упал, а не отказал.
  return `${q(process.execPath)} ${q(join(root, 'no-such-hook.mjs'))}`;
}

export async function runP81Mode(input: P81Input): Promise<P81Result> {
  const { live, core, adapter, mode, index } = input;
  const marker = join(live.root, `git-${index}.log`);
  const bin = join(live.root, `fakebin-${index}`);
  fakeGit(bin, marker);
  const base = liveSpec(live);
  const extra: Record<string, string> = {};
  for (const name of input.keep ?? []) {
    const value = process.env[name];
    if (value !== undefined) extra[name] = value;
  }
  const spec: SessionSpec = {
    ...base,
    coreHook: hookOf(mode, base.dir, live.root),
    permitServer: { name: 'agentdeck-permit', tool: 'permit' },
    endpoint: {
      channel: input.channel,
      endpoint: {
        baseUrl: input.baseUrl,
        dialect: input.dialect,
        model: 'stub-model',
        key: 'stub-key',
      },
    },
    env: { pin: withBinFirst(livePin(live, extra), bin) },
    core: { ...base.core, coreUrl: core.url },
  };
  const final: SessionSpec = { ...spec, ...mode.over(spec) };
  // Режим без отвечающего снимает поле целиком: `permitServer: undefined` — тоже «нет».
  if (final.permitServer === undefined) delete final.permitServer;
  const launched = await adapter.launch(final);
  if (!launched.ok) throw new Error(launched.reason);
  const tap = new EventTap(adapter, launched.handle);
  try {
    await adapter.send(launched.handle, 'run the two commands', P81_ATTRIBUTION);
    for (;;) {
      const ev = await tap.until(
        (e) => e.type === 'permit.request' || e.type === 'turn.ended',
        120_000,
      );
      if (ev.type === 'turn.ended') break;
      if (ev.type !== 'permit.request') continue;
      const read = adapter.permitCodec.read(ev.raw);
      const ask = read ? adapter.mapPermission(read.call) : null;
      const allow =
        ask !== null &&
        (mode.answer === 'all' || (mode.answer === 'judge' && !(ask.argv ?? []).includes('push')));
      await adapter.answerPermit!(
        launched.handle,
        ev.requestId,
        adapter.permitCodec.render(
          allow ? { allow: true, input: read!.call.input } : { allow: false, message: 'no' },
        ),
      );
    }
  } catch (error) {
    // Сеанс кончился раньше хода: причина — в stderr CLI, без неё падение не разобрать.
    const stderr = readArtifact(launched.handle.dir, 'stderr').text.slice(-2000);
    throw new Error(`${(error as Error).message}; stderr: ${stderr}`, { cause: error });
  } finally {
    await adapter.stop(launched.handle, 'tree');
  }
  let stdout: string;
  try {
    stdout = readFileSync(join(launched.handle.dir, 'stdout.log'), 'utf8');
  } catch {
    // Нет файла вывода — CLI не стартовал; это видно по событиям, вывод пуст.
    stdout = '';
  }
  return { seen: tap.seen, marker: readMarker(marker), dir: final.dir, stdout };
}

export const P81_ATTRIBUTION = '11111111-1111-4111-8111-111111111111';

/** Сколько ответов инструментов уже в запросе openai-chat: шаг сценария модели. */
export function toolTurns(raw: string): number {
  return (raw.match(/"role":"tool"/g) ?? []).length;
}
