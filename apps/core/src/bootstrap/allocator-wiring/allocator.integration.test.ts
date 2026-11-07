import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import type { JournalLine } from '@agentdeck/contracts/core/journal';
import { claudeRunFacts } from '@agentdeck/providers/claude';
import { stopSession } from '../../adapters/launcher/session-io.ts';
import { tempDir } from '../../journal/__fixtures__/journal-harness.ts';
import { readJournalLines } from '../../journal/read-lines.ts';
import { CORE_HOME_ENV, layoutOf } from '../../platform/core-home.ts';
import { stopLeaseServers } from '../../routes/local/own/__fixtures__/lease-sweep.ts';
import { readSeats, seatsDirOf } from '../../verifier/queue/session.ts';
import type { SeatFile } from '../../verifier/queue/session.types.ts';
import { loginRoute } from '../__fixtures__/road-start.ts';
import type { AllocatorChild } from './__fixtures__/allocator-child.ts';
import { MACHINE_DIR_ENV } from './machine.ts';

/**
 * Распределитель мест машины на НАСТОЯЩИХ ядрах (этап 11, P141-P142): два процесса ядра, каждый на
 * своём одноразовом доме, делят один каталог машины (`AGENTDECK_CORE_MACHINE`, временный). Каждое
 * ведёт задачу из трёх единиц исполнителем продукта — копия, шаг, сеанс дорогой ядра; CLI
 * подставной (запись живого Claude), его дом одноразовый. Счёт — по журналам задач и файлам мест.
 * Два ядра в одном процессе одну очередь не делят: своё место ядро узнаёт по pid и старту процесса.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const CHILD = join(HERE, '__fixtures__', 'allocator-child.ts');
const BEAT_MS = 400;
const ROUTE = loginRoute(claudeRunFacts.id);

interface Core {
  name: string;
  home: string;
  notes: string;
  child: ChildProcess;
  stderr: () => string;
}

const cores: Core[] = [];
const machines: string[] = [];
/** Корни своей модели (`local:own`): серверы аренд переживают ядро — их снимает тест. */
const owns: string[] = [];

afterAll(async () => {
  for (const c of cores) {
    writeFileSync(join(c.home, '..', 'stop'), '');
  }
  for (const c of cores) await exited(c, 30_000).catch(() => c.child.kill('SIGKILL'));
  // Сеансы переживают остановку ядра — их дерево снимает тест.
  for (const c of cores)
    for (const dir of sessionDirs(c.home)) await stopSession(dir, 'tree').catch(() => undefined);
  for (const c of cores)
    for (const n of notesOf(c))
      if (n.event === 'boot' && typeof n.cliRoot === 'string')
        rmSync(n.cliRoot, { recursive: true, force: true });
  for (const o of owns) await stopLeaseServers(o).catch(() => undefined);
  for (const m of [...machines, ...owns]) rmSync(m, { recursive: true, force: true });
}, 120_000);

function git(cwd: string, args: string[]): void {
  const run = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  if (run.status !== 0) throw new Error(`git ${args.join(' ')}: ${run.stderr}`);
}

function sourceRepo(): string {
  const repo = join(tempDir('alloc-repo-'), 'src');
  mkdirSync(repo, { recursive: true });
  git(repo, ['init', '--quiet', '--initial-branch', 'main']);
  git(repo, ['config', 'user.name', 'alloc-test']);
  git(repo, ['config', 'user.email', 'alloc@example.invalid']);
  git(repo, ['config', 'core.autocrlf', 'false']);
  writeFileSync(join(repo, 'README.md'), 'alloc\n');
  git(repo, ['add', '.']);
  git(repo, ['commit', '--quiet', '-m', 'init']);
  return repo;
}

function machineDir(): string {
  const dir = tempDir('alloc-machine-');
  machines.push(dir);
  return dir;
}

function startCore(
  name: string,
  machine: string,
  cfg: Omit<AllocatorChild, 'home' | 'notes'>,
  /** Дом прежнего ядра: перезапуск на том же доме (каталог `stop` тест убирает сам). */
  again?: string,
): Core {
  const root = again ?? tempDir(`alloc-${name}-`);
  const home = join(root, 'core');
  const notes = join(root, 'notes.jsonl');
  const launch: AllocatorChild = { ...cfg, home, notes };
  const child = spawn(
    process.execPath,
    [
      '--experimental-strip-types',
      '--no-warnings',
      CHILD,
      Buffer.from(JSON.stringify(launch)).toString('base64url'),
    ],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      // Дом ядра — свой у каждого процесса (как у двух сборок на машине), каталог машины — общий.
      env: { ...process.env, [CORE_HOME_ENV]: home, [MACHINE_DIR_ENV]: machine },
    },
  );
  let stderr = '';
  child.stderr?.setEncoding('utf8').on('data', (c: string) => (stderr += c));
  child.stdout?.resume();
  const core = { name, home, notes, child, stderr: () => stderr };
  cores.push(core);
  return core;
}

function exited(c: Core, ms: number): Promise<void> {
  if (c.child.exitCode !== null || c.child.signalCode !== null) return Promise.resolve();
  return new Promise((done, fail) => {
    const timer = setTimeout(() => fail(new Error(`${c.name} did not exit`)), ms);
    c.child.once('exit', () => {
      clearTimeout(timer);
      done();
    });
  });
}

const jsonLines = (file: string): Record<string, unknown>[] =>
  existsSync(file)
    ? readFileSync(file, 'utf8')
        .split('\n')
        .filter((l) => l.trim() !== '')
        .map((l) => JSON.parse(l) as Record<string, unknown>)
    : [];
const notesOf = (c: Core) => jsonLines(c.notes);
const coreLog = (c: Core) => jsonLines(join(layoutOf(c.home).logs, 'core.jsonl'));

function taskIds(home: string): string[] {
  const dir = layoutOf(home).tasks;
  return existsSync(dir)
    ? readdirSync(dir).filter((n) => existsSync(join(dir, n, 'journal.jsonl')))
    : [];
}
const journal = (home: string, taskId: string): JournalLine[] =>
  readJournalLines(join(layoutOf(home).tasks, taskId), taskId).lines as JournalLine[];

function sessionDirs(home: string): string[] {
  const out: string[] = [];
  for (const id of taskIds(home)) {
    const dir = join(layoutOf(home).tasks, id, 'sessions');
    if (existsSync(dir)) for (const s of readdirSync(dir)) out.push(join(dir, s));
  }
  return out;
}

interface Span {
  core: string;
  taskId: string;
  sessionId: string;
  hostPid: number;
  from: number;
  to: number | null;
}

/** Задачи-чаты ядра (заметка `chat` ребёнка). */
const chatIds = (c: Core): Set<string> =>
  new Set(notesOf(c).flatMap((n) => (n.event === 'chat' ? [n.taskId as string] : [])));

/** Сеансы по журналам задач ядер: начало и конец (`ended`/`lost`); `which` — шаги, чаты или все. */
function spans(list: readonly Core[], which: 'steps' | 'chats' | 'all' = 'steps'): Span[] {
  const out: Span[] = [];
  for (const c of list)
    for (const taskId of taskIds(c.home)) {
      const chat = chatIds(c).has(taskId);
      if ((which === 'steps' && chat) || (which === 'chats' && !chat)) continue;
      const lines = journal(c.home, taskId);
      for (const l of lines) {
        if (l.kind !== 'session.started') continue;
        const end = lines.find(
          (e) =>
            e.kind === 'session.transition' &&
            e.sessionId === l.sessionId &&
            ['ended', 'lost'].includes((e.data as { to: string }).to),
        );
        out.push({
          core: c.name,
          taskId,
          sessionId: l.sessionId!,
          hostPid: (l.data as { hostPid: number }).hostPid,
          from: l.at,
          to: end?.at ?? null,
        });
      }
    }
  return out;
}

/** Наибольшее число одновременно открытых сеансов. */
function maxOverlap(all: readonly Span[]): number {
  const edges = all.flatMap((s) => [
    { at: s.from, d: 1 },
    ...(s.to === null ? [] : [{ at: s.to, d: -1 }]),
  ]);
  // Конец раньше начала в тот же миг: освобождённое место отдано следующему.
  edges.sort((a, b) => a.at - b.at || a.d - b.d);
  let now = 0;
  let max = 0;
  for (const e of edges) {
    now += e.d;
    max = Math.max(max, now);
  }
  return max;
}

/**
 * Сеанс с убитым хостом кончился не позже, чем его место ушло дальше: место возвращается только по
 * доказанной смерти хоста и CLI (`judgesOf`, тест следит за этим сам), а строку `lost` ядро пишет
 * по сверке хостов — до `hostCheckMs` (5 с) позже. Конец по журналу завышал жизнь сеанса: ждущий,
 * открывшийся в этом окне, давал пятый «одновременный» сеанс при четырёх местах (6 из 64 прогонов).
 */
const endedBy = (all: readonly Span[], sessionId: string, at: number): Span[] =>
  all.map((s) =>
    s.sessionId === sessionId && (s.to === null || s.to > at) ? { ...s, to: at } : s,
  );

/** Живой ли pid (сигнал 0): CLI сеанса после смерти хоста. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const seatsOf = (machine: string): SeatFile[] => {
  const got = readSeats(seatsDirOf(join(machine, 'queue')));
  return 'value' in got ? got.value : [];
};

async function until<T>(probe: () => T | undefined, what: string, ms = 120_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timeout: ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Что видно при отказе: записи ядер, хвост stderr и места машины. */
function context(list: readonly Core[], machine: string): string {
  const lines = list.map((c) => {
    const log = coreLog(c)
      .filter((e) => /seat|allocator|loop\.|error|refus/.test(String(e.event)))
      .slice(-15)
      .map((e) => JSON.stringify(e).slice(0, 300));
    return `${c.name}: notes ${JSON.stringify(notesOf(c)).slice(0, 600)}\nlog:\n${log.join('\n')}\nstderr: ${c.stderr().slice(-800)}`;
  });
  const seats = seatsOf(machine).map(
    (s) =>
      `${s.ticket.taskId.slice(-6)}/${s.stepId.slice(-6)} held=${s.ticket.holder !== null} core=${s.core.pid}`,
  );
  return `${lines.join('\n---\n')}\nseats: ${seats.join('; ')}`;
}

/** Хвосты журналов задач: строки шагов, сеансов и решений — причина отказа видна в сообщении. */
function tails(list: readonly Core[]): string {
  return list
    .flatMap((c) =>
      taskIds(c.home).map((id) => {
        const rows = journal(c.home, id)
          .filter((l) => /^(step|session|decision|unit)/.test(l.kind))
          .slice(-30)
          .map((l) => `${l.kind} ${JSON.stringify(l.data).slice(0, 220)}`);
        return `${c.name}/${id.slice(-6)}:\n${rows.join('\n')}`;
      }),
    )
    .join('\n');
}

describe('machine allocator across two real cores (P141-P142)', () => {
  it('2 tasks × 3 units under balanced: never more than 4 sessions; the waiter names its holder; a dead host hands its seat on; a dead core with live hosts is not reaped or adopted', async () => {
    const machine = machineDir();
    const config = { queue: { beatMs: BEAT_MS } };
    // Свой исходный репозиторий у каждого ядра: копии двух процессов в одном `.git` спорят за
    // замок его config (git 255), а проверка — про места, не про общий репозиторий.
    // CLI доделывает ход после смерти хоста (60 с): на Windows его снимает задание libuv хоста, на
    // POSIX он в своей группе и живёт, пока наблюдатель не снимет дерево — место ждёт и его.
    const outliveHostMs = 60_000;
    const a = startCore('a', machine, {
      repo: sourceRepo(),
      tasks: 1,
      units: 3,
      config,
      outliveHostMs,
    });
    const b = startCore('b', machine, {
      repo: sourceRepo(),
      tasks: 1,
      units: 3,
      config,
      outliveHostMs,
    });
    const both = [a, b];

    // Шаги задачи стартуют по очереди (копия, сеанс): ждём, пока попросят места все шесть единиц.
    const waitingSeats = () => seatsOf(machine).filter((s) => s.ticket.holder === null).length;
    await until(
      () => (spans(both).length >= 4 && waitingSeats() >= 2 ? true : undefined),
      'four sessions open, two steps wait for a seat',
    ).catch((e: unknown) => {
      throw new Error(`${String(e)}\n${context(both, machine)}`);
    });
    // Двенадцать ударов: пятый сеанс не открывается, пока все четыре живы.
    await pause(12 * BEAT_MS);
    const settled = spans(both);
    expect(settled.length, context(both, machine)).toBe(4);
    expect(
      settled.filter((s) => s.to !== null),
      `${JSON.stringify(settled)}\n${tails(both)}\n${context(both, machine)}`,
    ).toEqual([]);
    expect(maxOverlap(settled)).toBe(4);
    const seats = seatsOf(machine);
    expect(seats.filter((s) => s.ticket.holder !== null)).toHaveLength(4);
    expect(seats.filter((s) => s.ticket.holder === null)).toHaveLength(2);
    // Места делят задачи обоих ядер: у каждого ядра есть хотя бы одно своё.
    expect(new Set(seats.map((s) => s.core.pid)).size).toBe(2);
    // Держатель места — хост И CLI сеанса, та же личность, что в `session.started` журнала.
    const cliOf = (s: Span) => {
      const c = both.find((x) => x.name === s.core)!;
      const d = journal(c.home, s.taskId).find(
        (l) => l.kind === 'session.started' && l.sessionId === s.sessionId,
      )!.data as { cliPid: number | null; cliStart: string | null };
      return d.cliPid === null || d.cliStart === null ? null : { pid: d.cliPid, start: d.cliStart };
    };
    for (const s of settled) {
      const seat = seats.find((x) => x.ticket.holder?.sessionId === s.sessionId);
      expect(cliOf(s), 'the CLI identity is journaled').not.toBeNull();
      expect(seat?.ticket.holder?.cli, JSON.stringify(seat)).toEqual(cliOf(s));
    }

    // Ждущий шаг пишет решение `schedule` с держателем: задача и сеанс, за которым он ждёт.
    const waits = both.flatMap((c) =>
      taskIds(c.home).flatMap((id) =>
        journal(c.home, id).filter(
          (l) =>
            l.kind === 'decision' &&
            (l.data as unknown as { class: string }).class === 'schedule' &&
            ((l.data as unknown as { output: { grant?: string[] } }).output.grant ?? []).length ===
              0,
        ),
      ),
    );
    expect(waits.length).toBeGreaterThanOrEqual(2);
    // Замок выдачи у соседнего ядра (проба живости под нагрузкой дольше восьми повторов) — честное
    // ожидание `contended: …` без держателя; следом шаг просит снова и ждёт уже места (`slot`).
    const outs = waits.map(
      (w) => (w.data as unknown as { output: Record<string, unknown> }).output,
    );
    const reasons = outs.map((o) => String(o.reason));
    expect(
      reasons.filter((r) => r !== 'slot' && !r.startsWith('contended:')),
      JSON.stringify(reasons),
    ).toEqual([]);
    const out = outs.find((o) => o.reason === 'slot');
    expect(out, JSON.stringify(reasons)).toBeDefined();
    const holder = out!.holder as { taskId: string; sessionId: string | null };
    const heldTasks = new Set(settled.map((s) => s.taskId));
    expect(heldTasks.has(holder.taskId)).toBe(true);

    // Хост сеанса умер: место возвращается, ждущий открывает сеанс; одновременно — не больше 4.
    const victim = settled[0]!;
    // Миг ухода CLI и миг ухода места — снаружи, частым опросом: место не уходит раньше CLI.
    const victimCli = cliOf(victim)!;
    const gone: { cli: number | null; seat: number | null } = { cli: null, seat: null };
    const watch = setInterval(() => {
      const t = Date.now();
      if (gone.cli === null && !pidAlive(victimCli.pid)) gone.cli = t;
      const all = readSeats(seatsDirOf(join(machine, 'queue')));
      // Нечитаемый каталог — не «места нет».
      if (
        gone.seat === null &&
        'value' in all &&
        !all.value.some((s) => s.ticket.holder?.sessionId === victim.sessionId)
      )
        gone.seat = t;
    }, 20);
    const killedAt = Date.now();
    process.kill(victim.hostPid);
    await until(
      () => (spans(both).length >= 5 ? true : undefined),
      'the waiter opens a session after the host died',
      60_000,
    ).catch((e: unknown) => {
      clearInterval(watch);
      throw new Error(`${String(e)}\n${context(both, machine)}`);
    });
    await pause(8 * BEAT_MS);
    clearInterval(watch);
    const after = spans(both);
    expect(after.length, context(both, machine)).toBe(5);
    // CLI убитого хоста ушёл раньше его места (или в тот же опрос): пятый сеанс не встал рядом с ним.
    expect(gone.cli, JSON.stringify({ killedAt, gone })).not.toBeNull();
    expect(gone.seat, JSON.stringify({ killedAt, gone })).not.toBeNull();
    expect(gone.cli!, JSON.stringify({ killedAt, gone })).toBeLessThanOrEqual(gone.seat!);
    // Место вернулось ровно один раз: ударом ядра-владельца (три пропущенных удара + доказанная
    // смерть хоста) или концом сеанса, который ядро пишет по сверке хостов (`host-dead → lost`).
    const owner = both.find((c) => c.name === victim.core)!;
    const victimStep = journal(owner.home, victim.taskId).find(
      (l) => l.kind === 'session.started' && l.sessionId === victim.sessionId,
    )!.stepId;
    const freed = coreLog(owner).filter(
      (e) =>
        (e.event === 'seat.reaped' &&
          e.taskId === victim.taskId &&
          e.holderPid === victim.hostPid) ||
        (e.event === 'seat.released' && e.taskId === victim.taskId && e.stepId === victimStep),
    );
    expect(freed, JSON.stringify(freed)).toHaveLength(1);
    // Конец сеанса с убитым хостом записан в журнал (не позже окна сверки хостов, 5 с).
    const victimSpan = after.find((s) => s.sessionId === victim.sessionId)!;
    expect(victimSpan.to, tails([owner])).not.toBeNull();
    expect(victimSpan.to! - killedAt).toBeLessThan(15_000);
    // Пятый сеанс считается от выдачи места, а не от строки `lost` (`endedBy`).
    const handedOn = freed[0]!.at as number;
    expect(
      maxOverlap(endedBy(after, victim.sessionId, handedOn)),
      JSON.stringify({ killedAt, gone, freed, after }),
    ).toBe(4);

    // Ядро A убито, его хосты живы (F25): места его сеансов держатся, никто их не снимает и не
    // перенимает. Третье ядро просит место — ждёт и видит молчащие живые места A.
    const aSeats = seatsOf(machine).filter((s) => s.core.pid === a.child.pid);
    const aHeld = aSeats.filter((s) => s.ticket.holder?.sessionId != null);
    expect(aHeld.length, context(both, machine)).toBeGreaterThan(0);
    a.child.kill('SIGKILL');
    await exited(a, 10_000);
    await pause(4 * BEAT_MS);
    const c = startCore('c', machine, { repo: sourceRepo(), tasks: 1, units: 1, config });
    await until(
      () =>
        coreLog(c).some(
          (e) => e.event === 'seat.silent-alive' && aHeld.some((s) => s.ticket.taskId === e.taskId),
        )
          ? true
          : undefined,
      'core c sees the seats of dead core a as silent-alive',
      90_000,
    ).catch((e: unknown) => {
      throw new Error(`${String(e)}\n${context([b, c], machine)}`);
    });
    await pause(8 * BEAT_MS);
    const still = seatsOf(machine);
    for (const s of aHeld) {
      const now = still.find((x) => x.ticket.ticketId === s.ticket.ticketId);
      expect(now?.core.pid, 'no core adopts a foreign step').toBe(a.child.pid);
    }
    // Снять можно только место без сеанса (его судья — само мёртвое ядро A); место с живым хостом — никогда.
    const reaped = [b, c].flatMap((x) => coreLog(x).filter((e) => e.event === 'seat.reaped'));
    for (const r of reaped) expect(aHeld.map((s) => s.ticket.ticketId)).not.toContain(r.ticketId);
    for (const r of coreLog(c).filter((e) => e.event === 'seat.reaped'))
      expect(r.holderPid).toBe(a.child.pid);
    expect(coreLog(b).some((e) => e.event === 'seat.adopted')).toBe(false);
    expect(spans([c])).toEqual([]);
    expect(maxOverlap(endedBy(spans([a, b, c]), victim.sessionId, handedOn))).toBeLessThanOrEqual(
      4,
    );
  }, 420_000);

  it('a 92 % window fact seen by core A holds work of core B on the same route: B opens no session, its health shows the route held', async () => {
    const machine = machineDir();
    const repo = sourceRepo();
    const config = { queue: { beatMs: BEAT_MS } };
    const a = startCore('wa', machine, {
      repo,
      tasks: 0,
      units: 0,
      config,
      inject: {
        routeId: ROUTE,
        limitKind: 'window',
        usedPct: 92,
        resetAt: Date.now() + 30 * 60_000,
        refusal: false,
        source: 'cli-event',
        at: 0,
      },
    });
    await until(
      () => (notesOf(a).some((n) => n.event === 'injected') ? true : undefined),
      'core a injected the window fact',
    ).catch((e: unknown) => {
      throw new Error(`${String(e)}\n${context([a], machine)}`);
    });
    const b = startCore('wb', machine, { repo, tasks: 1, units: 1, config });
    const taskId = await until(
      () => notesOf(b).find((n) => n.event === 'task')?.taskId as string | undefined,
      'core b launched its task',
    ).catch((e: unknown) => {
      throw new Error(`${String(e)}\n${context([a, b], machine)}`);
    });
    const step = await until(
      () => journal(b.home, taskId).find((l) => l.kind === 'step.started'),
      'core b started the step',
    );
    await pause(16 * BEAT_MS);
    expect(spans([b]), context([a, b], machine)).toEqual([]);
    expect(
      journal(b.home, taskId).find((l) => l.stepId === step.stepId && l.kind === 'step.transition'),
    ).toBeUndefined();
    const token = readFileSync(layoutOf(b.home).token, 'utf8').trim();
    const url = notesOf(b).find((n) => n.event === 'boot')!.url as string;
    const health = (await (
      await fetch(`${url}/v1/health`, { headers: { authorization: `Bearer ${token}` } })
    ).json()) as { window?: { routes: { routeId: string; verdict: string; usedPct: number }[] } };
    expect(health.window?.routes).toContainEqual(
      expect.objectContaining({ routeId: ROUTE, verdict: 'held', usedPct: 92 }),
    );
  }, 240_000);

  it('sessionSlots 3 under max-quality: 5 units of one task run 3 at a time, the other two wait', async () => {
    const machine = machineDir();
    const config = {
      queue: { beatMs: BEAT_MS, sessionSlots: 3 },
      lead: { projects: { r1: { profile: 'max-quality' } } },
    };
    const m = startCore('m', machine, { repo: sourceRepo(), tasks: 1, units: 5, config });
    const waitingSeats = () => seatsOf(machine).filter((s) => s.ticket.holder === null).length;
    await until(
      () => (spans([m]).length >= 3 && waitingSeats() >= 2 ? true : undefined),
      'three sessions open, two steps wait',
    ).catch((e: unknown) => {
      throw new Error(`${String(e)}\n${context([m], machine)}`);
    });
    await pause(8 * BEAT_MS);
    const settled = spans([m]);
    expect(settled.length, `${tails([m])}\n${context([m], machine)}`).toBe(3);
    expect(maxOverlap(settled)).toBe(3);
    expect(seatsOf(machine).filter((s) => s.ticket.holder !== null)).toHaveLength(3);
    // Предел места — min(профиль max-quality 6, sessionSlots 3).
    expect(new Set(seatsOf(machine).map((s) => s.limit))).toEqual(new Set([3]));
  }, 240_000);

  it('a killed session host: the core journals host-dead → lost once within the reap window, the seat is released once, the step moves on; a restarted core writes no second end', async () => {
    const machine = machineDir();
    const config = { queue: { beatMs: BEAT_MS, sessionSlots: 1 } };
    const h = startCore('h', machine, {
      repo: sourceRepo(),
      tasks: 1,
      units: 2,
      config,
      observer: { hostCheckMs: 0 },
    });
    const first = await until(
      () => (spans([h]).length >= 1 && seatsOf(machine).length >= 2 ? spans([h])[0] : undefined),
      'one session holds the only seat, the other unit waits',
    ).catch((e: unknown) => {
      throw new Error(`${String(e)}\n${context([h], machine)}`);
    });
    const lines = () => journal(h.home, first.taskId);
    const started = lines().find(
      (l) => l.kind === 'session.started' && l.sessionId === first.sessionId,
    )!;
    const ends = () =>
      lines().filter(
        (l) =>
          l.kind === 'session.transition' &&
          l.sessionId === first.sessionId &&
          ['ended', 'lost'].includes((l.data as { to: string }).to),
      );
    expect(ends()).toEqual([]);

    const killedAt = Date.now();
    process.kill(first.hostPid);
    // Окно снятия места владельцем при ударе по умолчанию (3 × 5 с): конец сеанса — внутри него.
    const lost = await until(
      () => ends()[0],
      'the core journals the end of the session with a dead host',
      15_000,
    ).catch((e: unknown) => {
      throw new Error(`${String(e)}\n${tails([h])}\n${context([h], machine)}`);
    });
    expect(lost.data).toMatchObject({ event: 'host-dead', to: 'lost' });
    expect(lost.at - killedAt).toBeLessThan(15_000);
    // Исполнитель узнал о конце: шаг мёртвого сеанса выведен из ожидания (переход шага после
    // убийства), а не держится на потоке, который больше ничего не пришлёт.
    await until(
      () =>
        lines().find(
          (l) => l.kind === 'step.transition' && l.stepId === started.stepId && l.at > killedAt,
        ),
      'the step of the dead session moves on',
      30_000,
    ).catch((e: unknown) => {
      throw new Error(`${String(e)}\n${tails([h])}\n${context([h], machine)}`);
    });

    // Шаг не висит на мёртвом сеансе: место уходит ждущей единице, у неё открывается сеанс.
    await until(
      () => (spans([h]).length >= 2 ? true : undefined),
      'the waiting unit opens a session after the dead one ended',
      60_000,
    ).catch((e: unknown) => {
      throw new Error(`${String(e)}\n${tails([h])}\n${context([h], machine)}`);
    });
    await pause(6 * BEAT_MS);
    // Место мёртвого сеанса отпущено ровно один раз: концом сеанса либо снятием владельцем.
    const freed = coreLog(h).filter(
      (e) =>
        (e.event === 'seat.released' && e.taskId === first.taskId && e.stepId === started.stepId) ||
        (e.event === 'seat.reaped' && e.taskId === first.taskId && e.holderPid === first.hostPid),
    );
    expect(freed, JSON.stringify(freed)).toHaveLength(1);
    expect(ends()).toHaveLength(1);

    // Перезапуск ядра на том же доме: сверка загрузки второго конца не пишет.
    writeFileSync(join(h.home, '..', 'stop'), '');
    await exited(h, 60_000).catch((e: unknown) => {
      const log = coreLog(h)
        .filter((x) => !/seat\.(beat|granted)/.test(String(x.event)))
        .slice(-25)
        .map((x) => JSON.stringify(x).slice(0, 260));
      const left = notesOf(h).filter((n) => n.event === 'stopped');
      throw new Error(
        `${String(e)}\n${log.join('\n')}\nnotes: ${JSON.stringify(left)}\nstderr: ${h.stderr().slice(-800)}`,
      );
    });
    rmSync(join(h.home, '..', 'stop'), { force: true });
    const again = startCore(
      'h2',
      machine,
      { repo: sourceRepo(), tasks: 0, units: 0, config },
      join(h.home, '..'),
    );
    await until(
      () =>
        notesOf(again).some((n) => n.event === 'boot' && n.pid === again.child.pid)
          ? true
          : undefined,
      'the restarted core booted',
    );
    await pause(6 * BEAT_MS);
    expect(ends(), tails([again])).toHaveLength(1);
  }, 300_000);

  it('a chat opens beside the 4: four unit sessions of two cores and a chat run at once, the chat seat is uncounted, the fifth unit waits', async () => {
    const machine = machineDir();
    const config = { queue: { beatMs: BEAT_MS } };
    const a = startCore('ca', machine, {
      repo: sourceRepo(),
      tasks: 1,
      units: 3,
      chats: 1,
      config,
    });
    const b = startCore('cb', machine, { repo: sourceRepo(), tasks: 1, units: 2, config });
    const both = [a, b];
    const waitingSeats = () => seatsOf(machine).filter((s) => s.ticket.holder === null).length;
    await until(
      () =>
        notesOf(a).some((n) => n.event === 'chat') &&
        spans(both).length >= 4 &&
        spans(both, 'chats').length >= 1 &&
        waitingSeats() >= 1
          ? true
          : undefined,
      'four unit sessions and the chat open, the fifth unit waits',
    ).catch((e: unknown) => {
      throw new Error(`${String(e)}\n${tails(both)}\n${context(both, machine)}`);
    });
    await pause(12 * BEAT_MS);
    const steps = spans(both);
    const chats = spans(both, 'chats');
    expect(steps.length, context(both, machine)).toBe(4);
    expect(chats).toHaveLength(1);
    expect(
      [...steps, ...chats].filter((s) => s.to !== null),
      tails(both),
    ).toEqual([]);
    // Четыре места шагов заняты, чат идёт рядом: пять сеансов разом, счёт мест — четыре.
    expect(maxOverlap(steps)).toBe(4);
    expect(maxOverlap([...steps, ...chats])).toBe(5);
    const seats = seatsOf(machine);
    expect(seats.filter((s) => !s.interactive && s.ticket.holder !== null)).toHaveLength(4);
    expect(seats.filter((s) => s.interactive && s.ticket.holder !== null)).toHaveLength(1);
    expect(seats.filter((s) => s.ticket.holder === null)).toHaveLength(1);
    // Чат места не ждал: в его журнале нет решения `schedule` без выдачи.
    const chatWaits = journal(a.home, chats[0]!.taskId).filter(
      (l) =>
        l.kind === 'decision' &&
        (l.data as unknown as { class: string }).class === 'schedule' &&
        ((l.data as unknown as { output: { grant?: string[] } }).output.grant ?? []).length === 0,
    );
    expect(chatWaits).toEqual([]);
  }, 300_000);

  it('local:own one at a time across two cores: each core has its own model server (stub-model runner), only the seat allocator keeps the route serial; the next opens once the holder ends', async () => {
    const machine = machineDir();
    const own = tempDir('alloc-own-');
    owns.push(own);
    const config = { queue: { beatMs: BEAT_MS } };
    const a = startCore('oa', machine, {
      repo: sourceRepo(),
      tasks: 1,
      units: 2,
      config,
      own: join(own, 'a'),
      observer: { hostCheckMs: 0 },
    });
    const b = startCore('ob', machine, {
      repo: sourceRepo(),
      tasks: 1,
      units: 1,
      config,
      own: join(own, 'b'),
      observer: { hostCheckMs: 0 },
    });
    const both = [a, b];
    const waitingSeats = () => seatsOf(machine).filter((s) => s.ticket.holder === null).length;
    const first = await until(
      () => (spans(both).length >= 1 && waitingSeats() >= 2 ? spans(both)[0] : undefined),
      'one local:own session opens, the two other units wait for the route',
      180_000,
    ).catch((e: unknown) => {
      throw new Error(`${String(e)}\n${tails(both)}\n${context(both, machine)}`);
    });
    await pause(12 * BEAT_MS);
    expect(spans(both), `${tails(both)}\n${context(both, machine)}`).toHaveLength(1);
    const started = journal(both.find((c) => c.name === first.core)!.home, first.taskId).find(
      (l) => l.kind === 'session.started' && l.sessionId === first.sessionId,
    )!;
    expect((started.data as { route: { id: string } }).route.id).toBe('local:own');
    // Ждущие шаги обоих ядер называют причину — маршрут, а не число мест.
    const reasons = both.flatMap((c) =>
      taskIds(c.home).flatMap((id) =>
        journal(c.home, id)
          .filter(
            (l) =>
              l.kind === 'decision' &&
              (l.data as unknown as { class: string }).class === 'schedule' &&
              ((l.data as unknown as { output: { grant?: string[] } }).output.grant ?? [])
                .length === 0,
          )
          .map((l) => (l.data as unknown as { output: { reason: string } }).output.reason),
      ),
    );
    expect(new Set(reasons), JSON.stringify(reasons)).toEqual(new Set(['route']));
    expect(new Set(seatsOf(machine).map((s) => s.ticket.taskId)).size).toBe(2);

    // Держащий кончился (хост убит): маршрут переходит к следующему, по-прежнему один за раз.
    const killedAt = Date.now();
    process.kill(first.hostPid);
    await until(
      () => (spans(both).length >= 2 ? true : undefined),
      'the next local:own session opens after the holder ended',
      120_000,
    ).catch((e: unknown) => {
      throw new Error(`${String(e)}\n${tails(both)}\n${context(both, machine)}`);
    });
    await pause(8 * BEAT_MS);
    const after = spans(both);
    expect(after, tails(both)).toHaveLength(2);
    const dead = after.find((s) => s.sessionId === first.sessionId)!;
    expect(dead.to, tails(both)).not.toBeNull();
    // Сеанс с убитым хостом кончился в миг убийства; строка `lost` пишется по сверке хостов позже.
    expect(maxOverlap(after.map((s) => (s === dead ? { ...s, to: killedAt } : s)))).toBe(1);
  }, 420_000);
});
