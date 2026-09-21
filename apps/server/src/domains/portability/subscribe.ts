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
  readonly landed: readonly string[];
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
    return { plan: { ...head, rows: [], transfer: null, hold: 'canon_version' }, ...nothing };
  }
  if (subscription.layers.length === 0) {
    return { plan: { ...head, rows: [], transfer: null, hold: 'no_layers' }, ...nothing };
  }

  const layers = new Set<EnvItemKind>(subscription.layers);
  const rows = subscriptionRows(env, subscription, layers);
  const drifting = new Set(
    rows.filter((row) => row.state === 'new' || row.state === 'changed').map((row) => row.itemId),
  );

  if (drifting.size === 0) {
    return { plan: { ...head, rows, transfer: null, hold: null }, ...nothing };
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
  );
  const landed = plan.entries
    .filter((entry) => landsAtTarget(entry.outcome))
    .map((entry) => entry.itemId);

  // Ни одной правки — это `null`, а не план с нулём файлов. План, обещающий
  // пересборку и не пишущий ни байта, человек прочитал бы как сделанную
  // работу; отметки при этом всё равно обновятся у тех записей, что у цели уже
  // доступны без записи.
  return {
    plan: { ...head, rows, transfer: writes.length > 0 ? plan : null, hold: null },
    writes,
    landed,
    root: plan.root,
  };
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
  landed: readonly string[],
  files: readonly TransferFileRecord[],
  root: string,
  syncedAt: string,
): EnvSubscription {
  const written = new Set(landed);
  const marks = { ...subscription.marks };
  for (const item of env.items) {
    if (!written.has(item.id)) continue;
    marks[item.id] = {
      kind: item.kind,
      fingerprint: itemFingerprint(envItemFingerprintInput(item)),
    };
  }

  const hashes = { ...subscription.files };
  for (const file of files) hashes[file.filePath] = file.writtenHash;

  return { ...subscription, canonVersion: env.canonVersion, marks, files: hashes, root, syncedAt };
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
): SubscriptionRow[] {
  const rows: SubscriptionRow[] = [];
  const present = new Set<string>();

  for (const item of env.items) {
    if (!layers.has(item.kind)) continue;
    present.add(item.id);
    const mark = subscription.marks[item.id];
    const fingerprint = itemFingerprint(envItemFingerprintInput(item));
    const state = !mark ? 'new' : mark.fingerprint === fingerprint ? 'unchanged' : 'changed';
    rows.push({ itemId: item.id, kind: item.kind, state });
  }

  for (const [itemId, mark] of Object.entries(subscription.marks)) {
    if (present.has(itemId) || !layers.has(mark.kind)) continue;
    rows.push({ itemId, kind: mark.kind, state: 'gone' });
  }

  return rows;
}
