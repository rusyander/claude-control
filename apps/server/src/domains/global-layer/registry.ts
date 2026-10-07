import { readFileSync } from 'node:fs';
import type { GlobalLayerText } from '@agentdeck/contracts';

/**
 * Реестр пар «панель ↔ глобальный слой» — файл данных `registry.json`.
 *
 * Новая пара того же рода — одна запись: файлы обеих сторон, модуль, который
 * исполняется, и корпус. Род (`runner`) — это знание, как прогнать сторону на
 * случае и привести её ответ к общему виду; он и есть единственный код пары
 * (`runners.ts`), и пары одного рода его делят.
 */

export interface PairSide {
  /** Модуль, который исполняет прогон: у панели — от корня репозитория, у глобального — от каталога конфигурации. */
  module: string;
  /** Файлы стороны: их отпечаток решает, изменилась ли она после сверки. */
  files: string[];
  /** Тесты стороны — называются в задании переноса. */
  tests: string[];
}

export interface PairEntry {
  id: string;
  title: GlobalLayerText;
  runner: string;
  /** Корпус относительно каталога реестра. */
  corpus: string;
  panel: PairSide;
  global: PairSide;
}

const REGISTRY_URL = new URL('./registry.json', import.meta.url);

function isSide(value: unknown): value is PairSide {
  const side = value as PairSide | undefined;
  return (
    typeof side?.module === 'string' &&
    Array.isArray(side.files) &&
    side.files.every((file) => typeof file === 'string') &&
    Array.isArray(side.tests)
  );
}

/** Записи реестра; кривая запись отбрасывается, а не роняет весь раздел. */
export function loadRegistry(raw: string = readFileSync(REGISTRY_URL, 'utf8')): PairEntry[] {
  const parsed = JSON.parse(raw) as { pairs?: unknown[] };
  return (parsed.pairs ?? []).filter((entry): entry is PairEntry => {
    const pair = entry as PairEntry;
    return (
      typeof pair.id === 'string' &&
      typeof pair.runner === 'string' &&
      typeof pair.corpus === 'string' &&
      typeof pair.title?.ru === 'string' &&
      typeof pair.title.en === 'string' &&
      isSide(pair.panel) &&
      isSide(pair.global)
    );
  });
}

/** Корпус пары читается заново на каждую сверку: найденное расхождение дописывает его. */
export function corpusPath(pair: PairEntry): URL {
  return new URL(pair.corpus, REGISTRY_URL);
}
