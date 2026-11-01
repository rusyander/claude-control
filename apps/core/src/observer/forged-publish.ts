import type { Fact } from '@agentdeck/contracts/core/facts';
import type { ForgeActivity, ForgeActivityType } from '@agentdeck/contracts/core/forge';
import {
  FORGED_PUBLISH,
  type ClosureRecord,
  type ForgedEvidence,
} from '@agentdeck/contracts/core/publish';
import { aliasPublishes, CLOSED_PUSH_URL } from '../lib/publish-alias.ts';
import type { SignalDecision } from './observer.types.ts';

/**
 * Суд «публикация мимо ядра» в конце шага сеанса (05 §Push closure, G7, P28/P29/P132). Публикует
 * только ядро; всё, что поменялось снаружи и чего нет в журнале действий, — `forged-publish`, шаг
 * снимается. Три улики (`FORGED_EVIDENCE`):
 *
 * - `remote-sha` — ссылка remote сменилась против базы начала шага, её новый sha достижим из ветки
 *   единицы или её reflog (это работа сеанса), а журнал не знает пуша ТОЙ ЖЕ ссылки с ТЕМ ЖЕ sha.
 *   Чужие ветки (sha не наш) — не наша забота: на remote пушат люди.
 * - `forge-event` — событие форжа нашего аккаунта в окне шага, которому нет действия в журнале;
 *   одобрение и слияние нашим аккаунтом — всегда (ядро их не делает никогда).
 * - `config-drift` — покопийные pushurl/hooksPath, каталог хуков, публикующие алиасы или
 *   переписывание адреса-заглушки разошлись с тем, что ядро записало (`publish.closure`).
 *
 * Факт, который не прочитан, — не «чисто»: без улик сигнал `warn` с именем непрочитанного.
 */

/** Состояние закрытия копии сейчас — те же поля, что `publish.closure`, плюс переписывания адресов. */
export interface ClosureNow {
  pushurls: Record<string, string>;
  hooksPath: string;
  hooksDirFp: string;
  commonAliases: Record<string, string>;
  /** Значения `url.<base>.insteadOf` / `pushInsteadOf` всех слоёв. */
  rewrites: string[];
}

export interface RemoteRefsInput {
  remote: string;
  /** Последняя запись `publish.remote-refs` этого remote; `null` — базы нет. */
  before: Record<string, string> | null;
  after: Fact<Record<string, string>>;
}

/** Ожидаемое событие форжа по действию журнала (вывел вызывающий из `action.started`/`done`). */
export interface JournaledForgeEvent {
  type: ForgeActivityType;
  ref?: string;
  mrIid?: number;
  objectId?: string;
}

export interface ForgedPublishInput {
  /** Единица — тема сигнала. */
  subject: string;
  refs: RemoteRefsInput[];
  /**
   * Достижимость новых sha из ветки единицы или её reflog: sha → да/нет. Спрашиваются только sha
   * сменившихся ссылок; не названный sha — не прочитан.
   */
  unitShas: Fact<Record<string, boolean>>;
  /** Пуши журнала (`action.started` kind `push`) — remote, полная ссылка, sha. */
  journaledPushes: { remote: string; ref: string; sha: string }[];
  /** Последняя запись `publish.closure` копии; `null` — ядро копию не закрывало. */
  closure: ClosureRecord | null;
  closureNow: Fact<ClosureNow>;
  /** Аккаунт ядра на форже; `null` — форжа нет (только `generic`): событий не спрашивали. */
  account: string | null;
  forge: Fact<ForgeActivity[]> | null;
  journaledForge: JournaledForgeEvent[];
  /** Окно шага, мс эпохи: события вне окна — не этого шага. */
  window: { from: number; to: number };
}

const ALWAYS_FORGED: ReadonlySet<ForgeActivityType> = new Set(['approval', 'merge']);

const evidence = (kind: ForgedEvidence, text: string): string => `${kind}: ${text}`;

function remoteShaEvidence(input: ForgedPublishInput, unknown: string[]): string[] {
  const out: string[] = [];
  for (const r of input.refs) {
    if (!('value' in r.after)) {
      unknown.push(`ls-remote ${r.remote}: ${'unknown' in r.after ? r.after.unknown : 'absent'}`);
      continue;
    }
    if (r.before === null) {
      unknown.push(`remote-refs baseline of ${r.remote}: absent`);
      continue;
    }
    for (const [ref, sha] of Object.entries(r.after.value)) {
      if (r.before[ref] === sha) continue;
      const pushed = input.journaledPushes.some(
        (p) => p.remote === r.remote && p.ref === ref && p.sha === sha,
      );
      if (pushed) continue;
      if (!('value' in input.unitShas)) {
        unknown.push(`unit reachability of ${sha.slice(0, 12)}: not read`);
        continue;
      }
      const ours = input.unitShas.value[sha];
      if (ours === undefined) unknown.push(`unit reachability of ${sha.slice(0, 12)}: not asked`);
      else if (ours) out.push(evidence('remote-sha', `${r.remote} ${ref} → ${sha.slice(0, 12)}`));
    }
  }
  return out;
}

function matchesJournal(event: ForgeActivity, journaled: readonly JournaledForgeEvent[]): boolean {
  return journaled.some((j) => {
    if (j.type !== event.type) return false;
    if (j.objectId !== undefined && event.objectId !== undefined)
      return j.objectId === event.objectId;
    if (j.ref !== undefined && event.ref !== undefined) return j.ref === event.ref;
    if (j.mrIid !== undefined && event.mrIid !== undefined) return j.mrIid === event.mrIid;
    return false;
  });
}

function forgeEvidence(input: ForgedPublishInput, unknown: string[]): string[] {
  if (input.forge === null || input.account === null) return [];
  if (!('value' in input.forge)) {
    unknown.push(`forge activity: ${'unknown' in input.forge ? input.forge.unknown : 'absent'}`);
    return [];
  }
  const out: string[] = [];
  for (const event of input.forge.value) {
    if (event.author !== input.account) continue;
    if (event.at < input.window.from || event.at > input.window.to) continue;
    if (!ALWAYS_FORGED.has(event.type) && matchesJournal(event, input.journaledForge)) continue;
    const where = event.ref ?? (event.mrIid !== undefined ? `!${event.mrIid}` : event.id);
    out.push(evidence('forge-event', `${event.type} ${where} by ${event.author}`));
  }
  return out;
}

/** Переписывание `insteadOf`, чьё значение — начало адреса-заглушки, уводит закрытый push наружу. */
const rewritesClosed = (value: string): boolean =>
  value !== '' && CLOSED_PUSH_URL.startsWith(value);

function driftEvidence(input: ForgedPublishInput, unknown: string[]): string[] {
  const rec = input.closure;
  if (rec === null) return [];
  if (!('value' in input.closureNow)) {
    const why = 'unknown' in input.closureNow ? input.closureNow.unknown : 'absent';
    unknown.push(`copy closure state: ${why}`);
    return [];
  }
  const now = input.closureNow.value;
  const out: string[] = [];
  const remotes = new Set([...Object.keys(rec.pushurls), ...Object.keys(now.pushurls)]);
  for (const remote of [...remotes].sort()) {
    if (rec.pushurls[remote] !== now.pushurls[remote])
      out.push(evidence('config-drift', `remote.${remote}.pushurl`));
  }
  if (rec.hooksPath !== now.hooksPath) out.push(evidence('config-drift', 'core.hooksPath'));
  if (rec.hooksDirFp !== now.hooksDirFp) out.push(evidence('config-drift', 'core hooks dir'));
  for (const [name, value] of Object.entries(now.commonAliases).sort()) {
    if (rec.commonAliases[name] === value) continue;
    if (aliasPublishes(value, now.commonAliases))
      out.push(evidence('config-drift', `alias.${name}`));
  }
  for (const value of now.rewrites) {
    if (rewritesClosed(value)) out.push(evidence('config-drift', `insteadOf ${value}`));
  }
  return out;
}

/** Решение класса `forged-publish`: сигнал наблюдателя со своим классом — один судья на класс (P01). */
export type ForgedPublishDecision = SignalDecision & { signal: typeof FORGED_PUBLISH };

export function judgeForgedPublish(input: ForgedPublishInput): ForgedPublishDecision {
  const unknown: string[] = [];
  const found = [
    ...remoteShaEvidence(input, unknown),
    ...forgeEvidence(input, unknown),
    ...driftEvidence(input, unknown),
  ];
  if (found.length > 0)
    return {
      fired: true,
      signal: FORGED_PUBLISH,
      severity: 'stop',
      action: 'stop-step',
      subject: input.subject,
      detail: `published outside the core: ${found.join('; ')}`,
      reasons: [...found, ...unknown.map((u) => `unread: ${u}`)],
    };
  if (unknown.length > 0)
    return {
      fired: true,
      signal: FORGED_PUBLISH,
      severity: 'warn',
      action: 'show',
      subject: input.subject,
      detail: `not checked: ${unknown.join('; ')}`,
      reasons: unknown.map((u) => `unread: ${u}`),
    };
  return {
    fired: false,
    signal: FORGED_PUBLISH,
    severity: 'stop',
    action: 'stop-step',
    subject: input.subject,
    detail: '',
    reasons: ['remote refs, forge events and the copy closure match the journal'],
  };
}
