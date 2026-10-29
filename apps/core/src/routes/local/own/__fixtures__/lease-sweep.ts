import { join } from 'node:path';
import { hasValue } from '../../../../platform/os-kind.ts';
import { createLivenessProbe } from '../../../../platform/process-identity.ts';
import { listDir } from '../../../../platform/safe-io/files.ts';
import { stopTree } from '../../../../platform/tree-stop.ts';
import { leaseDirs, readLeaseState } from '../lease-state.ts';
import { stopLeftover, TREE_MARKER_NAME } from '../server.ts';

/**
 * Уборка серверов аренд, брошенных красной проверкой. Сервер `local:own` идёт через хранителя и
 * переживает ядро (это его назначение), поэтому проверка, упавшая между выдачей и освобождением,
 * оставляла хранителя с маршрутизатором жить после vitest. Каталоги наборов — `root/<набор>/leases`;
 * снимается только сервер, живой по личности из записи аренды (свежий вопрос, не кэш такта), — тем
 * же снятием дерева по метке, что у ядра. Остаток неудачного запуска — по своей метке.
 */
export async function stopLeaseServers(root: string): Promise<void> {
  const probe = createLivenessProbe();
  const left: string[] = [];
  const sets = listDir(root);
  for (const set of hasValue(sets) ? sets.value : []) {
    for (const dir of leaseDirs(join(root, set, 'leases'))) {
      const state = readLeaseState(dir);
      const server = state?.server;
      if (server && (await probe.isAlive(server.identity, { fresh: true })) === 'alive') {
        const report = await stopTree(server.identity, {
          group: true,
          marker: { name: TREE_MARKER_NAME, value: server.marker },
        });
        if (report.residual.length > 0)
          left.push(`${dir}: pid ${report.residual.map((id) => id.pid).join(' ')}`);
      }
      if (state?.startLeft) {
        const rest = await stopLeftover(state.startLeft.root, state.startLeft.rid);
        if (rest) left.push(`${dir}: ${rest}`);
      }
    }
  }
  if (left.length > 0) console.warn(`own lease sweep left alive: ${left.join('; ')}`);
}
