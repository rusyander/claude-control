import type { ConfigView, CoreConfig, SetConfigReply } from '@agentdeck/contracts/core/config';
import type { ConfigPort, SetConfigOutcome } from '../../api/config.types.ts';
import type { CoreHomeLayout } from '../../platform/core-home.ts';
import { NO_CONFIG_DIGEST } from '../../platform/core-config/files.ts';
import { readCoreConfig, watchConfigDrift } from '../../platform/core-config/read.ts';
import type { ConfigCmd, ConfigWarning } from '../../platform/core-config/state.ts';
import {
  adoptCoreConfig,
  findConfigCmd,
  recoverPending,
  writeCoreConfig,
} from '../../platform/core-config/write.ts';
import { configWidenings } from './widen.ts';

/**
 * Порт настройки ядра для `GET|POST /v1/config` (00:58, G6, G11). Суд полномочий `set-config`
 * (`human-strict`; токен сессии и процесс из дерева сессии — `forged-authority`, F23) держит API
 * до порта; порт — чтение, запись, ключ повтора, предупреждения о расширении.
 *
 * Создаётся ОДИН раз при загрузке ядра — и тогда же: дописывает запись, оборванную крахом;
 * принимает файл до этапа 7 (памяти писателя нет — его байты становятся последней записью ядра,
 * заметка `config.adopted`); подписывается на дрейф — любой читатель (очередь, дорога сессии,
 * опрос форжа, эта ручка), увидевший правку мимо API, даёт заметку `config.drift` один раз на
 * отпечаток файла за жизнь процесса. Принять дрейф можно только записью через ручку: документ
 * файла от отпечатка последней записи ядра (одно подтверждение человека, G6).
 */

export type ConfigNote = (event: string, data: Record<string, unknown>) => void;

export interface ConfigPortDeps {
  layout: Pick<CoreHomeLayout, 'config'>;
  note: ConfigNote;
  now?: () => number;
}

export interface CoreConfigWiring {
  /** Отдать загрузке API: `config: () => wiring.port`. */
  port: ConfigPort;
  /** Снять подписку на дрейф (остановка ядра). */
  dispose(): void;
}

/** Настройки нет — пустой документ от отпечатка «нет»: от него человек и правит. */
const EMPTY_VIEW: ConfigView = { doc: {}, digest: NO_CONFIG_DIGEST, drift: null, issues: [] };

export function createConfigPort(deps: ConfigPortDeps): CoreConfigWiring {
  const { layout, note } = deps;
  const now = deps.now ?? Date.now;

  const view = (): { value: ConfigView } | { unknown: string } => {
    const read = readCoreConfig(layout);
    if ('absent' in read) return { value: EMPTY_VIEW };
    return read;
  };

  const outcomeOf = (cmd: ConfigCmd, replayed: boolean): SetConfigOutcome => {
    const current = view();
    if ('unknown' in current) throw new Error(`core config unreadable: ${current.unknown}`);
    const reply: SetConfigReply = { view: current.value, replayed, warnings: cmd.warnings };
    return { status: 200, reply };
  };

  const recovered = recoverPending(layout);
  if (recovered && 'recovered' in recovered) {
    note('config.recovered', {
      cmdId: recovered.recovered.cmdId,
      digest: recovered.recovered.digest,
    });
  } else if (recovered) {
    note('config.pending.dropped', { cmdId: recovered.dropped.cmdId });
  }
  const adopted = adoptCoreConfig(layout, now());
  if (adopted) {
    const current = view();
    note('config.adopted', {
      digest: adopted.digest,
      issues:
        'value' in current ? current.value.issues : [{ section: '*', reason: current.unknown }],
    });
  }

  const noted = new Set<string>();
  const stop = watchConfigDrift(layout, (drifted) => {
    if (!drifted.drift || noted.has(drifted.drift.fileDigest)) return;
    noted.add(drifted.drift.fileDigest);
    note('config.drift', {
      fileDigest: drifted.drift.fileDigest,
      sections: drifted.drift.sections,
      at: drifted.drift.at,
      inForce: drifted.digest,
    });
  });
  // Дрейф, накопившийся, пока ядро стояло, назван при загрузке, а не при первом читателе.
  view();

  const port: ConfigPort = {
    view,
    replay(cmdId) {
      const cmd = findConfigCmd(layout, cmdId);
      return cmd ? outcomeOf(cmd, true) : undefined;
    },
    async set(body, by) {
      const before = view();
      const warnings: ConfigWarning[] =
        'value' in before
          ? configWidenings(before.value.doc, body.doc)
          : [
              { section: '*', detail: `previous config unreadable: ${before.unknown}` },
              ...configWidenings({}, body.doc),
            ];
      const got = writeCoreConfig(layout, body.doc as CoreConfig, body.baseDigest, body.cmdId, {
        by,
        warnings,
        at: now(),
      });
      if (got.kind === 'stale') return { status: 409, code: 'stale-digest', digest: got.digest };
      if (got.kind === 'applied') {
        note('config.set', {
          cmdId: body.cmdId,
          digest: got.cmd.digest,
          by,
          warnings: got.cmd.warnings,
        });
      }
      return outcomeOf(got.cmd, got.kind === 'replayed');
    },
    refused(cmdId, code, reason) {
      // Задачи у машинной настройки нет — отказ живёт в журнале ядра: попытка сессии дойти до
      // настройки (F23) видна человеку, а не тонет в 403 без следа.
      note('config.refused', { cmdId, code, reason });
    },
  };
  return { port, dispose: stop };
}
