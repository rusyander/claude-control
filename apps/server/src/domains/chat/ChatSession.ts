import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeJsonFile } from '../../lib/safe-io.ts';
import type { ChatRunRegistry } from './ChatRunRegistry.ts';
import {
  PermissionBroker,
  type PermissionRequest,
  type ChatPermissionReply,
} from './ChatPermissions.ts';

/**
 * Живое состояние прав в разговорах: брокер интерактивных запросов плюс
 * автоподтверждение по прогонам.
 *
 * Состояние заводится на КАЖДЫЙ сервер, а не на модуль: два сервера в одном
 * процессе (так поднимаются тесты) не должны видеть чужие висящие запросы и
 * чужие тумблеры. Один сервер держит ОДИН объект на все маршруты чата:
 * продолжение в чистой сессии заводит прогоны мимо маршрута отправки, и
 * тумблеры у них должны быть те же.
 *
 * Ключи — канонические (`registry.resolveKey`): один разговор приходит и как
 * временный `new-…`, и как sessionId, а тумблер, щёлкнутый во вкладке, знающей
 * разговор по sessionId, обязан достать прогон, поднятый под `new-…`. Иначе
 * запрос прав искал состояние по одному написанию, а щелчок клал его под
 * другое — и тумблер «не действовал». Исключение — `armAutoApprove`: он идёт
 * ДО регистрации прогона, и его ключ — тот, под которым прогон будет заведён.
 */

/**
 * Сколько разговоров помнится тумблерами. Карта живёт в памяти процесса, растёт
 * по строке на прогон и читается только по ключу — предел нужен ей от
 * бесконечного роста, а не ради свежести: запись законченного прогона обязана
 * пережить паузу, пока человек думает над карточкой разделения.
 */
const MAX_TOGGLES = 200;

/** Положение тумблеров разговора на время прогона. */
export interface AutoApproveState {
  enabled: boolean;
  /** Правки файлов в настоящем проекте разрешены. */
  allowEdits: boolean;
  /**
   * Пришло от родителя разделения или из глобальной настройки `chatAutoMode`, а
   * не взведено человеком в этом чате: строки вкладки «Группы» такому тумблеру
   * не уступают (итоговое ревью 25.09, M3).
   */
  inherited?: true;
}

/**
 * Файл тумблеров в каталоге данных панели. Свой, а не `state.json` и не журнал
 * прогонов: журнал держит только ИДУЩИЕ прогоны, а тумблер нужен родителю, чей
 * прогон давно кончился, — дети разделения заводятся тогда, когда человек
 * прочитал карточку, и между этим панель успевает перезапуститься.
 */
export const TOGGLES_FILE = 'chat-toggles.json';

/**
 * Авторежим, выбранный человеком в чате, — отдельным файлом от тумблеров
 * прогона. Тумблер прогона снимается остановкой (`abort`), а выбор «в этом чате
 * без авторежима» остановку переживать обязан: иначе после «Стоп» чат молча
 * вернулся бы к глобальной настройке.
 */
export const AUTO_MODE_FILE = 'chat-auto-mode.json';

/** Сколько чатов помнят свой выбор авторежима: это настройка, а не след прогона. */
const MAX_OVERRIDES = 1000;

/** Прочитать выборы авторежима. Нет файла или он битый — все чаты идут за глобальной. */
function readOverrides(path: string): Map<string, boolean> {
  const saved = new Map<string, boolean>();
  if (!existsSync(path)) return saved;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return saved;
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'boolean') saved.set(key, value);
    }
  } catch {
    // Без файла чат идёт за глобальной настройкой — это и есть поведение по умолчанию.
  }
  return saved;
}

function isState(value: unknown): value is AutoApproveState {
  if (!value || typeof value !== 'object') return false;
  const state = value as Record<string, unknown>;
  return typeof state.enabled === 'boolean' && typeof state.allowEdits === 'boolean';
}

/** Прочитать файл тумблеров. Нет его или он битый — пустая память, без крика. */
function readToggles(path: string): Map<string, AutoApproveState> {
  const saved = new Map<string, AutoApproveState>();
  if (!existsSync(path)) return saved;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return saved;
    for (const [key, state] of Object.entries(parsed)) {
      if (!isState(state)) continue;
      saved.set(key, {
        enabled: state.enabled,
        allowEdits: state.allowEdits,
        ...(state.inherited === true ? { inherited: true } : {}),
      });
    }
  } catch {
    // Тумблеры — удобство, а не данные человека: без файла панель спросит
    // карточкой, как спрашивала до него.
  }
  return saved;
}

export class ChatSession {
  private readonly permissions = new PermissionBroker();

  /**
   * Автоподтверждение прав по разговорам: ключ тот же, под которым прогон
   * зарегистрирован у брокера прав (chatId из запроса на отправку). Состояние
   * живёт в памяти прогона: тумблер в шапке чата присылают и при отправке, и
   * отдельным запросом, когда его щёлкнули на ходу.
   */
  private readonly autoApprove = new Map<string, AutoApproveState>();

  private readonly registry: ChatRunRegistry;

  /**
   * Тумблеры на диске — по обоим написаниям ключа (`new-…` и sessionId): после
   * перезапуска реестр синонимов не помнит, а родителя спрашивают по sessionId.
   * Память выше — рабочая копия, это — то, что переживает перезапуск.
   */
  private readonly saved: Map<string, AutoApproveState>;

  private readonly togglesPath?: string;

  /** Выбор авторежима по чатам — по всем известным ключам разговора. */
  private readonly overrides: Map<string, boolean>;

  private readonly overridesPath?: string;

  /** `appDataDir` — каталог данных панели; нет — тумблеры живут только в памяти (тесты). */
  constructor(registry: ChatRunRegistry, appDataDir?: string) {
    this.registry = registry;
    this.togglesPath = appDataDir ? join(appDataDir, TOGGLES_FILE) : undefined;
    this.saved = this.togglesPath ? readToggles(this.togglesPath) : new Map();
    this.overridesPath = appDataDir ? join(appDataDir, AUTO_MODE_FILE) : undefined;
    this.overrides = this.overridesPath ? readOverrides(this.overridesPath) : new Map();
  }

  /**
   * Авторежим, выбранный человеком в этом чате; `undefined` — не выбирал, чат
   * идёт за глобальной настройкой `chatAutoMode`. Ключей у разговора несколько
   * (`new-…`, sessionId) — годится любой.
   */
  autoModeOverride(...keys: (string | undefined)[]): boolean | undefined {
    for (const key of keys) {
      if (!key) continue;
      const hit = this.overrides.get(this.registry.resolveKey(key)) ?? this.overrides.get(key);
      if (hit !== undefined) return hit;
    }
    return undefined;
  }

  /**
   * Запомнить выбор авторежима в чате (`undefined` — забыть, чат снова идёт за
   * глобальной). Пишется под всеми ключами разговора: после перезапуска реестр
   * синонимов не помнит, а вкладка спросит тем ключом, который знает она.
   */
  setAutoModeOverride(chatId: string, enabled: boolean | undefined): void {
    const key = this.registry.resolveKey(chatId);
    const sessionId = this.registry.describe(key)?.sessionId;
    for (const name of new Set([chatId, key, ...(sessionId ? [sessionId] : [])])) {
      this.overrides.delete(name);
      if (enabled !== undefined) this.overrides.set(name, enabled);
    }
    for (const oldest of this.overrides.keys()) {
      if (this.overrides.size <= MAX_OVERRIDES) break;
      this.overrides.delete(oldest);
    }
    if (!this.overridesPath) return;
    try {
      writeJsonFile(this.overridesPath, Object.fromEntries(this.overrides));
    } catch {
      // Отказ диска не должен ронять ни отправку, ни щелчок тумблера.
    }
  }

  /** Записать тумблер разговора на диск — под ключом и под его sessionId, если он известен. */
  private remember(key: string, state: AutoApproveState | undefined): void {
    if (!this.togglesPath) return;
    const sessionId = this.registry.describe(key)?.sessionId;
    for (const name of sessionId && sessionId !== key ? [key, sessionId] : [key]) {
      // Удалить и положить заново — свежая запись уходит в конец очереди на вытеснение.
      this.saved.delete(name);
      if (state) this.saved.set(name, { ...state });
    }
    for (const oldest of this.saved.keys()) {
      if (this.saved.size <= MAX_TOGGLES) break;
      this.saved.delete(oldest);
    }
    try {
      writeJsonFile(this.togglesPath, Object.fromEntries(this.saved));
    } catch {
      // Отказ диска не должен ронять ни отправку, ни щелчок тумблера.
    }
  }

  /**
   * Снимок тумблеров для журнала прогонов (`registry.setLedger`). Реестр пишет
   * журнал на старте и на смене ключа — в этот момент прогон впервые знает свой
   * sessionId, и тумблер ложится на диск и под ним: иначе после перезапуска
   * родителя, взведённого под `new-…`, по sessionId было бы не найти.
   */
  snapshotForLedger(key: string): AutoApproveState | undefined {
    const state = this.autoApprove.get(key);
    if (state) this.remember(key, state);
    // Выбор авторежима — туда же и тем же приёмом: чат, заведённый под `new-…`,
    // после перезапуска спрашивают по sessionId.
    const override = this.autoModeOverride(key);
    if (override !== undefined) this.setAutoModeOverride(key, override);
    return state;
  }

  /**
   * Положение тумблеров на этот прогон. Заодно выбрасываем записи прогонов,
   * которые уже не идут: иначе карта копила бы по строчке на каждый разговор.
   */
  armAutoApprove(chatId: string, state: AutoApproveState): void {
    this.autoApprove.set(chatId, state);
    this.remember(chatId, state);
    // Раньше здесь выбрасывались записи всех незапущенных прогонов. Чистило это
    // и родителя, чьё разделение человек ещё не подтвердил: достаточно было
    // написать в соседний чат — и дети веера заводились без тумблера. Карте
    // хватает предела: она не растёт, а память о законченном прогоне живёт
    // столько, сколько человек думает над карточкой.
    for (const key of this.autoApprove.keys()) {
      if (this.autoApprove.size <= MAX_TOGGLES) break;
      this.autoApprove.delete(key);
    }
  }

  /**
   * Тумблер автоподтверждения, щёлкнутый во время прогона. Права на правки
   * берём из уже идущего прогона: их задаёт другой тумблер.
   */
  toggleAutoApprove(chatId: string, enabled: boolean): void {
    const key = this.registry.resolveKey(chatId);
    const current = this.autoApproveFor(chatId);
    // Щелчок — решение человека в этом чате: метка наследования снимается, и
    // выбор становится настройкой чата сильнее глобальной (`chatAutoMode`).
    const state = { enabled, allowEdits: current?.allowEdits ?? false };
    this.autoApprove.set(key, state);
    this.setAutoModeOverride(chatId, enabled);
    // Новое положение — и в журнал на диске: усыновлённый после перезапуска
    // прогон должен молчать ровно там, где молчал до него.
    this.registry.persist(key);
    this.remember(key, state);
  }

  /**
   * Положение тумблеров разговора; нет записи — прогон не наш. Память прогона
   * первой, диск — когда её нет: после перезапуска там лежит последнее
   * положение, в каком бы написании ключа о разговоре ни спросили.
   */
  autoApproveFor(chatId: string): AutoApproveState | undefined {
    const key = this.registry.resolveKey(chatId);
    return this.autoApprove.get(key) ?? this.saved.get(key) ?? this.saved.get(chatId);
  }

  /**
   * Унаследовать тумблеры закрытого разговора новым — продолжение в чистой
   * сессии. Иначе цепочка, начатая с автоподтверждением, на первом же запросе
   * прав в новом чате вставала ждать человека, который её как раз и не смотрит.
   * Ключей закрытого разговора может быть два (см. выше) — берём первый живой.
   * `fromParent` — наследует группа разделения от родителя: тумблер помечается
   * унаследованным, и строки вкладки «Группы» решают сами. Звено внутри группы
   * метку источника сохраняет.
   */
  inherit(fromKeys: string[], to: string, fromParent = false): void {
    // Выбор авторежима — продолжению того же разговора, но не группе: выбор
    // человека в родителе — не решение про группу, её ведут строки «Групп».
    const override = fromParent ? undefined : this.autoModeOverride(...fromKeys);
    if (override !== undefined) this.setAutoModeOverride(to, override);
    for (const key of fromKeys) {
      const state = this.autoApproveFor(key);
      if (!state) continue;
      const next = fromParent ? { ...state, inherited: true as const } : { ...state };
      this.autoApprove.set(to, next);
      this.remember(to, next);
      return;
    }
  }

  /**
   * Остановка разговора: висящие запросы прав отклоняем (иначе агент ждал бы
   * решения зря) и снимаем автоподтверждение.
   */
  abort(chatId: string): void {
    const key = this.registry.resolveKey(chatId);
    this.permissions.cancelRun(key);
    this.autoApprove.delete(key);
    // И с диска: иначе остановленный разговор после перезапуска снова молчал бы.
    this.remember(key, undefined);
    if (chatId !== key) this.remember(chatId, undefined);
    // Ответ «писать здесь» жил ровно этот прогон: следующий начинается снова в
    // основной копии, и молчать о ветке ему не с чего.
    this.branchGateSettled.delete(key);
  }

  /**
   * Прогоны, где ворота ветки уже отработали: человек ответил «писать здесь».
   * Спрашивать второй раз нечего — он сказал это про весь прогон, а не про один
   * файл, и карточка на каждую следующую правку была бы ровно тем, от чего
   * уходили. Копия сюда не пишется намеренно: после переезда прогон идёт в ней,
   * а там ворота молчат сами (`isMainWorkingCopy` уже ложь).
   */
  private readonly branchGateSettled = new Set<string>();

  /** Человек решил писать в основной копии — до конца этого прогона. */
  settleBranchGate(chatId: string): void {
    const key = this.registry.resolveKey(chatId);
    this.branchGateSettled.add(key);
    // Тот же предел и по той же причине, что у тумблеров: карта живёт в памяти
    // процесса и читается только по ключу.
    for (const oldest of this.branchGateSettled) {
      if (this.branchGateSettled.size <= MAX_TOGGLES) break;
      this.branchGateSettled.delete(oldest);
    }
  }

  /** Отработали ли уже ворота ветки в этом прогоне. */
  isBranchGateSettled(chatId: string): boolean {
    return this.branchGateSettled.has(this.registry.resolveKey(chatId));
  }

  /** Запросить решение пользователя; ждёт клика в интерфейсе. */
  requestPermission(request: PermissionRequest): Promise<ChatPermissionReply> {
    return this.permissions.request(request);
  }

  /** Ответить на запрос (клик пользователя). false — если запрос уже снят. */
  decidePermission(runId: string, toolUseId: string, reply: ChatPermissionReply): boolean {
    return this.permissions.decide(this.registry.resolveKey(runId), toolUseId, reply);
  }
}
