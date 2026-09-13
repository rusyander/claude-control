import type {
  Platform,
  PlatformActivationResult,
  PlatformProbeResult,
  PlatformRollbackResult,
  PlatformSmokeResult,
} from '@agentdeck/contracts';
import type { AppStore } from '../../lib/app-store.ts';
import type { PlatformFetch } from './ca-fetch.ts';
import { checkPlatform } from './check.ts';
import { driverOf } from './drivers/index.ts';
import { contourUrl } from './transport.ts';
import { rollbackContour, type ContourRollbackDeps } from './apply/rollback.ts';
import { findPlatform, readPlatforms, requirePlatform, writePlatforms } from './store.ts';
import { catalogDefaultModel } from '@agentdeck/contracts/platform-models';
import { PLATFORM_TERMINAL_CONSUMER } from '@agentdeck/contracts/platform-consumers';
import { modelRulesFor } from './models.ts';

/**
 * Активный контур: не режим одной карточки, а режим приложения (Р3).
 *
 * ПОЧЕМУ ЭТО ТРАНЗАКЦИЯ, А НЕ ФЛАГ. Включённых контуров раньше могло быть
 * несколько, и «через какой из них пошла работа» становилось вопросом с тремя
 * ответами: адрес в конфиге CLI, тумблер контура и профиль ассистента. Активация
 * сводит их в один: применения прежнего контура снимаются, его тумблер гаснет,
 * новый становится единственным включённым — и всё это либо происходит целиком,
 * либо не происходит вовсе (инвариант 1).
 *
 * ПОЧЕМУ ПРОБА И ПРОБНЫЙ ЗАПРОС СНАРУЖИ ТРАНЗАКЦИИ. Они ходят в сеть, и красный
 * ответ активацию НЕ отменяет: человек видит причину и решает сам, а молчаливый
 * откат спрятал бы диагноз — ключ кончился, шлюз погашен, модель не отвечает
 * лечатся в разных местах и разными людьми.
 *
 * ПОЧЕМУ ПРОБНЫЙ ЗАПРОС ИДЁТ ЧЕРЕЗ СВОЙ ЖЕ ШЛЮЗ. Прямой запрос в контур
 * доказывает, что жив адрес и принят ключ, — это уже сделала проба. Всё
 * остальное, чем отличается работа CLI (перевод диалекта, подстановка ключа,
 * защита данных, разбор потока, учёт расхода), стоит МЕЖДУ CLI и контуром, и
 * проверить его можно только пройдя этот путь целиком.
 */

/**
 * Потолок ответа. Вопрос просит одно слово, но reasoning-модель тратит токены на
 * размышления ДО него, и восьми не хватало ни на что: здоровый контур получал
 * красную карточку «модель промолчала» (аудит DRV-11). Потолок денег не стоит —
 * модель, сказавшая слово, останавливается сама.
 */
export const SMOKE_MAX_TOKENS = 256;

/**
 * Потолок ожидания пробного запроса. Меньше, чем у пробы: модель, которая
 * думает над словом «готов» полминуты, ответит человеку так же, и узнать об
 * этом лучше здесь.
 */
export const SMOKE_TIMEOUT_MS = 30_000;

export interface ContourActivationDeps extends ContourRollbackDeps {
  appDataDir: string;
  /**
   * Транспорт ПРОБЫ — того запроса, который идёт прямо в контур. По умолчанию
   * свой, знающий про корневой сертификат компании.
   */
  probeFetch?: PlatformFetch;
  /**
   * Транспорт ПРОБНОГО ЗАПРОСА — того, который идёт в свой же шлюз на
   * 127.0.0.1. Разделены намеренно: подставить сюда ту же заглушку, что и в
   * пробу, значит проверить заглушку вместо шлюза, а весь смысл пробного
   * запроса — в том, что он проходит настоящий сокет и настоящий конвейер.
   * По умолчанию — глобальный `fetch`: до самого себя корневой сертификат
   * компании отношения не имеет.
   */
  smokeFetch?: PlatformFetch;
  /**
   * Порт ЖИВОГО слушателя. Спрашивается функцией, а не берётся из состояния:
   * записанный там порт — след прошлого запуска, и панель, убитая без
   * обработчиков (для `node --watch` на Windows это обычное дело), оставляет его
   * в файле. Пробный запрос ушёл бы тогда тому процессу, который занял порт
   * после неё.
   */
  gatewayPort?: () => number;
  now?: () => Date;
}

/**
 * Сделать контур активным.
 *
 * Возвращает и то, что сняли с прежнего, и оба сетевых итога: карточка
 * показывает их рядом, потому что «активировали, но модель молчит» — это одно
 * состояние, а не два сообщения в разных углах экрана.
 */
export async function activatePlatform(
  deps: ContourActivationDeps,
  id: string,
): Promise<PlatformActivationResult> {
  const { store } = deps;
  const platform = requirePlatform(store, id);
  const previousId = store.getSettings().activePlatformId;

  const rollback = runActivationTransaction(deps, platform, previousId);

  // Дальше — сеть. Всё, что ниже, активацию уже не отменяет — и не вправе
  // отказать за неё. Отказ отсюда уехал бы наверх как отказ ВСЕЙ активации, а
  // человек прочитал бы «панель не записала ни одного изменения» про запись,
  // которая уже состоялась (сертификат контура исчез с диска после сохранения,
  // ключ не расшифровался, диск не принял пробный запрос). Причина обязана
  // приехать состоянием карточки, а не пустым экраном.
  const { probe, smoke } = await probeAfterActivation(deps, platform);

  return {
    activePlatformId: id,
    previousPlatformId: previousId === id ? '' : previousId,
    ...(rollback ? { rollback } : {}),
    probe,
    smoke,
  };
}

/**
 * Сетевая половина активации: проба, пробный запрос и их запись. Ни один отказ
 * отсюда не поднимается выше — он превращается в красную пробу с причиной.
 */
async function probeAfterActivation(
  deps: ContourActivationDeps,
  platform: Platform,
): Promise<{ probe: PlatformProbeResult; smoke: PlatformSmokeResult }> {
  const { store } = deps;
  const now = deps.now ?? (() => new Date());
  try {
    const probe = await checkPlatform(store, deps.appDataDir, platform.id, deps.probeFetch);
    const smoke = await smokePlatform(deps, platform, probe);
    // Контур могли удалить, пока шли эти два запроса: запись итога вернула бы в
    // состояние строку о том, чего больше нет, и убрать её было бы некому.
    if (readPlatforms(store).some((item) => item.id === platform.id)) {
      store.savePlatformSmoke(platform.id, smoke);
    }
    return { probe, smoke };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const at = now().toISOString();
    return {
      probe: {
        outcome: 'unreachable',
        reachable: false,
        url: contourUrl(platform, 'models') ?? platform.baseUrl,
        detail,
        models: [],
        capabilities: [],
        limits: {},
        notes: [],
        compromises: [],
        checkedAt: at,
      },
      smoke: { ok: false, model: '', answer: '', latencyMs: 0, at, detail },
    };
  }
}

/**
 * Записать активность: снять применения прежнего контура, погасить чужие
 * тумблеры, зажечь свой. Либо всё, либо ничего.
 *
 * Снимок состояния и возврат к нему — самый честный способ сдержать это
 * обещание здесь: писателей в состоянии несколько (настройки, след применения,
 * профиль ассистента), и «отменить» каждого по отдельности значило бы завести
 * второй, обратный, набор ошибок. Внутри нет ни одного `await` намеренно: пока
 * транзакция идёт, никакой другой запрос в состояние не пишет.
 *
 * Файлы чужих CLI откат уже трогал — их возврат снимком не отменить. Это не
 * дыра: восстановленный след применения снова обещает откат, а цель, которую
 * откат успел вернуть, отличится по отпечатку и приедет в ответ как `kept`.
 */
function runActivationTransaction(
  deps: ContourActivationDeps,
  platform: Platform,
  previousId: string,
): PlatformRollbackResult | undefined {
  const { store } = deps;
  const snapshot = store.exportState();

  try {
    const rollback =
      previousId && previousId !== platform.id ? rollbackContour(deps, previousId) : undefined;
    writePlatforms(store, exclusiveEnabled(store, platform.id));
    store.updateSettings({ activePlatformId: platform.id });
    return rollback;
  } catch (error) {
    store.importState(snapshot);
    throw error;
  }
}

/**
 * Вернуть провайдер по умолчанию: применения снимаются, тумблер гаснет, поле
 * активного контура пустеет.
 *
 * Один маршрут на две кнопки — на карточке контура и в строке провайдера:
 * «вернуть как было» это одно действие, и два его исполнения разошлись бы в
 * первый же месяц.
 */
export function deactivatePlatform(
  deps: ContourActivationDeps,
  id: string,
): PlatformRollbackResult {
  const { store } = deps;
  requirePlatform(store, id);
  const snapshot = store.exportState();

  try {
    const rollback = rollbackContour(deps, id);
    writePlatforms(
      store,
      readPlatforms(store)
        .filter((item) => item.id === id && item.enabled)
        .map((item) => ({ ...item, enabled: false })),
    );
    if (store.getSettings().activePlatformId === id) {
      store.updateSettings({ activePlatformId: '' });
    }
    return rollback;
  } catch (error) {
    store.importState(snapshot);
    throw error;
  }
}

/** Контуры, у которых тумблер меняется: названный зажигается, остальные гаснут. */
function exclusiveEnabled(store: AppStore, id: string): Platform[] {
  return readPlatforms(store)
    .filter((item) => item.enabled !== (item.id === id))
    .map((item) => ({ ...item, enabled: item.id === id }));
}

/**
 * Свести пару «активный контур ↔ тумблеры» к инварианту 1.
 *
 * Зовётся при старте и ПОСЛЕ КАЖДОГО ЧУЖОГО ПИСАТЕЛЯ настроек — импорта снимка
 * и распаковки архива переноса: оба приносят список контуров с чужой машины,
 * где активным был другой, и пишут тумблеры как есть. Без сведения панель
 * называла бы контур неактивным, а шлюз продолжал бы его обслуживать —
 * расхождение, которое человеку видно только по работе CLI.
 *
 * Две развилки:
 *   · поле активного контура ПУСТО (или названного контура больше нет) —
 *     работает перенос: активным становится ПЕРВЫЙ включённый, порядок списка
 *     человек задал сам, а выбирать по другому признаку («последний
 *     проверенный», «с самым свежим ключом») значило бы угадывать;
 *   · поле названо — оно и есть истина, остальные тумблеры гаснут.
 *
 * В обоих случаях гаснущие контуры НАЗЫВАЮТСЯ вслух разовым рассказом: ключи,
 * бюджеты и применения при них, но работа идёт не через них, и молчание об этом
 * человек заметил бы только по 502 у своего CLI.
 */
export function reconcileActivePlatform(store: AppStore): void {
  const platforms = readPlatforms(store);
  const named = store.getSettings().activePlatformId;
  const active = platforms.some((item) => item.id === named) ? named : '';

  if (!active) {
    // Названного контура больше нет — поле чистим до переноса, иначе оно
    // осталось бы указывать в пустоту.
    if (named) store.updateSettings({ activePlatformId: '' });
    const enabled = platforms.filter((platform) => platform.enabled);
    const first = enabled[0];
    if (!first) return;
    writePlatforms(store, exclusiveEnabled(store, first.id));
    store.updateSettings({ activePlatformId: first.id });
    tellAboutDisabled(store, first, enabled.slice(1));
    return;
  }

  const disabled = platforms.filter((item) => item.enabled && item.id !== active);
  const changed = exclusiveEnabled(store, active);
  if (changed.length === 0) return;
  writePlatforms(store, changed);
  tellAboutDisabled(store, platforms.find((item) => item.id === active) as Platform, disabled);
}

/**
 * Рассказ пишется только тогда, когда было ЧТО решать за человека. Один
 * включённый контур стал активным — это тот же контур в том же состоянии, и
 * сообщение о нём было бы сообщением ни о чём.
 */
function tellAboutDisabled(store: AppStore, active: Platform, others: Platform[]): void {
  if (others.length === 0) return;
  store.setPlatformActivationNotice({
    activatedId: active.id,
    activatedTitle: active.title,
    others: others.map((platform) => platform.title),
  });
}

/**
 * Пробный запрос через собственный шлюз тем же маршрутом, которым пойдёт Claude
 * Code (`/v1/messages`, поток).
 *
 * Ответ ВСЕГДА возвращается, а не бросается: «шлюз погашен», «модели нет» и
 * «модель молчит» — состояния карточки с причиной, а не сбой панели.
 */
export async function smokePlatform(
  deps: ContourActivationDeps,
  platform: Platform,
  probe: PlatformProbeResult,
): Promise<PlatformSmokeResult> {
  const now = deps.now ?? (() => new Date());
  const at = now().toISOString();
  const model = smokeModel(deps.store, platform, probe);
  const empty = { ok: false, model, answer: '', latencyMs: 0, at };

  if (!model) {
    return { ...empty, detail: 'Контур не назвал ни одной модели: спрашивать нечем.' };
  }

  // Порт спрашивается у ЖИВОГО слушателя, а не у настроек и не у записанного
  // прошлым запуском: задуманный мог быть занят, а записанный мог остаться от
  // панели, которую убили без обработчиков, — в обоих случаях запрос ушёл бы
  // тому процессу, который держит порт сейчас.
  const port = deps.gatewayPort ? deps.gatewayPort() : 0;
  if (port <= 0) {
    return {
      ...empty,
      detail: 'Шлюз не поднят: пробный запрос идёт через него, как и работа CLI.',
    };
  }

  const fetchImpl = deps.smokeFetch ?? (globalThis.fetch as PlatformFetch);
  const started = Date.now();
  try {
    const response = await fetchImpl(`http://127.0.0.1:${port}/${platform.id}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        max_tokens: SMOKE_MAX_TOKENS,
        stream: true,
        messages: [{ role: 'user', content: driverOf(platform).smokePrompt }],
      }),
      signal: AbortSignal.timeout(SMOKE_TIMEOUT_MS),
    });

    const latencyMs = Date.now() - started;
    const body = await readAll(response);
    if (!response.ok) {
      return { ...empty, latencyMs, detail: refusalText(body, response.status) };
    }

    const { answer, stopReason } = collectAnswer(body);
    if (answer) return { ok: true, model, answer, latencyMs, at };
    // Пустой ответ на просьбу сказать одно слово — не успех: путь прошёл, а
    // модель промолчала, и списать это на «наверное, всё хорошо» значит выдать
    // зелёную карточку неработающей связке. Но «упёрлась в потолок» и «ответила
    // пустотой» лечатся по-разному, и первое называется отдельно.
    return {
      ...empty,
      latencyMs,
      detail:
        stopReason === 'max_tokens'
          ? `Модель израсходовала потолок пробного запроса (${SMOKE_MAX_TOKENS} токенов), не сказав ни слова, — похоже, всё ушло в размышления. Путь прошёл; у рабочих запросов потолок выше.`
          : 'Модель не сказала ни слова: путь прошёл, ответа нет.',
    };
  } catch (error) {
    const latencyMs = Date.now() - started;
    const name = error instanceof Error ? error.name : '';
    if (name === 'TimeoutError' || name === 'AbortError') {
      return {
        ...empty,
        latencyMs,
        detail: `Ответа не было ${SMOKE_TIMEOUT_MS / 1_000} с — столько же прождёт и CLI.`,
      };
    }
    return {
      ...empty,
      latencyMs,
      detail: `Шлюз не ответил: ${error instanceof Error ? error.message : String(error)}.`,
    };
  }
}

/**
 * Чем спрашивать — ТЕМ ЖЕ правилом, которым пойдёт CLI в терминале
 * (`modelRulesFor`): его модель, иначе модель контура, иначе первая ЧАТОВАЯ
 * модель каталога. Первая модель списка как есть уводила пробный запрос в
 * эмбеддинг — контур отдаёт их одним списком с чатом (аудит DRV-11). Контур
 * перечитывается: пока шла проба, модель могли поменять.
 */
function smokeModel(store: AppStore, platform: Platform, probe: PlatformProbeResult): string {
  const current = findPlatform(store, platform.id) ?? platform;
  const rules = modelRulesFor(store, current, PLATFORM_TERMINAL_CONSUMER);
  return rules.model || (catalogDefaultModel(probe.models)?.id ?? '');
}

/** Текст отказа шлюза — его же словами: он их и писал по-русски. */
function refusalText(body: string, status: number): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown } };
    const message = parsed.error?.message;
    if (typeof message === 'string' && message) return `${message} (${status}).`;
  } catch {
    // Не JSON — ниже общий текст: тело чужого отказа на экран не выносим.
  }
  return `Шлюз ответил ${status}.`;
}

/** Собрать ответ из кадров потока Anthropic: текст и причину остановки. */
function collectAnswer(body: string): { answer: string; stopReason: string } {
  let answer = '';
  let stopReason = '';
  for (const line of body.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const raw = line.slice('data:'.length).trim();
    if (!raw || raw === '[DONE]') continue;
    try {
      const frame = JSON.parse(raw) as { delta?: { text?: unknown; stop_reason?: unknown } };
      if (typeof frame.delta?.text === 'string') answer += frame.delta.text;
      if (typeof frame.delta?.stop_reason === 'string') stopReason = frame.delta.stop_reason;
    } catch {
      // Кадр, который не разобрался, — не причина терять остальные.
    }
  }
  return { answer: answer.trim().replace(/\s+/g, ' '), stopReason };
}

/** Тело ответа целиком: поток здесь короткий по построению (потолок `SMOKE_MAX_TOKENS`). */
async function readAll(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}
