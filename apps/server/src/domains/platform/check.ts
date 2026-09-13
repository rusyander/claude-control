import type { PlatformProbeResult } from '@agentdeck/contracts';
import type { AppStore } from '../../lib/app-store.ts';
import type { PlatformFetch } from './ca-fetch.ts';
import { probePlatform } from './probe.ts';
import { findPlatform, requirePlatform, readToken, writePlatform } from './store.ts';

/**
 * Живая проверка контура по кнопке: сходить, запомнить итог, обновить список
 * подтверждённых возможностей.
 *
 * Проверяется и ВЫКЛЮЧЕННЫЙ контур: человек нажимает «Проверить связь» в
 * мастере, когда контур ещё не включён, и требовать сначала включить его —
 * значит требовать включить непроверенное. Фоновых проверок нет ни одной:
 * панель ходит наружу по нажатию, а не по расписанию и не при старте.
 *
 * Возможности сохраняются в самом контуре, потому что ветвление идёт по ним, а
 * не по итогу пробы: неудачная проверка НЕ стирает то, что было подтверждено
 * раньше, — «контур не ответил» и «контур больше ничего не умеет» это разные
 * вещи, и вторую панель утверждать не вправе.
 */
export async function checkPlatform(
  store: AppStore,
  appDataDir: string,
  id: string,
  fetchImpl?: PlatformFetch,
): Promise<PlatformProbeResult> {
  const platform = requirePlatform(store, id);
  const result = await probePlatform({
    platform,
    token: readToken(appDataDir, id),
    fetchImpl,
  });

  // Проба идёт до 15 с, и контур за это время мог измениться: активировали
  // другой (свой тумблер погашен), переименовали, удалили. Запись прочитанного
  // ДО пробы стёрла бы всё это и включила бы два контура разом (аудит DRV-10),
  // поэтому перечитываем и меняем ровно одно поле — возможности.
  const current = findPlatform(store, id);
  if (!current) return result;
  store.savePlatformHealth(id, result);

  if (result.outcome === 'ok') {
    // Только прочитанное в ответе: свойство платформы, известное драйверу наперёд,
    // пробой не подтверждается и выдавало бы себя за проверенное (аудит DRV-19).
    const confirmed = result.capabilities
      .filter((finding) => finding.evidence === 'answer')
      .filter((finding) => finding.state === 'yes' || finding.state === 'indirect')
      .map((finding) => finding.id);
    writePlatform(store, { ...current, capabilities: confirmed });
  }

  return result;
}
