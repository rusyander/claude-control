import { createHash } from 'node:crypto';
import { landsAtTarget } from '@agentdeck/contracts/portable-emit';
import {
  envItemFingerprintInput,
  type AgentEnvironment,
  type EnvItemKind,
  type EnvScope,
} from '@agentdeck/contracts/portable-env';
import type {
  EnvSubscription,
  SubscriptionDrift,
  SubscriptionRow,
  SubscriptionSyncPlan,
} from '@agentdeck/contracts/portable-subscribe';
import type { TransferFileRecord } from '@agentdeck/contracts/portable-transfer';
import type { ConfigProvider } from '../../providers/types.ts';
import type { EmitDeps, EmitWrite } from './emit/types.ts';
import { buildTransferPlan } from './plan.ts';

/**
 * Подписка: пересобрать у цели то, что разошлось с каноном (П5.1).
 *
 * Модуль не пишет в файлы и не читает состояние панели — он считает РЕШЕНИЕ:
 * какие записи разошлись и какие правки из-за этого поедут. Запись делает
 * `apply.ts` теми же правками, что и разовый перенос, а память подписки живёт в
 * срезе состояния. Своего пути записи у подписки нет намеренно: второй путь
 * разошёлся бы с первым в резервных копиях и откате — там, где это заметно
 * только на потерянном файле.
 *
 * Отпечаток считается ЗАПИСЬ ЗА ЗАПИСЬЮ, а отбираются ПРАВКИ. Разница не
 * косметическая: у цели записи сливаются в файл, и правка либо пишется со всеми
 * своими записями, либо не пишется вовсе (см. `TransferWriteFilter`).
 */

/**
 * Длина отпечатка записи — 16 шестнадцатеричных цифр от SHA-256.
 *
 * Полный хеш дал бы 64 символа на запись, а память подписки хранит их все: у
 * живого дома это 208 записей, то есть мегабайты в файле состояния за
 * следующие годы. 64 бита против случайного совпадения — запас, при котором
 * ошибиться раньше можно во всём остальном.
 */
const FINGERPRINT_CHARS = 16;

/**
 * Чем файл цели стал на диске: отпечаток содержимого или `null`, если файла
 * нет. Читает вызывающий — домен решений в файлы не ходит, и подменить его в
 * тесте значит подменить ДИСК, а не предмет проверки.
 */
export type FileHashReader = (filePath: string) => string | null;

/**
 * Доехавшая запись и файл, в который она легла.
 *
 * Одним списком, а не парой «идентификаторы» + «файлы»: два списка одного и
 * того же разъезжаются, и разъезд этот тихий. Файл нужен памяти подписки —
 * по нему правка человека в файле переводится в удержание ЗАПИСЕЙ (П5.2).
 * `null` — запись доехала без записи на диск (`already_available`).
 */
export interface LandedItem {
  readonly itemId: string;
  readonly file: string | null;
}

export interface PlannedSubscriptionSync {
  readonly plan: SubscriptionSyncPlan;
  /**
   * Правки разошедшихся записей — их применяет `applyTransfer`. Наружу не
   * уходят: это замыкания, по проводу едет описание (`plan.transfer.files`).
   */
  readonly writes: readonly EmitWrite[];
  /**
   * Записи, ДОЕХАВШИЕ до цели этой пересборкой, — только их отметки обновятся.
   *
   * Не то же самое, что разошедшиеся: у цели может не быть механизма под слой
   * (скиллы у Gemini), и тогда разошедшаяся запись не даёт ни одной правки.
   * Пометь панель такую запись спроецированной, и подписка сказала бы «цель
   * согласована» про запись, которой у цели нет и не будет. Доехавшими
   * считаются и те, что у цели УЖЕ доступны без записи (`already_available`):
   * писать нечего, а согласованность настоящая.
   */
  readonly landed: readonly LandedItem[];
  /** Корень цели для памяти подписки; `null`, когда пересобирать нечего. */
  readonly root: string | null;
}

/**
 * Ключ подписки: цель плюс уровень, плюс проект на уровне проекта.
 *
 * Той же формы, что ключи отчёта верности и следа переноса, и по той же
 * причине: подписка проекта А и проекта Б под одним ключом делили бы память о
 * спроецированном, и пересборка в Б считала бы разошедшимся то, что панель
 * писала в А.
 *
 * Источника в ключе нет: канон подписки один — собственная среда панели.
 */
export function subscriptionKey(target: string, scope: EnvScope, project?: string): string {
  const base = `${target}:${scope}`;
  return project ? `${base}@${project}` : base;
}

/** Подписка, которой ещё не было: ни одного слоя, ни одной проекции. */
export function emptySubscription(
  target: string,
  scope: EnvScope,
  canonVersion: number,
  project?: string,
): EnvSubscription {
  return {
    target,
    scope,
    ...(project ? { project } : {}),
    layers: [],
    canonVersion,
    marks: {},
    files: {},
    root: null,
    syncedAt: null,
  };
}

/** Отпечаток одной записи канона. Вход даёт словарь, хеш — этот модуль. */
export function itemFingerprint(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, FINGERPRINT_CHARS);
}

/**
 * Что разошлось и что из-за этого будет записано.
 *
 * Канон приходит целиком, а не подписанными слоями: слои отбираются здесь,
 * потому что отбор — это и есть решение подписки, и повторять его на каждом
 * вызывающем значило бы завести второе место, где оно принимается.
 */
export function planSubscriptionSync(
  env: AgentEnvironment,
  subscription: EnvSubscription,
  target: ConfigProvider,
  deps: Omit<EmitDeps, 'target'>,
  computedAt: string,
  /**
   * Чем файлы цели стали на диске (П5.2). Не задан — сверки нет, и пересборка
   * ведёт себя как в П5.1: так зовут её проверки, которым диск не нужен.
   */
  readHash?: FileHashReader,
  /**
   * Файл, правку в котором человек разрешил перезаписать проекцией. Исход
   * `projection` разбирает РОВНО один файл, и разрешение не хранится: оно
   * живёт один вызов, от показанного плана до записи.
   */
  overwrite?: string,
): PlannedSubscriptionSync {
  const key = subscriptionKey(subscription.target, subscription.scope, subscription.project);
  const head = {
    key,
    target: subscription.target,
    scope: subscription.scope,
    layers: subscription.layers,
  };

  // Проекцию строила другая версия словаря. Сравнивать отпечатки через версию
  // нельзя — их считает код, который с версией и менялся, — поэтому строк здесь
  // нет вовсе: список «разошлось/совпало», посчитанный несравнимыми правилами,
  // человек прочитал бы как факт.
  const nothing = { writes: [], landed: [], root: null } as const;
  if (subscription.canonVersion !== env.canonVersion) {
    return {
      plan: { ...head, rows: [], transfer: null, hold: 'canon_version', drift: [] },
      ...nothing,
    };
  }
  if (subscription.layers.length === 0) {
    return {
      plan: { ...head, rows: [], transfer: null, hold: 'no_layers', drift: [] },
      ...nothing,
    };
  }

  // Рука человека сторожится ДО отбора разошедшегося: файл, правленный руками,
  // держит свои записи независимо от того, двинулся канон или нет. Файл, про
  // который человек сказал «перезаписать проекцией», из удержания выходит — и
  // только он: исход разбирает по одному файлу.
  const drift = readHash
    ? detectDrift(subscription, readHash).filter((file) => file.filePath !== overwrite)
    : [];
  const held = new Map(drift.flatMap((file) => file.itemIds.map((id) => [id, file.filePath])));
  const skipFiles = new Set(drift.map((file) => file.filePath));

  const layers = new Set<EnvItemKind>(subscription.layers);
  const rows = subscriptionRows(env, subscription, layers, held);
  // Разрешённый к перезаписи файл пересобирается ЦЕЛИКОМ, даже если канон по
  // его записям не двигался: человек выбрал вернуть проекцию, а «вернуть» —
  // это про то, что лежит на диске, а не про то, что изменилось в каноне.
  const restore = overwrite ? itemsOfFile(subscription, overwrite) : [];
  const drifting = new Set([
    // Удержанные записи не называются к пересборке. Отсев по ФАЙЛУ ниже
    // (`skipFiles`) закрывает тот же случай и закрывает его шире — он держит и
    // НОВУЮ запись, у которой отметки нет вовсе. Этот же нужен там, где файл
    // записи сменился с прошлой проекции: отметка говорит про старый файл, и
    // отсев по нему запись бы не удержал.
    ...rows
      .filter((row) => row.state === 'new' || row.state === 'changed')
      .filter((row) => row.heldBy === null)
      .map((row) => row.itemId),
    ...restore,
  ]);

  if (drifting.size === 0) {
    return { plan: { ...head, rows, transfer: null, hold: null, drift }, ...nothing };
  }

  // Канон отдаётся эмиттеру ЦЕЛИКОМ по подписанным слоям, а не одними
  // разошедшимися записями: слой, который цель собирает в один блок, из одной
  // записи собрался бы в блок из одной записи — то есть пересборка стёрла бы
  // соседей. Что поедет, решает ограничение плана НАЗВАННЫМИ записями.
  const projected: AgentEnvironment = {
    ...env,
    items: env.items.filter((item) => layers.has(item.kind)),
  };
  // Что панель у цели уже писала — её собственное, и разница с каноном здесь
  // не столкновение, а устаревшая проекция. Без этого подписка записала бы
  // цель один раз и дальше возвращала бы человеку выбор на каждую свою же
  // прошлую запись (`EmitDeps.owned`).
  const owned = new Set(Object.keys(subscription.marks));
  const { plan, writes } = buildTransferPlan(
    projected,
    target,
    { ...deps, owned },
    computedAt,
    drifting,
    skipFiles,
  );
  const landed = plan.entries
    .filter((entry) => landsAtTarget(entry.outcome))
    .map((entry) => ({ itemId: entry.itemId, file: entry.file }));

  // Ни одной правки — это `null`, а не план с нулём файлов. План, обещающий
  // пересборку и не пишущий ни байта, человек прочитал бы как сделанную
  // работу; отметки при этом всё равно обновятся у тех записей, что у цели уже
  // доступны без записи.
  return {
    plan: { ...head, rows, transfer: writes.length > 0 ? plan : null, hold: null, drift },
    writes,
    landed,
    root: plan.root,
  };
}

/**
 * Файлы цели, разошедшиеся с тем, какими панель их оставила.
 *
 * Сторожит ХЕШ ФАЙЛА, а не разбор его содержимого импортёром, и это решение, а
 * не экономия: импортёр видит только то, что умеет разобрать, и правка в том,
 * чего он не моделирует — комментарий, чужой ключ, порядок блоков, — прошла бы
 * мимо него незамеченной. Сторож обязан замечать всё; что именно взять в канон,
 * импортёр ответит следующим вопросом.
 */
export function detectDrift(
  subscription: EnvSubscription,
  readHash: FileHashReader,
): SubscriptionDrift[] {
  const drift: SubscriptionDrift[] = [];
  for (const [filePath, written] of Object.entries(subscription.files)) {
    const now = readHash(filePath);
    if (now === written) continue;
    const marks = Object.entries(subscription.marks).filter(([, mark]) => mark.file === filePath);
    drift.push({
      filePath,
      // Пустая строка у `writtenHash` означает провалившуюся запись, а не файл;
      // такого в памяти подписки нет — туда попадает только удачная.
      state: now === null ? 'missing' : 'edited',
      itemIds: marks.map(([itemId]) => itemId),
      layers: [...new Set(marks.map(([, mark]) => mark.kind))],
    });
  }
  return drift;
}

/** Записи, спроецированные панелью в этот файл цели. */
export function itemsOfFile(subscription: EnvSubscription, filePath: string): string[] {
  return Object.entries(subscription.marks)
    .filter(([, mark]) => mark.file === filePath)
    .map(([itemId]) => itemId);
}

/** Слои, которые панель пишет в этот файл цели, — их снимает исход `unsubscribe`. */
export function layersOfFile(subscription: EnvSubscription, filePath: string): EnvItemKind[] {
  const kinds = Object.values(subscription.marks)
    .filter((mark) => mark.file === filePath)
    .map((mark) => mark.kind);
  return [...new Set(kinds)];
}

/**
 * Память подписки после удачной пересборки.
 *
 * Отметки обновляются у записей, ДОЕХАВШИХ до цели (`landed`), а не у всех
 * разошедшихся: запись, под которую у цели нет механизма, правки не даёт, и
 * пометь её панель спроецированной — подписка сказала бы «согласовано» про то,
 * чего у цели нет.
 *
 * Отметки исчезнувших записей СОХРАНЯЮТСЯ: такая запись у цели остаётся (снять
 * её — разговор П5.2), и забудь подписка отметку, строка `gone` исчезла бы
 * вместе с ней — панель перестала бы говорить о расхождении, ничего с ним не
 * сделав.
 */
export function markProjection(
  subscription: EnvSubscription,
  env: AgentEnvironment,
  landed: readonly LandedItem[],
  files: readonly TransferFileRecord[],
  root: string,
  syncedAt: string,
): EnvSubscription {
  const written = new Map(landed.map((item) => [item.itemId, item.file]));
  const marks = { ...subscription.marks };
  for (const item of env.items) {
    if (!written.has(item.id)) continue;
    marks[item.id] = {
      kind: item.kind,
      fingerprint: itemFingerprint(envItemFingerprintInput(item)),
      // Файл берётся у ИСХОДА этой записи, а не у прошлой отметки: эмиттер
      // вправе сложить запись иначе, чем в прошлый раз (у цели сменился
      // формат, запись переехала из каталога в конфиг), и устаревший файл в
      // отметке удерживал бы правку человека не в том файле.
      file: written.get(item.id) ?? null,
    };
  }

  const hashes = { ...subscription.files };
  for (const file of files) hashes[file.filePath] = file.writtenHash;

  return { ...subscription, canonVersion: env.canonVersion, marks, files: hashes, root, syncedAt };
}

/**
 * Память подписки после исхода «взять правку человека в канон».
 *
 * Отметки СЧИТАЮТСЯ ПО КАНОНУ, перечитанному уже после записи, а не по тому,
 * что импортёр взял у цели: канон — владелец истины, и запись, прошедшая через
 * его формат, может отличаться от того, чем была у цели. Возьми панель
 * отпечаток со стороны цели — следующая же пересборка объявила бы запись
 * разошедшейся и переписала бы человеку его собственную правку.
 *
 * Отпечаток ФАЙЛА берётся текущий — тот, что человек оставил своей рукой.
 * Это и есть смысл исхода: панель признаёт его версию файла своей проекцией, и
 * расхождения больше нет — ни сейчас, ни после перезапуска.
 */
export function markAdoption(
  subscription: EnvSubscription,
  env: AgentEnvironment,
  adopted: readonly string[],
  filePath: string,
  fileHash: string,
  syncedAt: string,
): EnvSubscription {
  const taken = new Set(adopted);
  const marks = { ...subscription.marks };
  for (const item of env.items) {
    if (!taken.has(item.id)) continue;
    marks[item.id] = {
      kind: item.kind,
      fingerprint: itemFingerprint(envItemFingerprintInput(item)),
      file: filePath,
    };
  }
  return {
    ...subscription,
    marks,
    files: { ...subscription.files, [filePath]: fileHash },
    syncedAt,
  };
}

/**
 * Память подписки после исхода «отписать слои этого файла».
 *
 * Снимаются ВСЕ слои файла: оставь панель один подписанным, он писал бы в тот
 * же файл, и то же расхождение открылось бы на следующей пересборке.
 *
 * Отпечаток файла ЗАБЫВАЕТСЯ, а отметки записей остаются. Разница не
 * случайна: хеш отвечает на вопрос «панель обещала держать этот файл» — она
 * больше не обещает, и хранить его значило бы вечно показывать расхождение
 * файла, которого никто не пересоберёт. Отметки же — память о том, что панель
 * у цели уже писала, и она переживает отписку по тем же причинам, что и в П5.1.
 */
export function unsubscribeFile(
  subscription: EnvSubscription,
  filePath: string,
): { subscription: EnvSubscription; layers: EnvItemKind[] } {
  const dropped = layersOfFile(subscription, filePath);
  const files = { ...subscription.files };
  delete files[filePath];
  return {
    subscription: {
      ...subscription,
      layers: subscription.layers.filter((layer) => !dropped.includes(layer)),
      files,
    },
    layers: dropped,
  };
}

/**
 * Строка о каждой записи подписанных слоёв плюс о каждой исчезнувшей.
 *
 * Исчезнувшими считаются только отметки ПОДПИСАННЫХ видов. Иначе отписка от
 * слоя — действие, которое у цели ничего не трогает, — выдавала бы столько
 * строк «запись исчезла», сколько в слое записей, и читалась бы как удаление.
 */
function subscriptionRows(
  env: AgentEnvironment,
  subscription: EnvSubscription,
  layers: ReadonlySet<EnvItemKind>,
  /** Запись → файл, правка человека в котором её держит (П5.2). */
  held: ReadonlyMap<string, string>,
): SubscriptionRow[] {
  const rows: SubscriptionRow[] = [];
  const present = new Set<string>();

  for (const item of env.items) {
    if (!layers.has(item.kind)) continue;
    present.add(item.id);
    const mark = subscription.marks[item.id];
    const fingerprint = itemFingerprint(envItemFingerprintInput(item));
    const state = !mark ? 'new' : mark.fingerprint === fingerprint ? 'unchanged' : 'changed';
    rows.push({ itemId: item.id, kind: item.kind, state, heldBy: held.get(item.id) ?? null });
  }

  for (const [itemId, mark] of Object.entries(subscription.marks)) {
    if (present.has(itemId) || !layers.has(mark.kind)) continue;
    rows.push({ itemId, kind: mark.kind, state: 'gone', heldBy: held.get(itemId) ?? null });
  }

  return rows;
}
