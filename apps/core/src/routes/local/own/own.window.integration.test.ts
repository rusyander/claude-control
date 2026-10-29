import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createLivenessProbe } from '../../../platform/process-identity.ts';
import { markWaitDead, waitRank, type WaitOwner } from './lease-state.ts';
import type { OwnRoute } from './own.ts';
import {
  deadMarks,
  recorder,
  restartKit,
  settle,
  until,
  waitFiles,
} from './__fixtures__/restart-kit.ts';

/**
 * P10 для `local:own` (11 R:PR-04, P113): окно повторной выдачи места ждущего упавшего ядра
 * считается от ПЕРВОГО факта смерти его владельца, прочитанного любым ядром, — не от старта
 * читающего. Ядро, упавшее посреди окна, счёт не сбрасывает; «неизвестно» его не начинает;
 * владелец, прочитанный живым, прежний «мёртв» опровергает; место, выданное заново живому
 * второму ядру, снимающее ядро не трогает.
 */

const root = mkdtempSync(join(tmpdir(), 'own-window-'));
const { track, restartedRoute, killedCore, restoringCore, sweep } = restartKit(root);
const sleepers: ChildProcess[] = [];

afterAll(async () => {
  for (const child of sleepers) if (child.exitCode === null) child.kill();
  await sweep();
}, 120_000);

const MODEL = 'tiny-model';
const WINDOW = 6_000;
/**
 * Окно опыта «первая смерть, а не старт C»: возврат состояния C под нагрузкой Windows идёт
 * 5–8 с (каждое чтение таблицы процессов — запуск PowerShell), а снятие места не раньше его
 * конца. Окно шире этого, чтобы граница «до старта C + окно» различала, а не мерила нагрузку.
 */
const FIRST_DEATH_WINDOW = 12_000;
/** Сколько ядро «B» живёт после того, как прочитало владельца мёртвым. */
const B_LIVES = 3_000;
/** Окно, которое опыт не ждёт: место не снимается посреди возврата состояния, как бы тот ни шёл. */
const NO_WINDOW = 600_000;

/** Освобождение чужой аренды без ресурсов: ядро только возвращает состояние прошлого. */
const restore = (route: OwnRoute): Promise<unknown> =>
  route.release(
    { leaseId: 'none', routeId: 'local:own', model: MODEL, resources: [] },
    recorder().record,
  );

/** Имя записи первой смерти владельца места задачи (рядом с файлом места). */
const markOf = (taskId: string): string =>
  `${Buffer.from(`gpu\n${taskId}`).toString('base64url')}.dead`;

/** Живой процесс «второго ядра» с личностью, как её читает проба. */
async function liveOwner(): Promise<WaitOwner> {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000)'], {
    stdio: 'ignore',
    windowsHide: true,
  });
  sleepers.push(child);
  const pid = child.pid ?? 0;
  const me = await createLivenessProbe().identityOf(pid);
  if (!('value' in me)) throw new Error(`no identity for live pid ${pid}`);
  return { pid, start: me.value.start, bootId: 'second-core' };
}

describe('P10 local:own — the re-issue window runs from the first death fact, across cores', () => {
  it('P10 local:own: core A waits and dies, core B reads it dead and dies mid-window, core C reaps at first death + window — not at its own start + window', async () => {
    const { layout, lease } = await killedCore('first-death');
    const b = await restoringCore(layout);
    // B записал первую смерть владельца места «queued».
    expect.soft(deadMarks(layout)).toEqual([markOf('queued')]);
    await settle(B_LIVES);
    await b.kill();
    const journal = recorder();
    let reapedAt = 0;
    const startC = Date.now();
    const { route } = restartedRoute(layout, {
      // Миг снятия места — по записи в журнал, не по выдаче слота (её задерживает освобождение).
      journal: {
        ...journal.record,
        decision: (d) => ((reapedAt = Date.now()), journal.record.decision(d)),
      },
      reissueWindowMs: FIRST_DEATH_WINDOW,
      recheckMs: 100,
    });
    const r = recorder();
    expect((await route.release(lease, r.record)).leaks).toEqual([]);
    const second = await track(route.acquire({ taskId: 'fresh', model: MODEL }, r.record));
    // Не раньше первой смерти + окна (смерть прочитана не раньше старта B).
    expect(reapedAt).toBeGreaterThanOrEqual(b.spawnedAt + FIRST_DEATH_WINDOW);
    // Не от старта C: счёт от своего чтения начался бы не раньше `startC` и снял бы место не
    // раньше `startC` + окно — граница точная, остаток окна B (≈ окно − B_LIVES) под ней.
    expect(reapedAt - startC).toBeLessThan(FIRST_DEATH_WINDOW);
    expect(journal.decisions).toEqual([
      expect.objectContaining({
        class: 'slot-wait',
        numbers: expect.objectContaining({
          elapsedMs: expect.any(Number) as number,
          reissueWindowMs: FIRST_DEATH_WINDOW,
        }) as object,
        output: { subject: 'waiter', action: 'release', taskId: 'queued' },
      }),
    ]);
    expect(journal.decisions[0]?.numbers?.['elapsedMs']).toBeGreaterThanOrEqual(FIRST_DEATH_WINDOW);
    expect(waitFiles(layout)).toEqual([]);
    expect(deadMarks(layout)).toEqual([]);
    expect((await route.release(second, r.record)).leaks).toEqual([]);
  }, 120_000);

  it('P10 local:own: core B reading the owner as unknown writes no death — core C starts the window at its own dead read', async () => {
    const { layout, lease, corePid } = await killedCore('unknown-first');
    const b = await restoringCore(layout, corePid);
    await settle(B_LIVES);
    expect(deadMarks(layout)).toEqual([]);
    await b.kill();
    const startC = Date.now();
    const { route } = restartedRoute(layout, { reissueWindowMs: WINDOW, recheckMs: 100 });
    const r = recorder();
    // Запись смерти — сразу по возврату состояния C, до освобождения аренды: освобождение
    // сервера под нагрузкой длится секунды и само по себе съедает окно.
    await restore(route);
    expect(deadMarks(layout)).toEqual([markOf('queued')]);
    expect((await route.release(lease, r.record)).leaks).toEqual([]);
    const second = await track(route.acquire({ taskId: 'fresh', model: MODEL }, r.record));
    expect(Date.now() - startC).toBeGreaterThanOrEqual(WINDOW);
    expect(deadMarks(layout)).toEqual([]);
    expect((await route.release(second, r.record)).leaks).toEqual([]);
  }, 120_000);

  it('P10 local:own: an owner read alive refutes an earlier death record — the record is removed, the place untouched', async () => {
    const { layout, lease } = await killedCore('alive-refutes');
    const owner = await liveOwner();
    const place = { slotKey: 'gpu', taskId: 'other', owner };
    waitRank(layout.workRoot, place, Date.now());
    // Прежнее ядро ошибочно прочитало его мёртвым час назад.
    markWaitDead(layout.workRoot, place, Date.now() - 3_600_000);
    expect(deadMarks(layout)).toEqual([markOf('other')]);
    // Место прежнего вида без владельца: «владелец не записан» — тоже окончательный факт.
    const legacy = `${Buffer.from('gpu\nlegacy').toString('base64url')}.json`;
    writeFileSync(
      join(layout.workRoot, '.slot-waiting', legacy),
      JSON.stringify({ rank: 1, slotKey: 'gpu', taskId: 'legacy' }),
    );
    // Окно здесь не проверяется: при обычном окне возврат дольше него (нагрузка) законно снял бы
    // «legacy» раньше, чем опыт прочтёт его запись.
    const { route } = restartedRoute(layout, { reissueWindowMs: NO_WINDOW, recheckMs: 100 });
    await restore(route);
    // Мёртвый «queued» и безвладельный «legacy» — записи сразу при возврате; живой «other» —
    // запись снята, место на месте.
    expect(deadMarks(layout).sort()).toEqual([markOf('legacy'), markOf('queued')].sort());
    expect(waitFiles(layout)).toHaveLength(3);
    // Снова «мёртв» — счёт начинается заново, а не с часа назад.
    expect(markWaitDead(layout.workRoot, place, 42)).toBe(42);
    expect((await route.release(lease, recorder().record)).leaks).toEqual([]);
  }, 120_000);

  it('P10 local:own: a live core whose own start was unreadable at its restore (`unknown:` start on its places) is never read dead — no death record, its place outlives the window; once its pid is gone → dead', async () => {
    const { layout, lease } = await killedCore('unproven-owner');
    const live = await liveOwner();
    // Под нагрузкой снимок ядра о самом себе не ответил: места пишутся с недоказанным стартом.
    const owner = { ...live, start: `unknown:${Date.now()}` };
    waitRank(layout.workRoot, { slotKey: 'gpu', taskId: 'other', owner }, Date.now());
    const journal = recorder();
    const { route } = restartedRoute(layout, {
      journal: journal.record,
      reissueWindowMs: 1_500,
      livenessRetryMs: 600_000,
      recheckMs: 100,
    });
    await restore(route);
    // «queued» прочитан мёртвым при возврате — по снятию через окно, не по записи смерти: чтение
    // «other» идёт после записи «queued» и под нагрузкой дольше окна, так что место «queued» законно
    // снято ещё до конца возврата.
    const queuedReaped = (): boolean =>
      journal.decisions.some((d) => {
        const out = d.output as { taskId?: string; action?: string } | undefined;
        return out?.taskId === 'queued' && out.action === 'release';
      });
    expect(await until(queuedReaped, 30_000)).toBe(true);
    await settle(2_500);
    expect(deadMarks(layout)).not.toContain(markOf('other'));
    expect(waitFiles(layout)).toContain(`${Buffer.from('gpu\nother').toString('base64url')}.json`);
    expect(journal.decisions.map((d) => d.output)).not.toContainEqual(
      expect.objectContaining({ taskId: 'other' }),
    );
    // Номера больше нет — это уже факт смерти, недоказанный старт его не отменяет.
    sleepers.find((child) => child.pid === live.pid)?.kill();
    expect(await until(() => deadMarks(layout).includes(markOf('other')), 30_000)).toBe(true);
    expect((await route.release(lease, recorder().record)).leaks).toEqual([]);
  }, 120_000);

  it('P10 local:own: a place re-issued to a live second core inside the window is left alone when the window of its dead former owner ends', async () => {
    const { layout, lease } = await killedCore('reissued-elsewhere');
    const journal = recorder();
    const { route } = restartedRoute(layout, {
      journal: journal.record,
      reissueWindowMs: 1_500,
      recheckMs: 100,
    });
    const owner = await liveOwner();
    await restore(route);
    expect(deadMarks(layout)).toEqual([markOf('queued')]);
    // Задача «queued» вернулась к живому второму ядру над тем же каталогом — раньше первой
    // перепроверки C: та не пишет смерть прежнего владельца рядом с чужим местом.
    waitRank(layout.workRoot, { slotKey: 'gpu', taskId: 'queued', owner }, Date.now());
    expect(deadMarks(layout)).toEqual([]);
    await settle(2_500);
    expect(journal.decisions).toEqual([]);
    expect(waitFiles(layout)).toHaveLength(1);
    expect(deadMarks(layout)).toEqual([]);
    expect((await route.release(lease, recorder().record)).leaks).toEqual([]);
  }, 120_000);
});
