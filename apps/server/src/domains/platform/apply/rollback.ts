import { existsSync } from 'node:fs';
import type {
  PlatformAppliedTarget,
  PlatformRollbackEntry,
  PlatformRollbackResult,
} from '@agentdeck/contracts';
import { PLATFORM_ASSISTANT_TARGET } from '@agentdeck/contracts/platform';
import { readJsonFile, writeJsonFile } from '../../../lib/safe-io.ts';
import { getProvider, isKnownProviderId } from '../../../providers/registry.ts';
import {
  readProviderEnvVars,
  resolveProviderEnvTargetFor,
  saveProviderEnvVars,
} from '../../provider-env.ts';
import { rollbackCodexEndpoint, rollbackContinueEndpoint } from './config-files.ts';
import { fingerprintOf } from './current.ts';
import { managedProfileId } from './profile.ts';
import type { ContourApplyDeps } from './plan.ts';
import { contourEntryName } from './targets.ts';

/**
 * Снятие применения: чужие файлы возвращаются в исходный вид, управляемый
 * профиль исчезает.
 *
 * Главное правило здесь — **не затирать чужую работу**. Файл, изменённый
 * человеком ПОСЛЕ применения, откат не трогает вовсе: он называется в ответе
 * (`kept`), и дальше решает человек. Отличить своё от чужого позволяет
 * отпечаток, снятый сразу после записи; по времени изменения это не отличается
 * никак — его меняет и наша собственная запись.
 *
 * Второе правило — трогается ТОТ ЖЕ файл, в который писали, по пути из следа, а
 * не по пути, который панель вычислила бы сегодня. Человек мог сменить каталог
 * конфигурации между применением и откатом, и «починить» ему при этом чужой
 * файл было бы худшим из возможных исходов.
 */

/**
 * Откату не нужна живость шлюза: он ничего не применяет, а возвращает. Оттого и
 * тип уже — снятие применения обязано работать при погашенном шлюзе, ведь
 * именно им «отключить контур» обычно и заканчивается.
 */
export type ContourRollbackDeps = Pick<ContourApplyDeps, 'store' | 'paths' | 'backupDir'>;

interface ClaudeSettingsEnv {
  env?: Record<string, string>;
  [key: string]: unknown;
}

/** Вернуть переменные Claude: наши ключи убраны, прежние значения возвращены. */
function rollbackClaudeEnv(
  filePath: string,
  previous: PlatformAppliedTarget['previous'],
  backupDir: string | undefined,
): void {
  const settings = readJsonFile<ClaudeSettingsEnv>(filePath, {});
  const env = { ...settings.env };
  for (const item of previous) {
    if (item.value === undefined) delete env[item.key];
    else env[item.key] = item.value;
  }
  settings.env = env;
  writeJsonFile(filePath, settings, { backupDir });
}

/** То же для универсального env-раздела: прочие переменные проходят насквозь. */
function rollbackProviderEnv(
  providerId: string,
  filePath: string,
  previous: PlatformAppliedTarget['previous'],
  deps: ContourRollbackDeps,
): boolean {
  const resolved = resolveProviderEnvTargetFor(getProvider(providerId), deps.paths.override);
  if (!resolved) return false;

  // Путь берётся из следа, формат — из реестра: писали мы в этот файл, а как он
  // устроен, знает только провайдер.
  const target = { ...resolved, filePath };
  const vars = new Map(readProviderEnvVars(target).map((item) => [item.key, item.value] as const));
  for (const item of previous) {
    if (item.value === undefined) vars.delete(item.key);
    else vars.set(item.key, item.value);
  }

  saveProviderEnvVars(
    target,
    [...vars.entries()].map(([key, value]) => ({ key, value })),
    deps.backupDir,
  );
  return true;
}

/**
 * Вернуть одну цель. `kept` — файл правил человек после нас; `missing` — файла
 * больше нет; `restored` — вернули.
 */
function rollbackTarget(
  trace: PlatformAppliedTarget,
  deps: ContourRollbackDeps,
  platformId: string,
  profileId: string,
): PlatformRollbackEntry {
  const entry = { targetId: trace.targetId, filePath: trace.filePath };

  if (trace.targetId === PLATFORM_ASSISTANT_TARGET) {
    const settings = deps.store.getSettings();
    // Человек мог увести ассистента на свой профиль уже после применения —
    // возвращать его «как было» значило бы отменить чужой выбор.
    if (settings.assistantEndpointId !== profileId) return { ...entry, outcome: 'kept' };
    deps.store.updateSettings({ assistantEndpointId: '' });
    return { ...entry, outcome: 'restored' };
  }

  if (!trace.filePath || !existsSync(trace.filePath)) return { ...entry, outcome: 'missing' };
  if (fingerprintOf(trace.filePath) !== trace.fingerprint) return { ...entry, outcome: 'kept' };
  if (!isKnownProviderId(trace.targetId)) return { ...entry, outcome: 'kept' };

  const provider = getProvider(trace.targetId);
  const file = provider.endpointFile;
  if (file && !provider.endpointConfig) {
    const name = contourEntryName(platformId);
    if (file.format === 'codex-toml') {
      rollbackCodexEndpoint(trace.filePath, name, trace, deps.backupDir);
    } else {
      rollbackContinueEndpoint(trace.filePath, name, trace, deps.backupDir);
    }
    return { ...entry, outcome: 'restored' };
  }

  if (trace.targetId === 'claude') {
    rollbackClaudeEnv(trace.filePath, trace.previous, deps.backupDir);
    return { ...entry, outcome: 'restored' };
  }

  const done = rollbackProviderEnv(trace.targetId, trace.filePath, trace.previous, deps);
  // Провайдер потерял раздел переменных между применением и откатом — писать
  // вслепую нельзя, и файл остаётся названным, а не молча пропущенным.
  return { ...entry, outcome: done ? 'restored' : 'kept' };
}

/**
 * Снять применение контура: файлы, ассистент, управляемый профиль, след.
 * Контур при этом остаётся — снимается применение, а не настройка.
 *
 * `targetIds` снимает ТОЧЕЧНО — одну строку журнала. Включают смелее, когда
 * видно, чем выключить, и «всё или ничего» здесь означало бы, что человек,
 * передумавший про один CLI, отменяет заодно и остальные. Пока в следе
 * остаётся хоть одна цель, управляемый профиль живёт: на него смотрят они.
 */
export function rollbackContour(
  deps: ContourRollbackDeps,
  platformId: string,
  options: { targetIds?: string[] } = {},
): PlatformRollbackResult {
  const record = deps.store.getPlatformApplied()[platformId];
  const entries: PlatformRollbackEntry[] = [];
  const wanted = options.targetIds;
  const chosen = wanted
    ? (record?.targets.filter((trace) => wanted.includes(trace.targetId)) ?? [])
    : (record?.targets ?? []);
  // Что останется в следе. Цель, которую откат НЕ ТРОНУЛ (файл правил человек
  // после нас), из следа тоже уходит: вернуть её мы уже не сможем никогда —
  // отпечаток не сойдётся, — и висящая запись обещала бы откат, которого нет.
  const rest = (record?.targets ?? []).filter((trace) => !chosen.includes(trace));

  if (record) {
    for (const trace of chosen) {
      entries.push(rollbackTarget(trace, deps, platformId, record.profileId));
    }

    // Ассистент возвращается к профилю, который стоял до контура. Делается это
    // ПОСЛЕ обхода целей: сам обход только освобождает место (ставит пусто),
    // иначе прежний выбор перезаписался бы пустотой.
    const previous = record.previousAssistantProfileId;
    const assistantRolled = chosen.some((trace) => trace.targetId === PLATFORM_ASSISTANT_TARGET);
    if (assistantRolled && previous && deps.store.getSettings().assistantEndpointId === '') {
      const exists = deps.store.getSettings().endpointProfiles.some((item) => item.id === previous);
      if (exists) deps.store.updateSettings({ assistantEndpointId: previous });
    }
  }

  // Точечный откат оставляет и след, и профиль: на него смотрят цели, которых
  // не касались.
  if (record && rest.length > 0) {
    deps.store.savePlatformApplied(platformId, { ...record, targets: rest });
    return { entries, profileRemoved: false };
  }

  // Следа нет, а профиль остался (панель падала между записями, снимок настроек
  // приехал с другой машины) — профиль всё равно уходит: он указывает на шлюз,
  // которым больше никто не управляет.
  const profileId = record?.profileId ?? managedProfileId(platformId);
  const settings = deps.store.getSettings();
  const profileRemoved = settings.endpointProfiles.some((item) => item.id === profileId);
  if (profileRemoved) {
    deps.store.updateSettings({
      endpointProfiles: settings.endpointProfiles.filter((item) => item.id !== profileId),
      // Ассистент, всё ещё смотрящий в удаляемый профиль (человек выбрал его
      // руками, а не применением), возвращается в облако вендора: молчаливо
      // неработающий ассистент хуже вернувшегося к прежнему поведению.
      ...(settings.assistantEndpointId === profileId ? { assistantEndpointId: '' } : {}),
    });
  }

  deps.store.forgetPlatformApplied(platformId);
  return { entries, profileRemoved };
}
