import { join } from 'node:path';
import type { TaskRegistry } from '../conductor/tasks.ts';
import { channelPath } from '../platform/control-channel.ts';
import type { CoreHomeLayout } from '../platform/core-home.ts';
import { currentOs, type OsKind } from '../platform/os-kind.ts';
import {
  identityOfPid,
  type Liveness,
  type ProcessIdentity,
} from '../platform/process-identity.ts';
import { osProcessTable } from '../platform/process-table.ts';
import {
  openSupervisorChannel,
  SUPERVISOR_TOKEN_FILE,
  type SupervisorChannel,
} from '../platform/supervisor-channel.ts';
import { ensureTokenFile } from '../platform/token-file.ts';
import { privateChannelDir } from '../session-host/launch.ts';
import type { DevicesNote } from './devices.ts';
import { createSessionPeerCheck, sessionRootsOf } from './session-peers.ts';
import { createTrustedHops, type TrustedHops } from './trusted-hops.ts';

/**
 * Надзор в сборе (P131): набор доверенных звеньев + канал, через который его пишут сторожа
 * панели. Набор существует с начала загрузки (API судит пира по нему), канал поднимается
 * перед строкой `procs.json` — его путь едет в той же строке (`supervisor`), и сторож находит
 * его там же, где панель находит ядро. Канал не поднялся — набор пуст, команда через панель
 * требует подписи устройства; загрузка не падает: ядро без надзора исполнять задачи может.
 */

const SWEEP_MS = 30_000;

export interface SupervisorWiring {
  hops: TrustedHops;
  /** Поднять канал; путь — для строки `procs.json`, `undefined` — канала нет (причина в журнале). */
  open(): Promise<string | undefined>;
  close(): Promise<void>;
}

function supervisorPath(bootId: string, os: OsKind): { value: string } | { unknown: string } {
  const id = `sup-${bootId}`;
  if (os === 'win32') return { value: channelPath(id, os) };
  const dir = privateChannelDir({ os });
  if (!('value' in dir)) return dir;
  return { value: channelPath(id, os, dir.value) };
}

export function supervisorWiring(deps: {
  layout: CoreHomeLayout;
  bootId: string;
  registry: TaskRegistry;
  isAlive(id: ProcessIdentity): Promise<Liveness>;
  note: DevicesNote;
  os?: OsKind;
}): SupervisorWiring {
  const os = deps.os ?? currentOs();
  const hops = createTrustedHops({
    identityOf: (pid) => identityOfPid(pid),
    isAlive: deps.isAlive,
    isSessionDescendant: createSessionPeerCheck({
      roots: () => sessionRootsOf(deps.registry),
      table: osProcessTable(),
    }),
    note: deps.note,
    now: Date.now,
  });
  let channel: SupervisorChannel | undefined;
  let sweep: ReturnType<typeof setInterval> | undefined;
  return {
    hops,
    async open() {
      const path = supervisorPath(deps.bootId, os);
      if (!('value' in path)) {
        deps.note('supervisor.absent', { reason: path.unknown });
        return undefined;
      }
      try {
        const token = ensureTokenFile(join(deps.layout.root, SUPERVISOR_TOKEN_FILE), os).token;
        channel = await openSupervisorChannel({
          path: path.value,
          token,
          handler: { hopsSet: (pids) => hops.set(pids) },
          os,
        });
      } catch (error) {
        deps.note('supervisor.absent', {
          reason: error instanceof Error ? error.message : String(error),
        });
        return undefined;
      }
      sweep = setInterval(() => void hops.sweep(), SWEEP_MS);
      sweep.unref();
      deps.note('supervisor', { channel: path.value });
      return path.value;
    },
    async close() {
      clearInterval(sweep);
      await channel?.close();
      channel = undefined;
    },
  };
}
