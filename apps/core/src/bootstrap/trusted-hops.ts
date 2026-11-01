import type { Fact } from '@agentdeck/contracts/core/facts';
import type { Liveness, ProcessIdentity } from '../platform/process-identity.ts';
import type { HopsReply } from '../platform/supervisor-channel.ts';
import type { DevicesNote } from './devices.ts';

/**
 * Набор доверенных звеньев пересылки (P131, 06 §Authority): pid, которым ядро разрешает ставить
 * заголовок `x-agentdeck-peer-pid`. Пишет его только надзор через канал `supervisor-channel`.
 *
 * - `hops.set` ЗАМЕНЯЕТ набор: прежний pid панели после её перезапуска больше не звено, и его
 *   пересланная команда — пир без доверия, строгая команда требует подписи устройства;
 * - pid принимается, только если процесс жив сейчас (его личность — pid + время старта —
 *   запоминается) и не входит в дерево сессии: модель, назвавшая себя звеном, подделала бы
 *   «человека». Неизвестно, из сессии ли он, — отказ, а не допуск;
 * - фоновая сверка выбрасывает pid, чей процесс умер или сменился (номер занял другой процесс).
 *
 * `pids` — живой объект для `PeerDeps.trustedHopPids`: суд пира читает его на каждой команде.
 */

export interface TrustedHopsDeps {
  identityOf(pid: number): Promise<Fact<ProcessIdentity>>;
  isAlive(id: ProcessIdentity): Promise<Liveness>;
  isSessionDescendant(pid: number): Promise<boolean | 'unknown'>;
  note: DevicesNote;
  now(): number;
}

export interface TrustedHops {
  readonly pids: ReadonlySet<number>;
  set(pids: readonly number[]): Promise<HopsReply>;
  /** Для `/v1/health`: сколько звеньев и когда надзор записал их последний раз. */
  view(): { count: number; recordedAt: number | null };
  /** Сверка набора с таблицей процессов; ушедшие звенья выпадают. */
  sweep(): Promise<void>;
}

export function createTrustedHops(deps: TrustedHopsDeps): TrustedHops {
  const pids = new Set<number>();
  const identities = new Map<number, ProcessIdentity>();
  let recordedAt: number | null = null;

  const judge = async (pid: number): Promise<ProcessIdentity | string> => {
    const identity = await deps.identityOf(pid);
    if (!('value' in identity))
      return 'unknown' in identity ? `identity unknown: ${identity.unknown}` : 'no such process';
    const inSession = await deps.isSessionDescendant(pid);
    if (inSession === 'unknown') return 'session membership unknown';
    if (inSession) return 'session descendant';
    return identity.value;
  };

  const replace = async (asked: readonly number[]): Promise<HopsReply> => {
    // Замена целиком и ДО суда: пока новые pid проверяются, прежние уже не звенья — окно,
    // в котором старый pid ещё пересылает, закрыто, даже если ни один новый не пройдёт.
    pids.clear();
    identities.clear();
    const unique = [...new Set(asked)];
    const verdicts = await Promise.all(unique.map(judge));
    const accepted: number[] = [];
    const refused: { pid: number; reason: string }[] = [];
    unique.forEach((pid, i) => {
      const verdict = verdicts[i];
      if (typeof verdict === 'string' || verdict === undefined) {
        refused.push({ pid, reason: verdict ?? 'not judged' });
        return;
      }
      pids.add(pid);
      identities.set(pid, verdict);
      accepted.push(pid);
    });
    recordedAt = deps.now();
    deps.note('hops.set', { accepted, refused });
    return { ok: true, accepted, refused, recordedAt };
  };
  // Два сторожа (dev-watch и keepalive) пишут разом: замены идут по очереди, иначе вторая
  // очистка легла бы между судом и записью первой и набор стал бы их объединением.
  let queue: Promise<unknown> = Promise.resolve();

  return {
    pids,
    set(asked) {
      const next = queue.then(() => replace(asked));
      queue = next.catch(() => undefined);
      return next;
    },
    view: () => ({ count: pids.size, recordedAt }),
    async sweep() {
      for (const [pid, identity] of [...identities]) {
        // `unknown` (таблица не прочитана) звено не снимает: снимок сорвался, а не процесс ушёл.
        if ((await deps.isAlive(identity)) !== 'dead') continue;
        if (identities.get(pid) !== identity) continue;
        pids.delete(pid);
        identities.delete(pid);
        deps.note('hops.gone', { pid });
      }
    },
  };
}
