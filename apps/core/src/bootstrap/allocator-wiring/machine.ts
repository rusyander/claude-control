import { join } from 'node:path';
import type { LimitFact } from '@agentdeck/contracts/core/economy';
import type { WindowFactStore } from '../../economy/window/index.ts';
import { CORE_HOME_ENV, type CoreHomeLayout } from '../../platform/core-home.ts';
import { homeDir } from '../../platform/os-kind.ts';
import { writeFileAtomic } from '../../platform/safe-io/atomic-write.ts';
import { listDir, readBytesSync } from '../../platform/safe-io/files.ts';

/**
 * Каталог машины (этап 11, P141-P142): места сеансов и факты окна — общие для всех ядер этой
 * машины, на каком бы доме и сборке они ни шли (одно ядро на дом — `home-lock.ts`; две сборки —
 * два дома). Поэтому каталог вне любого дома: `~/.agentdeck/machine/`.
 *
 * Переменная `AGENTDECK_CORE_MACHINE` называет его явно (так два ядра проверки делят один).
 * Дом ядра перенесён переменной (стенд, набор тестов) — каталог машины только явный, иначе
 * очередь своего дома: одноразовый стенд не должен ни занимать места настоящих ядер человека,
 * ни ждать их (тот же довод, что у каталога данных панели, `panel-profiles.ts`).
 */

export const MACHINE_DIR_ENV = 'AGENTDECK_CORE_MACHINE';

/** Каталог очереди машины: `<machine>/queue`, а для перенесённого дома — `<home>/queue`. */
export function machineQueueDir(
  layout: Pick<CoreHomeLayout, 'queue'>,
  env: Readonly<Record<string, string | undefined>> = process.env,
  home: string = homeDir(),
): string {
  const named = env[MACHINE_DIR_ENV]?.trim();
  if (named) return join(named, 'queue');
  if (env[CORE_HOME_ENV]?.trim()) return layout.queue;
  return join(home, '.agentdeck', 'machine', 'queue');
}

const FACT_SUFFIX = '.json';

function parseFact(bytes: Buffer): LimitFact | undefined {
  try {
    const v = JSON.parse(bytes.toString('utf8')) as Partial<LimitFact> | null;
    return v &&
      typeof v.routeId === 'string' &&
      typeof v.limitKind === 'string' &&
      typeof v.at === 'number'
      ? (v as LimitFact)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Хранилище фактов окна на диске (`<queue>/window/`): файл на пару «маршрут × вид предела», имя —
 * base64url ключа (в id маршрута есть `:`, его не держит имя файла Windows). Пишет только более
 * поздний факт; негодный или пропавший файл читатель пропускает — книга судит по своей памяти.
 */
export function windowFactStore(queueDir: string): WindowFactStore {
  const dir = join(queueDir, 'window');
  const pathOf = (fact: LimitFact): string =>
    join(
      dir,
      `${Buffer.from(`${fact.routeId}|${fact.limitKind}`).toString('base64url')}${FACT_SUFFIX}`,
    );
  const readAt = (path: string): LimitFact | undefined => {
    const bytes = readBytesSync(path);
    return 'value' in bytes ? parseFact(bytes.value) : undefined;
  };
  return {
    read() {
      const names = listDir(dir);
      if (!('value' in names)) return [];
      const out: LimitFact[] = [];
      for (const name of names.value) {
        if (name.startsWith('.') || !name.endsWith(FACT_SUFFIX)) continue;
        const fact = readAt(join(dir, name));
        if (fact) out.push(fact);
      }
      return out;
    },
    write(fact) {
      const path = pathOf(fact);
      const was = readAt(path);
      if (was && was.at > fact.at) return;
      try {
        writeFileAtomic(path, JSON.stringify(fact));
      } catch {
        // Диск не принял — факт остаётся в памяти этой книги; другие ядра его не увидят.
      }
    },
  };
}
