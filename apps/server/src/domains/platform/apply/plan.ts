import type {
  Platform,
  PlatformApplyPlan,
  PlatformApplyTarget,
  PlatformTargetConflict,
  PlatformVarPlan,
} from '@agentdeck/contracts';
import { PLATFORM_ASSISTANT_TARGET } from '@agentdeck/contracts/platform';
import type { AppStore } from '../../../lib/app-store.ts';
import { maskKey } from '../../../lib/provider-keys.ts';
import { fingerprintOf, readCurrentEnv, readCurrentFileValues } from './current.ts';
import {
  activeGatewaySettings,
  buildManagedProfile,
  gatewayUrlFor,
  managedModel,
} from './profile.ts';
import { describeContourTargets, type ContourTarget, type ContourTargetPaths } from './targets.ts';
import { listConsumerOptions } from '../routing.ts';

/**
 * Предпросмотр применения: что и куда ляжет, что уже занято, что панель уже
 * писала и что человек правил после неё. Ни одной записи здесь не происходит.
 *
 * Предпросмотр существует ради одного обещания: то, что показано, и есть то,
 * что запишется. Поэтому строки плана собираются ТЕМ ЖЕ кодом, который потом
 * пишет файл (`targets.ts`), а не вторым описанием — разойдясь однажды, они
 * превратили бы экран в художественную литературу.
 */

export interface ContourApplyDeps {
  store: AppStore;
  paths: ContourTargetPaths;
  backupDir?: string;
  /** Слушатель шлюза поднят НА САМОМ ДЕЛЕ, а не только включён в настройках. */
  gatewayRunning: boolean;
}

/**
 * Занятое место: ключ уже стоит и стоит ДРУГОЕ. Совпадающее значение конфликтом
 * не считается — это ровно то состояние, в которое приводит наше же применение,
 * и требовать за него подтверждения значило бы поднимать тревогу на пустом
 * месте.
 */
function conflictsFor(
  plan: PlatformVarPlan[],
  current: Map<string, string>,
): PlatformTargetConflict[] {
  const conflicts: PlatformTargetConflict[] = [];
  for (const item of plan) {
    const value = current.get(item.key);
    if (value === undefined || value === item.value) continue;
    conflicts.push({
      key: item.key,
      // Под заглушкой ключа стоит НАСТОЯЩИЙ ключ человека: наружу он уходит
      // маской. Инвариант «панель не отдаёт секретов» сильнее удобства.
      current: item.placeholder ? maskKey(value) : value,
      incoming: item.value,
    });
  }
  return conflicts;
}

/** Конфликт ассистента: панель уже смотрит в другой профиль, выбранный человеком. */
function assistantConflicts(store: AppStore, profileId: string): PlatformTargetConflict[] {
  const settings = store.getSettings();
  const current = settings.assistantEndpointId;
  if (!current || current === profileId) return [];
  const title = settings.endpointProfiles.find((item) => item.id === current)?.name ?? current;
  return [{ key: 'assistantEndpointId', current: title, incoming: profileId }];
}

function describeTarget(
  target: ContourTarget,
  deps: ContourApplyDeps,
  platform: Platform,
  profileId: string,
  ready: boolean,
): PlatformApplyTarget {
  const record = deps.store.getPlatformApplied()[platform.id];
  const applied = record?.targets.find((item) => item.targetId === target.targetId);

  const conflicts = !target.write
    ? []
    : target.write.kind === 'assistant'
      ? assistantConflicts(deps.store, profileId)
      : target.write.kind === 'endpoint-env'
        ? conflictsFor(target.plan, readCurrentEnv(target, deps.paths))
        : conflictsFor(target.plan, readCurrentFileValues(target, platform.id));

  // Расхождение — это «человек правил файл ПОСЛЕ нас»: отпечаток снят сразу
  // после нашей записи, и любой другой отпечаток значит чужую руку. У
  // ассистента файла нет, и расхождением там будет чужой выбор профиля.
  const drifted =
    applied === undefined
      ? false
      : target.write?.kind === 'assistant'
        ? deps.store.getSettings().assistantEndpointId !== profileId
        : fingerprintOf(target.filePath) !== applied.fingerprint;

  return {
    targetId: target.targetId,
    title: target.title,
    // Погашенный шлюз не отнимает у человека предпросмотр: строки плана
    // остаются на экране, применить их нельзя, и причина названа.
    supported: Boolean(target.write) && ready,
    ...(target.reason
      ? { reason: target.reason }
      : !ready
        ? { reason: 'gateway_down' as const }
        : {}),
    filePath: target.filePath,
    plan: target.plan,
    conflicts,
    applied: applied !== undefined,
    // Дата и копия — из следа: журнал раздела строится по нему, а не по
    // отдельной ленте, которой у контура нет.
    ...(applied ? { appliedAt: applied.appliedAt } : {}),
    ...(applied?.backupPath ? { backupPath: applied.backupPath } : {}),
    ...(drifted ? { drifted: true } : {}),
  };
}

/** Ответ `GET /api/platforms/:id/apply`. */
export function buildPlatformApplyPlan(
  deps: ContourApplyDeps,
  platform: Platform,
): PlatformApplyPlan {
  // Порт — доставшийся, а не задуманный: предпросмотр обязан показать тот же
  // адрес, который запишется в файл, и тот же, что стоит в карточке шлюза.
  const gateway = activeGatewaySettings(deps.store);
  const managed = buildManagedProfile(platform, gateway, managedModel(deps.store, platform.id));
  const ready = platform.enabled && gateway.enabled && deps.gatewayRunning;

  const targets = describeContourTargets(managed, platform.id, gateway.port, deps.paths).map(
    (target) => describeTarget(target, deps, platform, managed.id, ready),
  );

  return {
    platformId: platform.id,
    profileId: managed.id,
    baseUrl: managed.baseUrl,
    rootUrl: gatewayUrlFor(gateway.port, platform.id, 'anthropic'),
    ready,
    targets,
    // «Где работает контур» — вторая половина того же ответа: человек
    // спрашивает «что будет, если я это включу», и файлы без прогонов ответом
    // больше не являются (Т3).
    consumers: listConsumerOptions(platform),
  };
}

/** Цель по идентификатору — общая часть плана и применения. */
export function findTarget(targets: ContourTarget[], targetId: string): ContourTarget | undefined {
  return targets.find((item) => item.targetId === targetId);
}

export { PLATFORM_ASSISTANT_TARGET };
