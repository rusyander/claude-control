import type {
  EndpointProfile,
  Platform,
  PlatformApplyEntry,
  PlatformApplyResult,
  PlatformAppliedRecord,
  PlatformAppliedTarget,
  PlatformApplyTarget,
} from '@agentdeck/contracts';
import { PLATFORM_ASSISTANT_TARGET } from '@agentdeck/contracts/platform';
import type { AppStore } from '../../../lib/app-store.ts';
import { applyEndpointProfile } from '../../endpoints/endpoint-apply.ts';
import { invalidField } from '../errors.ts';
import { applyCodexEndpoint, applyContinueEndpoint, type FileWriteResult } from './config-files.ts';
import { fingerprintOf, readCurrentEnv } from './current.ts';
import {
  activeGatewaySettings,
  buildManagedProfile,
  gatewayUrlFor,
  PLACEHOLDER_KEY,
} from './profile.ts';
import { buildPlatformApplyPlan, managedModel, type ContourApplyDeps } from './plan.ts';
import {
  contourEntryName,
  describeContourTargets,
  targetProfile,
  type ContourTarget,
} from './targets.ts';

/**
 * Применение контура к выбранным целям.
 *
 * Пишется РОВНО то, что показал предпросмотр: план строк собирается тем же
 * кодом (`plan.ts` → `targets.ts`), и здесь он не пересобирается заново. Всё,
 * что цель может сделать с файлом, делают уже существующие механизмы — env
 * пишет `applyEndpointProfile` (тот же, что переносит обычный профиль
 * эндпоинта), кусок конфигурации — `config-files.ts`. Своего писателя у контура
 * нет вовсе.
 *
 * Два правила, ради которых код выглядит именно так:
 *
 * 1. **Ключ контура не уходит в чужой файл никогда.** В переменную ключа
 *    пишется заглушка (`PLACEHOLDER_KEY`), настоящий ключ подставляет шлюз. Это
 *    не «пока не сделали» — это и есть смысл конструкции: файл CLI можно
 *    показать, скопировать, залить в git, и секрета в нём нет.
 * 2. **Занятое место не перебивается молча.** Цель с конфликтом пропускается,
 *    пока человек не назвал её в `overwrite` — то есть пока он не увидел, что
 *    именно там стоит.
 */

/** Что просят применить. */
export interface ContourApplyRequest {
  /** Идентификаторы целей: `assistant` и/или провайдеры из реестра. */
  targets: string[];
  /** Цели, у которых человек ЯВНО согласился перебить занятое место. */
  overwrite?: string[];
  /**
   * Модель управляемого профиля. Пусто — CLI пойдёт со своей моделью по
   * умолчанию; выбор человека переживает пересборку плана, потому что хранится
   * в самом профиле, а не в запросе.
   */
  model?: string;
}

/**
 * Управляемый профиль в общем списке эндпоинтов: заводится или обновляется
 * ПЕРЕД первой записью в файлы. Без него ассистенту панели не на что смотреть,
 * а плану — откуда взять модель.
 */
function upsertManagedProfile(store: AppStore, platform: Platform, model: string): EndpointProfile {
  const settings = store.getSettings();
  const profile = buildManagedProfile(platform, activeGatewaySettings(store), model);
  const others = settings.endpointProfiles.filter((item) => item.id !== profile.id);
  store.updateSettings({ endpointProfiles: [...others, profile] });
  return profile;
}

/** Прежние значения ровно тех ключей, которые мы собираемся записать. */
function previousEnvValues(
  target: ContourTarget,
  deps: ContourApplyDeps,
): { key: string; value?: string }[] {
  const current = readCurrentEnv(target, deps.paths);
  return target.plan.map((item) => {
    const value = current.get(item.key);
    return { key: item.key, ...(value === undefined ? {} : { value }) };
  });
}

/** Записать одну цель. Возвращает след для отката и строку ответа. */
function writeTarget(
  target: ContourTarget,
  planned: PlatformApplyTarget,
  deps: ContourApplyDeps,
  platform: Platform,
  managed: EndpointProfile,
): { entry: PlatformApplyEntry; trace: Omit<PlatformAppliedTarget, 'appliedAt'> } {
  const write = target.write;
  const gateway = activeGatewaySettings(deps.store);

  if (!write || write.kind === 'assistant') {
    deps.store.updateSettings({ assistantEndpointId: managed.id });
    return {
      entry: { targetId: PLATFORM_ASSISTANT_TARGET, filePath: '', written: [] },
      // У ассистента нет файла, поэтому нет и отпечатка: чужую правку здесь
      // видно по самому выбору профиля, а не по содержимому.
      trace: { targetId: PLATFORM_ASSISTANT_TARGET, filePath: '', previous: [], fingerprint: '' },
    };
  }

  if (write.kind === 'endpoint-env') {
    const previous = previousEnvValues(target, deps);
    const profile = targetProfile(managed, platform.id, gateway.port, write.apiKind);
    // Токеном сюда идёт ЗАГЛУШКА — настоящего ключа этот код не видит вовсе.
    const result = applyEndpointProfile(
      profile,
      write.providerId,
      PLACEHOLDER_KEY,
      deps.paths,
      deps.backupDir,
    );
    return {
      entry: {
        targetId: target.targetId,
        filePath: result.filePath,
        written: planned.plan,
        ...(result.backupPath ? { backupPath: result.backupPath } : {}),
      },
      trace: {
        targetId: target.targetId,
        filePath: result.filePath,
        previous,
        fingerprint: fingerprintOf(result.filePath),
        ...(result.backupPath ? { backupPath: result.backupPath } : {}),
      },
    };
  }

  const name = contourEntryName(platform.id);
  const baseUrl = gatewayUrlFor(gateway.port, platform.id, write.apiKind);
  const result: FileWriteResult =
    write.file.format === 'codex-toml'
      ? applyCodexEndpoint(write.filePath, name, baseUrl, deps.backupDir)
      : applyContinueEndpoint(write.filePath, name, baseUrl, managed.model.trim(), deps.backupDir);

  return {
    entry: {
      targetId: target.targetId,
      filePath: write.filePath,
      written: planned.plan,
      ...(result.backupPath ? { backupPath: result.backupPath } : {}),
    },
    trace: {
      targetId: target.targetId,
      filePath: write.filePath,
      previous: result.previous,
      ...(result.previousRegion === undefined ? {} : { previousRegion: result.previousRegion }),
      fingerprint: fingerprintOf(write.filePath),
      ...(result.backupPath ? { backupPath: result.backupPath } : {}),
    },
  };
}

/**
 * Прежнее состояние цели берётся из ПЕРВОГО применения, а не из повторного.
 *
 * Иначе повтор записал бы в след наши же значения, и откат вернул бы файл не в
 * исходный вид, а в тот, который панель сама и сделала, — то есть не вернул бы
 * никуда.
 */
function keepFirstPrevious(
  fresh: Omit<PlatformAppliedTarget, 'appliedAt'>,
  earlier: PlatformAppliedTarget | undefined,
): Omit<PlatformAppliedTarget, 'appliedAt'> {
  if (!earlier) return fresh;
  return {
    ...fresh,
    previous: earlier.previous,
    ...(earlier.previousRegion === undefined ? {} : { previousRegion: earlier.previousRegion }),
  };
}

/**
 * Применить контур. Пишет только названные цели; неподдержанные и конфликтующие
 * возвращаются в `skipped` с причиной, а не молча пропадают.
 */
export function applyContour(
  deps: ContourApplyDeps,
  platform: Platform,
  request: ContourApplyRequest,
): PlatformApplyResult {
  const plan = buildPlatformApplyPlan(deps, platform);
  const overwrite = new Set(request.overwrite ?? []);
  const wanted = [...new Set(request.targets)];

  for (const targetId of wanted) {
    if (!plan.targets.some((item) => item.targetId === targetId)) {
      throw invalidField('targets', `панель не знает цели «${targetId}»`);
    }
  }

  const result: PlatformApplyResult = { applied: [], skipped: [] };
  const write: string[] = [];
  for (const targetId of wanted) {
    const planned = plan.targets.find((item) => item.targetId === targetId)!;
    if (!planned.supported) {
      result.skipped.push({ targetId, reason: planned.reason ?? 'gateway_down' });
      continue;
    }
    if (planned.conflicts.length > 0 && !overwrite.has(targetId)) {
      result.skipped.push({ targetId, reason: 'conflict' });
      continue;
    }
    write.push(targetId);
  }

  if (write.length === 0) return result;

  // Модель: явно присланная выигрывает у хранимой, хранимая — у пустой. Профиль
  // заводится ДО записи в файлы, потому что цели берут из него адрес и модель.
  const model = request.model?.trim() ?? managedModel(deps.store, platform.id);
  const managed = upsertManagedProfile(deps.store, platform, model);

  const earlier = deps.store.getPlatformApplied()[platform.id];
  const gatewayPort = activeGatewaySettings(deps.store).port;
  const targets = describeContourTargets(managed, platform.id, gatewayPort, deps.paths);
  const traces: PlatformAppliedTarget[] = (earlier?.targets ?? []).filter(
    (item) => !write.includes(item.targetId),
  );
  const appliedAt = new Date().toISOString();
  const assistantWritten = write.includes(PLATFORM_ASSISTANT_TARGET);
  const previousAssistant =
    earlier?.targets.some((item) => item.targetId === PLATFORM_ASSISTANT_TARGET) === true
      ? earlier.previousAssistantProfileId
      : deps.store.getSettings().assistantEndpointId;

  const save = (): void => {
    const record: PlatformAppliedRecord = {
      platformId: platform.id,
      profileId: managed.id,
      targets: traces,
      ...(assistantWritten && previousAssistant && previousAssistant !== managed.id
        ? { previousAssistantProfileId: previousAssistant }
        : {}),
    };
    deps.store.savePlatformApplied(platform.id, record);
  };

  try {
    for (const targetId of write) {
      const target = targets.find((item) => item.targetId === targetId)!;
      const planned = plan.targets.find((item) => item.targetId === targetId)!;
      const written = writeTarget(target, planned, deps, platform, managed);
      traces.push({
        ...keepFirstPrevious(
          written.trace,
          earlier?.targets.find((item) => item.targetId === targetId),
        ),
        appliedAt,
      });
      result.applied.push(written.entry);
    }
  } finally {
    // Отказ на четвёртой цели не отменяет трёх записанных: след сохраняется в
    // любом случае, иначе откат не знал бы о них и оставил бы файлы правлеными.
    save();
  }

  return result;
}
