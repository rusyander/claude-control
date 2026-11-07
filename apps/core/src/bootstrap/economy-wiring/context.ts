import { join } from 'node:path';
import type { Fact } from '@agentdeck/contracts/core/facts';
import { startStubModel } from '@agentdeck/stub-model';
import type {
  AdapterChannelSummary,
  AdapterEvent,
  CliAdapter,
  SessionSpec,
} from '../../adapters/adapter.types.ts';
import type { Dialect } from '@agentdeck/contracts/core/routes';
import {
  BriefOverBudget,
  buildBrief,
  type BriefPart,
  type SentSection,
} from '../../context/brief/index.ts';
import {
  baseContext,
  driftOf,
  forgetBase,
  type BaseCacheFile,
  type BaseDeps,
  type BaseKey,
  type BaseOutcome,
  type ProbeTrace,
} from '../../context/base/index.ts';
import { reviewPack, type ReviewPackInput } from '../../context/review-pack/index.ts';
import { deltaOf, type SentForm } from '../../context/sent/index.ts';
import type { SessionBinding } from '../../conductor/model-tools/model-tools.types.ts';
import { sentOf as foldSentOf } from '../../journal/reduce/fold-view.ts';
import type { LiveTask } from '../../journal/resume.ts';
import { writeFileAtomic } from '../../platform/safe-io/atomic-write.ts';
import { readTextFact } from '../../platform/safe-io/files.ts';

/**
 * Проводка контекста этапа 5 (зона C): первое сообщение сессии — бриф или дельта по набору
 * отданного из свёртки (`sent[sessionId]`), пакет ревью, замер базы (G9) и дрейф первого хода.
 * Каждая отправка пишет `brief.sent` — по нему свёртка ведёт набор отданного, и та же секция в
 * этой сессии второй раз не уходит (P13). Замер базы пишет `context.base` один раз на задачу и
 * ключ. W подключает это к дороге сессии; сборка брифа сверх бюджета бросает `BriefOverBudget` —
 * W превращает его в отказ шага, называя корзины.
 */

export interface Opening {
  form: SentForm;
  text: string;
  sections: SentSection[];
}

export interface ContextWiringDeps {
  /** Корень дома ядра: кэш замеров базы — `<root>/cache/base-context.json`. */
  homeRoot: string;
  now?: () => number;
}

export interface ContextWiring {
  /** Бриф (сессия ещё ничего не получала) или дельта; `null` — всё уже у модели. */
  opening(
    task: LiveTask,
    sessionId: string,
    parts: readonly BriefPart[],
    stepKind: string,
    known?: readonly string[],
  ): Opening | null;
  /**
   * Отказ брифа до запуска сессии (`RunEconomy.briefRefusal`): текст `BriefOverBudget` с
   * корзинами; `null` — бриф в бюджете. Ничего не пишет: шаг ещё не начал сессию.
   */
  refusal(parts: readonly BriefPart[], stepKind: string): string | null;
  /** Пакет ревью: в той же сессии — только изменённые его секции; `null` — пакет уже у модели. */
  pack(task: LiveTask, sessionId: string, input: ReviewPackInput): Opening | null;
  /** Замер базы по ключу (кэш или проба); новый для задачи ключ — строка `context.base`. */
  base(task: LiveTask, key: BaseKey, probe: BaseDeps['probe']): Promise<BaseOutcome>;
  /** Ожидание первого хода сессии: база + бриф — для дрейфа. */
  expect(sessionId: string, key: BaseKey, baseTokens: number, briefBytes: number): void;
  /**
   * Две половины ожидания с разных мест: замер базы на старте сессии (`arm`, исполнитель — в
   * фоне, запуск он не задерживает) и байты первого слова (`sent`, экономика). Ожидание ставится,
   * когда есть обе; первый ход прошёл раньше — ставить нечего, второй ход несёт разговор.
   */
  arm(sessionId: string, key: BaseKey, baseTokens: number): void;
  sent(sessionId: string, briefBytes: number): void;
  /** Кран потока сессии: первый `usage` сессии сверяется с ожиданием. */
  onEvent(task: LiveTask, binding: SessionBinding, event: AdapterEvent): void;
}

const sentOf = (task: LiveTask, sessionId: string): Readonly<Record<string, string>> =>
  foldSentOf(task.state, sessionId);

function journalSent(task: LiveTask, sessionId: string, opening: Opening): void {
  task.append({
    kind: 'brief.sent',
    actor: 'core',
    data: { sessionId, form: opening.form, sections: opening.sections },
  });
}

export function baseCacheDeps(homeRoot: string): Pick<BaseDeps, 'read' | 'write'> {
  const file = join(homeRoot, 'cache', 'base-context.json');
  return {
    async read(): Promise<Fact<BaseCacheFile>> {
      const got = await readTextFact(file);
      if (!('value' in got)) return got;
      try {
        const parsed = JSON.parse(got.value) as BaseCacheFile;
        if (parsed.version !== 1 || typeof parsed.bases !== 'object')
          return { unknown: 'garbage: base cache shape' };
        return { value: parsed };
      } catch (error) {
        return { unknown: `garbage: ${String(error)}` };
      }
    },
    async write(next) {
      writeFileAtomic(file, `${JSON.stringify(next, null, 2)}\n`);
    },
  };
}

export function createContextWiring(deps: ContextWiringDeps): ContextWiring {
  const cache = baseCacheDeps(deps.homeRoot);
  const expected = new Map<string, { key: BaseKey; baseTokens: number; briefBytes: number }>();
  const halves = new Map<string, { key?: BaseKey; baseTokens?: number; briefBytes?: number }>();
  // Сессии, чей первый ход уже прошёл без ожидания: поздний замер их не судит.
  const firstSeen = new Set<string>();
  const join2 = (
    sessionId: string,
    half: { key?: BaseKey; baseTokens?: number; briefBytes?: number },
  ): void => {
    if (firstSeen.has(sessionId)) return;
    const got = { ...halves.get(sessionId), ...half };
    if (got.key && got.baseTokens !== undefined && got.briefBytes !== undefined) {
      halves.delete(sessionId);
      expected.set(sessionId, {
        key: got.key,
        baseTokens: got.baseTokens,
        briefBytes: got.briefBytes,
      });
    } else halves.set(sessionId, got);
  };
  return {
    opening(task, sessionId, parts, stepKind, known = []) {
      const sent = sentOf(task, sessionId);
      let opening: Opening | null;
      if (Object.keys(sent).length === 0) {
        const brief = buildBrief(parts, stepKind, known);
        opening = {
          form: 'brief',
          text: brief.text,
          sections: brief.placed.map(({ id, sha256, bytes }) => ({ id, sha256, bytes })),
        };
      } else {
        const delta = deltaOf(sent, parts, stepKind, known);
        opening = delta ? { form: 'delta', text: delta.text, sections: delta.sections } : null;
      }
      if (opening && opening.sections.length > 0) journalSent(task, sessionId, opening);
      return opening;
    },

    refusal(parts, stepKind) {
      try {
        buildBrief(parts, stepKind);
        return null;
      } catch (error) {
        if (error instanceof BriefOverBudget) return error.message;
        throw error;
      }
    },

    pack(task, sessionId, input) {
      const sent = sentOf(task, sessionId);
      const built = reviewPack(input);
      const fresh = built.blocks
        .map((b, i) => ({ block: b, section: built.sections[i]! }))
        .filter(({ section }) => sent[section.id] !== section.sha256);
      if (fresh.length === 0) return null;
      const opening: Opening = {
        form: 'review-pack',
        text: fresh.map((f) => f.block.text).join('\n\n'),
        sections: fresh.map((f) => f.section),
      };
      journalSent(task, sessionId, opening);
      return opening;
    },

    async base(task, key, probe) {
      const got = await baseContext(key, { ...cache, probe, now: deps.now });
      if (!got.ok) return got;
      const seen = task.state.bases.some(
        (b) =>
          b.adapter === key.adapter &&
          b.cliVersion === key.cliVersion &&
          b.stepKind === key.stepKind &&
          b.layerHash === key.layerHash &&
          b.mcpHash === key.mcpHash,
      );
      if (!seen) task.append({ kind: 'context.base', actor: 'core', data: got.base });
      return got;
    },

    expect(sessionId, key, baseTokens, briefBytes) {
      expected.set(sessionId, { key, baseTokens, briefBytes });
    },

    arm(sessionId, key, baseTokens) {
      join2(sessionId, { key, baseTokens });
    },

    sent(sessionId, briefBytes) {
      join2(sessionId, { briefBytes });
    },

    onEvent(task, binding, event) {
      if (event.type !== 'usage') return;
      const want = expected.get(binding.sessionId);
      if (!want) {
        firstSeen.add(binding.sessionId);
        halves.delete(binding.sessionId);
        return;
      }
      // Только первый ход: дальше вход растёт разговором, база тут ни при чём.
      expected.delete(binding.sessionId);
      const actual = event.input + event.cacheRead + event.cacheWrite;
      const drift = driftOf({ tokens: want.baseTokens }, want.briefBytes, actual);
      if (!drift.over) return;
      task.append({
        kind: 'signal',
        actor: 'core',
        data: {
          signal: 'context-drift',
          severity: 'warn',
          subject: binding.sessionId,
          detail: `turn-1 input ${actual} tokens vs base + brief ${drift.expected} (${Math.round(drift.ratio * 100)} %); base re-measured on next start`,
        },
      });
      // Кран не бросает: неудача записи кэша — замер останется до следующего дрейфа.
      void forgetBase(want.key, cache).catch(() => undefined);
    },
  };
}

/**
 * Проба базы на заглушке модели (G9): тот же сеанс, что собрала дорога (вид шага, слой, MCP,
 * инструменты, системная часть), но адрес — заглушка на петле; один ход, где первое сообщение —
 * метка вместо брифа. База = тело первого запроса минус метка. Канал и диалект привязки — те, что у
 * маршрута сеанса (`bindEndpoint` переходника), их называет W.
 */
export async function probeOnStub(
  adapter: CliAdapter,
  spec: SessionSpec,
  bind: { channel: AdapterChannelSummary; dialect: Dialect },
  timeoutMs = 120_000,
  signal?: AbortSignal,
): Promise<ProbeTrace> {
  if (signal?.aborted) throw new Error('probe: aborted before start');
  // Проба — не разговор человека: CLI, который сохранил бы её в своём хранилище, не замеряется —
  // иначе панель показывает строку «AGENTDECK_BASE_PROBE <id>» в списке чатов.
  if (!adapter.ephemeral) throw new Error(`probe: ${adapter.id} cannot run a traceless session`);
  const stub = await startStubModel({ script: () => 'ok' });
  const brief = `AGENTDECK_BASE_PROBE ${spec.sessionId}`;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const launched = await adapter.launch({
      ...spec,
      ephemeral: true,
      endpoint: {
        channel: bind.channel,
        endpoint: {
          baseUrl: stub.baseUrl,
          dialect: bind.dialect,
          model: 'stub-model',
          key: 'base-probe',
        },
      },
    });
    if (!launched.ok) throw new Error(`probe launch refused: ${launched.reason}`);
    // Остановка ядра: проба снимается деревом, не мягко — её ход дожидаться некому.
    let stopMode: 'soft' | 'tree' = 'soft';
    let onAbort: (() => void) | undefined;
    try {
      await adapter.send(launched.handle, brief, `probe-${spec.sessionId}`);
      const ended = (async () => {
        for await (const event of adapter.events(launched.handle))
          if (event.type === 'turn.ended') return;
        throw new Error('probe: stream ended before the turn did');
      })();
      // Срок или остановка выиграли гонку: поток кончится при снятии CLI — не необработанный отказ.
      ended.catch(() => undefined);
      const late = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`probe: no turn end in ${timeoutMs} ms`)),
          timeoutMs,
        );
      });
      const aborted = new Promise<never>((_, reject) => {
        onAbort = () => {
          stopMode = 'tree';
          reject(new Error('probe: aborted (core stopping)'));
        };
        if (signal?.aborted) onAbort();
        else signal?.addEventListener('abort', onAbort, { once: true });
      });
      await Promise.race([ended, late, aborted]);
    } finally {
      if (onAbort) signal?.removeEventListener('abort', onAbort);
      await adapter.stop(launched.handle, stopMode);
    }
    return { bodies: [...stub.bodies], brief };
  } finally {
    clearTimeout(timer);
    await stub.close();
  }
}
