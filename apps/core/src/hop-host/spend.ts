import type { HopPriceSpec, HopSpend, HopTag } from '@agentdeck/contracts/core/hops';
import type { RouteId } from '@agentdeck/contracts/core/routes';
import { listDir } from '../platform/safe-io/files.ts';
import { readJsonFile, writeJsonFile } from './gateway/json-file.ts';
import { spendFileOf } from './paths.ts';
import { hopPriceOf, type HopPrice } from './price.ts';
import type { ExhaustedFile, SpendSpec, SpendUsage, StoredSpend } from './spend.types.ts';

/**
 * Учёт расхода по сеансовым меткам (P122) и отметки исчерпания маршрутов (G11). Писатель
 * `<home>/spend/` — ТОЛЬКО этот хост (G2): его единственность держит замок `hops/host.lock`,
 * поэтому здесь нет слияния с чужой записью — второй писатель не запускается вовсе.
 *
 * Расход копится в памяти и сбрасывается пачкой (как `spend-flush` панели): ответ модели не
 * ждёт бухгалтерию. Исчерпание пишется СРАЗУ: это факт, по которому маршрут держится, и
 * потерять его при падении хоста значило бы снова ходить в исчерпанный ключ.
 */

/** Цена одного ответа (P127); по умолчанию `hopPriceOf` — тот же пакет цен, что у ядра. */
export type PriceOf = (
  price: HopPriceSpec | null,
  model: string,
  usage: SpendUsage,
  at: number,
) => HopPrice;

/**
 * Деньги — только когда цена известна у КАЖДОГО ответа метки: сумма с дырой выглядела бы
 * точной. Однажды `null` — навсегда `null` для этой метки, и причина — первой дыры.
 */
function addMoney(row: StoredSpend, fresh: boolean, priced: HopPrice): void {
  if (priced.money === null) {
    if (row.money !== null || !row.moneyReason) row.moneyReason = priced.reason;
    row.money = null;
    return;
  }
  if (fresh) row.money = priced.money;
  else if (row.money === null) return;
  else row.money += priced.money;
  row.moneyReason = null;
  const versions = row.priceVersions ?? {};
  versions[priced.version] = (versions[priced.version] ?? 0) + 1;
  row.priceVersions = versions;
}

export class SpendBook {
  readonly #dir: string;
  readonly #exhaustedPath: string;
  readonly #price: PriceOf;
  readonly #rows = new Map<HopTag, StoredSpend>();
  readonly #dirty = new Set<HopTag>();
  #exhausted: ExhaustedFile;

  constructor(dir: string, exhaustedPath: string, price: PriceOf = hopPriceOf) {
    this.#dir = dir;
    this.#exhaustedPath = exhaustedPath;
    this.#price = price;
    this.#exhausted = this.#readExhausted();
    const listed = listDir(dir);
    for (const name of 'value' in listed ? listed.value : []) {
      if (!name.endsWith('.json') || name === 'exhausted.json') continue;
      try {
        const row = readJsonFile<StoredSpend | undefined>(`${dir}/${name}`, undefined);
        if (row && typeof row.tag === 'string') this.#rows.set(row.tag, row);
      } catch {
        // Битая строка расхода не роняет хост: метка начнёт счёт заново, и след это покажет.
      }
    }
  }

  #readExhausted(): ExhaustedFile {
    try {
      const file = readJsonFile<ExhaustedFile>(this.#exhaustedPath, { v: 1, routes: [] });
      return Array.isArray(file.routes) ? file : { v: 1, routes: [] };
    } catch {
      return { v: 1, routes: [] };
    }
  }

  /** Ответ модели сеанса: токены — всегда, деньги — по цене маршрута из регистрации. */
  add(spec: SpendSpec, model: string, usage: SpendUsage, now: number): void {
    const { tag, routeId } = spec;
    const fresh = !this.#rows.has(tag);
    const row = this.#rows.get(tag) ?? {
      tag,
      routeId,
      input: 0,
      cacheRead: 0,
      cacheWrite: 0,
      output: 0,
      money: null,
      moneyReason: null,
      priceVersions: {},
      updatedAt: now,
    };
    row.input += usage.input;
    row.cacheRead += usage.cacheRead;
    row.cacheWrite += usage.cacheWrite;
    row.output += usage.output;
    addMoney(row, fresh, this.#price(spec.price, model, usage, now));
    row.updatedAt = now;
    this.#rows.set(tag, row);
    this.#dirty.add(tag);
  }

  spendOf(tag: HopTag): HopSpend | null {
    const row = this.#rows.get(tag);
    if (!row) return null;
    return {
      tag: row.tag,
      input: row.input,
      cacheRead: row.cacheRead,
      cacheWrite: row.cacheWrite,
      output: row.output,
      money: row.money,
      // Строка прежнего хоста (до пакета цен) причины не несёт: денег там не считал никто.
      moneyReason: row.money === null ? (row.moneyReason ?? 'no-price-fact') : null,
      priceVersions: { ...row.priceVersions },
    };
  }

  /** Сбросить накопленное на диск: каждая метка — свой файл, атомарно. */
  flush(): void {
    for (const tag of [...this.#dirty]) {
      const row = this.#rows.get(tag);
      if (row) writeJsonFile(spendFileOf(this.#dir, tag), row);
      this.#dirty.delete(tag);
    }
  }

  /** 402 вендора: маршрут держится до `clear-exhausted` человека; первая отметка не сдвигается. */
  markExhausted(routeId: RouteId, now: number): void {
    if (this.#exhausted.routes.some((row) => row.routeId === routeId)) return;
    this.#exhausted = { v: 1, routes: [...this.#exhausted.routes, { routeId, exhaustedAt: now }] };
    writeJsonFile(this.#exhaustedPath, this.#exhausted);
  }

  exhaustedAt(routeId: RouteId): number | undefined {
    return this.#exhausted.routes.find((row) => row.routeId === routeId)?.exhaustedAt;
  }

  clearExhausted(routeId: RouteId): boolean {
    const before = this.#exhausted.routes.length;
    const routes = this.#exhausted.routes.filter((row) => row.routeId !== routeId);
    if (routes.length === before) return false;
    this.#exhausted = { v: 1, routes };
    writeJsonFile(this.#exhaustedPath, this.#exhausted);
    return true;
  }

  exhausted(): ExhaustedFile['routes'] {
    return [...this.#exhausted.routes];
  }
}
