import { join } from 'node:path';

/**
 * Где хост звеньев держит своё состояние в доме ядра. Один источник путей для хоста и для
 * клиента ядра (`routes/hops` повторяет ровно эти имена, импорт через слой запрещён).
 *
 * `spend/` — расход по меткам; писатель у него ОДИН — хост, взявший `hops/host.lock` (G2).
 */
export interface HopLayout {
  dir: string;
  lock: string;
  token: string;
  ports: string;
  tags: string;
  trace: string;
  spendDir: string;
  exhausted: string;
}

export function hopLayoutOf(home: string): HopLayout {
  const dir = join(home, 'hops');
  const spendDir = join(home, 'spend');
  return {
    dir,
    lock: join(dir, 'host.lock'),
    token: join(dir, 'control.token'),
    ports: join(dir, 'ports.json'),
    tags: join(dir, 'tags.json'),
    trace: join(dir, 'trace.jsonl'),
    spendDir,
    exhausted: join(spendDir, 'exhausted.json'),
  };
}

/** Файл расхода метки. Метка — имя файла, поэтому чужие знаки в ней заменяются. */
export function spendFileOf(spendDir: string, tag: string): string {
  return join(spendDir, `${tag.replace(/[^A-Za-z0-9._-]/g, '_')}.json`);
}
