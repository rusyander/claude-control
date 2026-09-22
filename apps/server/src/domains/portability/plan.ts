import { createHash } from 'node:crypto';
import type { AgentEnvironment } from '@agentdeck/contracts/portable-env';
import type { TransferFilePlan, TransferPlan } from '@agentdeck/contracts/portable-transfer';
import type { ConfigProvider } from '../../providers/types.ts';
import { runPreview } from '../provider-preview.ts';
import { emitEnvironment } from './emit/index.ts';
import type { EmitDeps, EmitWrite } from './emit/types.ts';
import { buildFidelityReport } from './fidelity-report.ts';

/**
 * План переноса: всё, что человек обязан увидеть ДО первой записи (П2.3).
 *
 * Модуль ничего не пишет в файлы цели — это его единственная обязанность, и
 * ради неё дифф считается ЧЕСТНО, а не предсказанием: ту же самую запись
 * выполняет тот же самый адаптер формата, только по временной копии файла
 * (`runPreview`, приём `lib/config-sandbox.ts`). Отдельного «генератора
 * предпросмотра» для переноса нет намеренно — он разошёлся бы и с настоящей
 * записью, и с предпросмотром одной записи, а предпросмотр, который врёт, хуже
 * его отсутствия.
 */

/** План плюс правки, которыми его применяют. */
export interface PlannedTransfer {
  readonly plan: TransferPlan;
  /**
   * Те же правки, что описаны в `plan.files`, но с замыканиями.
   *
   * Наружу они не уходят и уйти не могут: `EmitWrite` — это функция, а по
   * проводу едет описание. Применение (`apply.ts`) получает их от ЭТОГО же
   * вызова, поэтому пересчёт плана перед записью не «лишняя работа», а
   * единственный способ применить ровно то, что показали.
   */
  readonly writes: readonly EmitWrite[];
}

export function buildTransferPlan(
  env: AgentEnvironment,
  target: ConfigProvider,
  deps: Omit<EmitDeps, 'target'>,
  computedAt: string,
  /**
   * Ограничить план НАЗВАННЫМИ записями. Подписка (П5.1) пересобирает цель по
   * разошедшимся записям, и ограничивать обязан именно этот вызов, а не
   * вызывающий: отбрось он правки после, отпечаток и диффы остались бы
   * посчитаны по тому, что не поедет, — то есть план показывал бы одно, а
   * применение делало другое.
   *
   * Записи называются, а отбираются ПРАВКИ целиком: у инструкций все записи
   * сливаются в один блок, и правка, собранная из одной изменившейся записи,
   * стёрла бы у цели соседние. Поэтому правка едет, если названа ХОТЬ ОДНА её
   * запись, — со всеми остальными заодно.
   */
  only?: ReadonlySet<string>,
  /**
   * Файлы цели, которых эта запись не касается вовсе (П5.2): их правил человек,
   * и правка его новее нашей проекции. Отсеиваются ЗДЕСЬ, по тем же причинам,
   * что и `only`: отпечаток и диффы обязаны описывать то, что применится.
   *
   * Отсев идёт по файлу, а не по записи, потому что руку человека сторожит хеш
   * ФАЙЛА. Запись, которая у цели ещё не лежала, столкновением не считается и
   * уехала бы в тронутый файл беспрепятственно — то есть панель дописала бы в
   * файл, про который только что сказала «не трогаю».
   */
  skipFiles?: ReadonlySet<string>,
): PlannedTransfer {
  const emitted = emitEnvironment(env, { ...deps, target });
  // Разделы берутся у ПЛАНА, а не считаются здесь заново: на уровне проекта
  // отчёт верности без них отказывается считаться вовсе (fail-closed), и без
  // этой передачи проектный перенос падал на первой же строке отчёта.
  const report = buildFidelityReport(env, target, computedAt, emitted.targets);

  const namedWrites = only
    ? emitted.writes.filter((write) => write.itemIds.some((id) => only.has(id)))
    : emitted.writes;
  const writes = skipFiles
    ? namedWrites.filter((write) => !skipFiles.has(write.filePath))
    : namedWrites;
  const files = groupByFile(writes).map((group) => filePlan(target, group));
  // Со слов плана уходят записи, о которых не спрашивали: строка про них
  // описывала бы работу, которой в этом применении не будет. Заодно остаются
  // строки названных записей, что НЕ дают правки вовсе (у цели такой слой уже
  // доступен или невозможен), — без них подписка не узнала бы, что с ними.
  const namedEntries = only
    ? emitted.entries.filter((entry) => only.has(entry.itemId))
    : emitted.entries;
  // Строка записи, чей файл отсеян, ушла бы со словом «записана» о работе,
  // которой не будет, — а по этим строкам подписка помечает спроецированное
  // (`landsAtTarget`). Записи без файла (`runtime_only`, `already_available`)
  // отсевом не затрагиваются: их исход про диск ничего не утверждает.
  const entries = skipFiles
    ? namedEntries.filter((entry) => !(entry.file !== null && skipFiles.has(entry.file)))
    : namedEntries;
  const plan: TransferPlan = {
    source: env.provider,
    target: target.id,
    scope: emitted.scope,
    root: emitted.root,
    fingerprint: fingerprintOf(env, target.id, emitted.scope, entries, files),
    computedAt,
    entries,
    files,
    report,
  };

  return { plan, writes };
}

/**
 * Правки по файлам, в порядке появления.
 *
 * Слои, которые ложатся в ОДИН файл цели (ссылка на файл инструкций и
 * переменные окружения в конфиге Aider, хуки и переменные в `settings.json`
 * Claude), обязаны показываться одним диффом: дифф каждого слоя по отдельности
 * считается от нынешнего файла, и ни один из них не равен тому, что в файле
 * окажется.
 */
function groupByFile(writes: readonly EmitWrite[]): EmitWrite[][] {
  const groups = new Map<string, EmitWrite[]>();
  for (const write of writes) {
    const group = groups.get(write.filePath);
    if (group) group.push(write);
    else groups.set(write.filePath, [write]);
  }
  return [...groups.values()];
}

/** Дифф одного файла: настоящие записи по его копии, по очереди, сравнение текстов. */
function filePlan(target: ConfigProvider, group: readonly EmitWrite[]): TransferFilePlan {
  const first = group[0];
  if (!first) throw new Error('пустая группа правок: у файла обязана быть хотя бы одна');

  const preview = runPreview(
    {
      providerId: target.id,
      providerName: target.name,
      filePath: first.filePath,
      // Глубина песочницы — по самой требовательной правке группы: меньшая
      // устроит всех, большая не помешает никому.
      sandboxSegments: Math.max(...group.map((write) => write.sandboxSegments ?? 1)),
    },
    (sandboxPath) => {
      for (const write of group) write.applyTo(sandboxPath);
    },
  );

  return {
    filePath: first.filePath,
    kinds: [...new Set(group.map((write) => write.kind))],
    itemIds: [...new Set(group.flatMap((write) => write.itemIds))],
    exists: preview.exists,
    unchanged: preview.unchanged,
    lines: preview.lines,
    added: preview.added,
    removed: preview.removed,
    truncated: preview.truncated,
    // Только у обрезанного сравнения — и только ради отпечатка: показывать хеш
    // человеку нечего, а без него отпечаток такого файла слеп к его содержимому.
    ...(preview.hashes ? { hashes: preview.hashes } : {}),
  };
}

/**
 * Отпечаток ПОКАЗАННОГО — и ничего сверх того.
 *
 * Считается по исходам записей и по диффам файлов, то есть ровно по тому, что
 * человек видел на экране. Это даёт обе нужные проверки одним числом: кнопка
 * «применить» без предшествующего показа отпечатка не знает, а файл цели,
 * сменившийся между показом и нажатием, меняет дифф — и отпечаток перестаёт
 * совпадать. Подставить сюда «версию среды» вместо диффов было бы слабее:
 * правка чужого файла чужими руками версии канона не меняет.
 */
function fingerprintOf(
  env: AgentEnvironment,
  target: string,
  scope: string,
  entries: TransferPlan['entries'],
  files: readonly TransferFilePlan[],
): string {
  const shape = {
    canonVersion: env.canonVersion,
    source: env.provider,
    target,
    scope,
    entries: entries.map((entry) => [entry.itemId, entry.outcome, entry.file]),
    files: files.map((file) => [
      file.filePath,
      file.exists,
      file.unchanged,
      file.added,
      file.removed,
      file.truncated,
      // У обрезанного сравнения строк нет вовсе, а `added`/`removed` — нули:
      // без хешей отпечаток такого файла не менялся бы ни от какой правки
      // руками, и сторож устаревшего плана молчал бы именно там, где файл
      // велик настолько, что править его руками опаснее всего.
      file.hashes ? `${file.hashes.before}:${file.hashes.after}` : '',
      file.lines.map((line) => `${line.kind} ${line.text}`),
    ]),
  };
  return createHash('sha256').update(JSON.stringify(shape)).digest('hex');
}

/**
 * Отпечатки планов, которые панель УЖЕ показала.
 *
 * Живут в памяти процесса и нарочно не сохраняются на диск: список отвечает на
 * вопрос «видел ли человек это только что», а не «видел ли когда-нибудь».
 * Перезапуск сервера обнуляет его, и применение попросит открыть предпросмотр
 * заново — это верный ответ, а не неудобство: за время простоя файлы цели могли
 * смениться кем угодно.
 *
 * Глубина маленькая по той же причине: план на реальном доме — это десятки
 * файлов, и помнить их сотнями незачем.
 */
const SHOWN_LIMIT = 32;
const shownPlans: string[] = [];

export function rememberShownPlan(fingerprint: string): void {
  const at = shownPlans.indexOf(fingerprint);
  if (at >= 0) shownPlans.splice(at, 1);
  shownPlans.push(fingerprint);
  if (shownPlans.length > SHOWN_LIMIT) shownPlans.shift();
}

export function wasPlanShown(fingerprint: string): boolean {
  return shownPlans.includes(fingerprint);
}

/** Забыть показанное — тестам и смене дома панели. */
export function forgetShownPlans(): void {
  shownPlans.length = 0;
}
