import type { SplitOverlapFile, SplitOverlapView } from '@agentdeck/contracts/chat-handoff';
import type { SplitPlanRecord } from '../../lib/app-store/app-store.types.ts';
import type { ChatEvent } from './ChatRunner.ts';
import { copyRootOf } from './split-conveyor.ts';
import { applyDrift, driftCandidates, readDrift, type MovedFiles } from './split-drift.ts';

/**
 * Пересечения веток разделения — контроль ПОСЛЕ работы (Т6).
 *
 * Разбор уровня 1 разводит группы по владениям заранее, но заранее он и
 * ошибается: агент правит соседний файл, потому что иначе не собирается, и
 * узнаётся это при слиянии — когда переделывать уже дорого. Здесь панель
 * спрашивает у git то, что разбор мог только предполагать: какие файлы каждая
 * ветка ДЕЙСТВИТЕЛЬНО задела, и где эти множества сошлись.
 *
 * Три правила.
 *
 * 1. ПАНЕЛЬ НИЧЕГО НЕ СЛИВАЕТ И НЕ ПРАВИТ. Ни `merge`, ни `rebase`, ни
 *    `checkout` — только чтение и показ. Свести ветки обратно — шаг владельца, и
 *    это решение не пересматривается; порядок из `after` здесь подсказка, а не
 *    кнопка.
 * 2. СЧИТАЕМ ПО ВЕТКАМ, А НЕ ПО ЧАТАМ. У группы до пяти разговоров, а ветка
 *    одна, и вопрос «кто ещё трогал файл» задаётся ветке. Группа без копии
 *    (ждёт разбора, предшественников, ответа) в счёт не идёт вовсе.
 * 3. ГОВОРИМ ОДИН РАЗ НА ФАКТ. Факт — «этот файл у этих групп»: пересчёт после
 *    каждой цепочки повторял бы одно и то же сообщение до посинения. Отметка
 *    сказанного живёт в записи, а не в памяти процесса (см. Т4).
 *
 * Git подаётся интерфейсом: домен проверяется без единого репозитория, а
 * настоящее чтение живёт в `project-git`, где ему и место.
 */

/**
 * Сколько задетых путей запоминать на группу. Потолок общий с заметкой
 * преемнику (`PREDECESSOR_FILES_SHOWN`): хранить больше, чем когда-либо будет
 * сказано, незачем — запись живёт в `state.json` рядом со всем остальным.
 */
const COUNTED_NAMES_MAX = 20;

/**
 * Пересчёт по расписанию, пока группы работают (находка 61c). Конец цепочки
 * бывает раз в час, а соседи за это время успевают залезть в один файл — узнать
 * это при слиянии поздно. Не чаще раза в десять минут на разделение: пересчёт —
 * два вызова git на группу, и тратить их на каждый такт незачем.
 */
export const DRIFT_RECHECK_MS = 10 * 60_000;
/** Такт расписания — половина срока: запись, считанная концом цепочки, не ждёт двух сроков. */
export const DRIFT_TICK_MS = DRIFT_RECHECK_MS / 2;
/** Сколько разделений пересчитать за такт — самые давние первыми. */
export const DRIFT_RECHECK_MAX = 4;

/** Группа ещё работает — её ветка может задеть что-то новое. */
const ACTIVE = new Set(['started', 'background', 'awaiting']);

/** Одна группа глазами пересечений: ветка, копия и объявленное владение. */
export interface OverlapGroup {
  index: number;
  title: string;
  branch: string;
  /** Каталог копии; нет — копии не заводили, считать нечего. */
  path?: string;
  /** От какой ветки отведена; нет — от ветки основной копии. */
  base?: string;
  /** Что разбор объявил владением этой группы; пусто — границ не ставили. */
  owns?: string[];
  /** Индексы групп, чья работа должна лечь раньше. */
  after: number[];
}

/** Ветка группы, прочитанная git: что она задела. */
interface ScannedGroup {
  index: number;
  files: string[];
  owns?: readonly string[];
}

/** Ровно то, что пересечениям нужно от git. Отдельным типом — ради теста без репозитория. */
export interface OverlapGit {
  /**
   * Ветка, в которую всё это будет сливаться, — ветка основной копии, а если
   * локальная отстала от удалённого, то её свежий вид (`readMergeTarget`).
   */
  mergeBase(mainDir: string): Promise<string | undefined>;
  /**
   * Файлы, которые ветка задела относительно базы: коммиты плюс незакоммиченное
   * в копии. Пути — от корня репозитория, слэшами вперёд, как их печатает git.
   */
  changedFiles(input: {
    mainDir: string;
    worktreeDir: string;
    base: string;
    branch: string;
  }): Promise<string[]>;
  /**
   * Что ветка слияния задела с развилки с веткой группы — дрейф основной под
   * идущей группой (находка 61, `split-drift.ts`). Нет — дрейф не считается.
   */
  movedFiles?: MovedFiles;
}

export interface SplitOverlapDeps {
  git: OverlapGit;
  /** Прочитать и записать запись конвейера — ту же, что ведёт `SplitConveyor`. */
  store: {
    get(parentChatId: string): SplitPlanRecord | undefined;
    set(record: SplitPlanRecord): void;
    /** Все записи — пересчёту по расписанию (`recheckRunning`); нет — его нет. */
    all?(): Record<string, SplitPlanRecord>;
  };
  /**
   * Заметка в ленту РОДИТЕЛЯ. `false` — прогона у родителя нет и сказать некуда:
   * тогда факт не отмечается сказанным и подождёт следующего пересчёта, а
   * человек всё равно видит его в сводке групп.
   */
  emit: (parentChatId: string, event: ChatEvent) => boolean;
  log: (message: string, error?: unknown) => void;
  now?: () => Date;
}

/**
 * Путь в сравнимом виде: слэши вперёд, без ведущего `./`. Регистр НЕ трогаем —
 * git печатает пути так, как они лежат в индексе, и на Windows тоже.
 */
function normalizePath(value: string): string {
  return value.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
}

/**
 * Файл внутри объявленного владения.
 *
 * Владение разбор пишет словами человека — «путь или модуль»: то каталогом
 * (`apps/web/src/pages/Chat`), то файлом целиком, то маской (`apps/web/**`).
 * Поэтому совпадением считается и точное равенство, и путь ВНУТРИ каталога, и
 * простая маска с `*`. Границ не объявили вовсе — нарушать нечего: пустой
 * список означает «разбор молчал», а не «нельзя ничего».
 */
export function ownsFile(path: string, owns: readonly string[] | undefined): boolean {
  if (!owns || owns.length === 0) return true;
  const file = normalizePath(path);
  return owns.some((raw) => {
    const own = normalizePath(raw).replace(/\/+$/, '');
    if (!own) return false;
    if (own.includes('*')) {
      // `**` — любая глубина, `*` — один сегмент: ровно те две маски, которые
      // модель и пишет. Всё прочее в регулярном выражении экранируется.
      const pattern = own
        .split('/')
        .map((part) =>
          part === '**' ? '.*' : part.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*'),
        )
        .join('/')
        .replace(/\/\.\*\//g, '/(?:.*/)?');
      return new RegExp(`^${pattern}$`).test(file);
    }
    return file === own || file.startsWith(`${own}/`);
  });
}

/**
 * Пересечения: файл, задетый больше чем одной группой, и кто из них вышел за
 * своё владение. Чистая функция — вся арифметика проверяется без git.
 */
export function intersectGroups(
  groups: readonly { index: number; files: readonly string[]; owns?: readonly string[] }[],
): SplitOverlapFile[] {
  const touched = new Map<string, Set<number>>();
  for (const group of groups) {
    for (const raw of group.files) {
      const file = normalizePath(raw);
      if (!file) continue;
      const owners = touched.get(file) ?? new Set<number>();
      owners.add(group.index);
      touched.set(file, owners);
    }
  }

  const byIndex = new Map(groups.map((group) => [group.index, group]));
  const files: SplitOverlapFile[] = [];
  for (const [path, owners] of touched) {
    if (owners.size < 2) continue;
    const list = [...owners].sort((a, b) => a - b);
    files.push({
      path,
      groups: list,
      outside: list.filter((index) => !ownsFile(path, byIndex.get(index)?.owns)),
    });
  }
  // Сначала нарушения границ, потом остальные — красное человек читает первым;
  // внутри — по имени, чтобы список не прыгал между пересчётами.
  return files.sort(
    (a, b) =>
      Number(b.outside.length > 0) - Number(a.outside.length > 0) || a.path.localeCompare(b.path),
  );
}

/**
 * Порядок слияния: `after` сильнее предложенного порядка старта.
 *
 * Это подсказка, а не команда: сливает человек. Круг в зависимостях (разбор
 * такое чинит, но запись могла приехать из старой версии) не роняет порядок —
 * оставшиеся дописываются как есть, в порядке `order`.
 */
export function mergeOrderOf(
  groups: readonly { index: number; after: readonly number[] }[],
  order: readonly number[],
): number[] {
  const known = new Set(groups.map((group) => group.index));
  const queue = [...order.filter((index) => known.has(index))];
  for (const group of groups) if (!queue.includes(group.index)) queue.push(group.index);

  const after = new Map(
    groups.map((group) => [group.index, group.after.filter((r) => known.has(r))]),
  );
  const done = new Set<number>();
  const result: number[] = [];
  let moved = true;
  while (moved && result.length < queue.length) {
    moved = false;
    for (const index of queue) {
      if (done.has(index)) continue;
      if ((after.get(index) ?? []).some((ref) => !done.has(ref))) continue;
      done.add(index);
      result.push(index);
      moved = true;
    }
  }
  for (const index of queue) if (!done.has(index)) result.push(index);
  return result;
}

/**
 * Отпечаток факта: «файл — эти группы». Третья группа, дотянувшаяся до того же
 * файла, — новый факт и новая заметка; повторный пересчёт с тем же составом —
 * тот же отпечаток, и человека мы больше не трогаем.
 */
export function factOf(file: SplitOverlapFile): string {
  return `${file.path}@${file.groups.join(',')}`;
}

/**
 * Почему ветку не прочитали — ОДНОЙ строкой. git на неизвестную ревизию отвечает
 * тремя абзацами с подсказкой про `--`, и целиком это распирает и строку сводки,
 * и заметку; человеку нужна первая строка — она и есть причина.
 */
function reasonOf(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const first = text
    .split(/[\r\n]+/)
    .map((line) => line.trim())
    .find(Boolean);
  return (first ?? 'причина неизвестна').slice(0, 200);
}

/** Заметка в ленту родителя про новые пересечения — коротко и по делу. */
export function overlapNotice(
  fresh: readonly SplitOverlapFile[],
  titleOf: (index: number) => string,
): string {
  const NAMED = 3;
  const lines = fresh
    .slice(0, NAMED)
    .map(
      (file) =>
        `${file.path} — ${file.groups.map(titleOf).join(', ')}${
          file.outside.length > 0 ? ` (вне владения: ${file.outside.map(titleOf).join(', ')})` : ''
        }`,
    );
  const rest = fresh.length - lines.length;
  return [
    `Пересечение веток: ${fresh.length}.`,
    `${lines.join('; ')}${rest > 0 ? `; и ещё ${rest}` : ''}.`,
    'Слияние остаётся вам — панель ветки не трогает.',
  ].join(' ');
}

/**
 * Считает пересечения и рассказывает о новых. Живёт дольше запроса: зовут её и
 * маршрут (кнопка в хабе), и конец цепочки любой группы.
 */
export class SplitOverlap {
  private readonly deps: SplitOverlapDeps;
  private readonly now: () => Date;
  /** Пересчёты одного разделения не должны идти внахлёст: git читается секунды. */
  private readonly inFlight = new Map<string, Promise<SplitOverlapView | undefined>>();

  constructor(deps: SplitOverlapDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * Пересчитать пересечения разделения и запомнить их в записи. `undefined` —
   * записи нет вовсе (разделение шло без конвейера уровней). Ошибка чтения одной
   * ветки не роняет остальные: она уходит в `unread` с причиной.
   */
  async check(parentChatId: string): Promise<SplitOverlapView | undefined> {
    const running = this.inFlight.get(parentChatId);
    if (running) return running;
    const started = this.run(parentChatId).finally(() => this.inFlight.delete(parentChatId));
    this.inFlight.set(parentChatId, started);
    return started;
  }

  /**
   * Пересчитать разделения, где группы ещё работают (находка 61c): хоть одна
   * группа идёт, копий хотя бы две (пересекаться не с кем), прошлый счёт старше
   * `DRIFT_RECHECK_MS`. Не больше `DRIFT_RECHECK_MAX` за раз, давние первыми.
   * Сказать о новом пересечении — тот же `check`: один раз на факт.
   * Возвращает, кого пересчитали.
   */
  async recheckRunning(): Promise<string[]> {
    const all = this.deps.store.all?.();
    if (!all) return [];
    const now = this.now().getTime();
    const due = Object.values(all)
      .filter((record) => {
        const copies = record.groups.filter((group) => group.path && !group.cleaned);
        // Со счётом дрейфа хватает одной идущей копии: основная ветка — тоже сосед.
        const least = this.deps.git.movedFiles ? 1 : 2;
        if (copies.length < least || !copies.some((group) => ACTIVE.has(group.status)))
          return false;
        const at = record.overlap ? Date.parse(record.overlap.at) : Number.NaN;
        return Number.isNaN(at) || now - at >= DRIFT_RECHECK_MS;
      })
      .sort((a, b) => (a.overlap?.at ?? '').localeCompare(b.overlap?.at ?? ''))
      .slice(0, DRIFT_RECHECK_MAX);
    const checked: string[] = [];
    for (const record of due) {
      try {
        await this.check(record.parentChatId);
        checked.push(record.parentChatId);
      } catch (error) {
        this.deps.log('split overlap: periodic recheck failed', error);
      }
    }
    return checked;
  }

  /**
   * Завести пересчёт по расписанию. Такты не идут внахлёст: медленный git
   * пропускает такт, а не копит очередь. Таймер не держит процесс. Возвращает
   * остановку.
   */
  watchDrift(
    every = DRIFT_TICK_MS,
    timers: {
      set: (tick: () => void, ms: number) => unknown;
      clear: (handle: unknown) => void;
    } = {
      set: (tick, ms) => {
        const handle = setInterval(tick, ms);
        handle.unref?.();
        return handle;
      },
      clear: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
    },
  ): () => void {
    let busy = false;
    const handle = timers.set(() => {
      if (busy) return;
      busy = true;
      void this.recheckRunning()
        .catch((error) => this.deps.log('split overlap: periodic recheck failed', error))
        .finally(() => {
          busy = false;
        });
    }, every);
    return () => timers.clear(handle);
  }

  private async run(parentChatId: string): Promise<SplitOverlapView | undefined> {
    const record = this.deps.store.get(parentChatId);
    if (!record) return undefined;

    const groups: OverlapGroup[] = record.groups.map((group) => ({
      index: group.index,
      title: group.title,
      branch: group.branch,
      ...(group.path ? { path: group.path } : {}),
      ...(group.base ? { base: group.base } : {}),
      ...(record.proposal.groups[group.index]?.owns
        ? { owns: record.proposal.groups[group.index]?.owns }
        : {}),
      after: group.after,
    }));

    const { view, scanned, target } = await this.collect(copyRootOf(record), record.order, groups);
    const moved = this.deps.git.movedFiles;
    const active = driftCandidates(record);
    const shared =
      moved && target
        ? await readDrift({
            moved,
            mainDir: copyRootOf(record),
            target,
            groups: scanned
              .filter((group) => active.has(group.index))
              .map((group) => ({
                index: group.index,
                branch: groups.find((g) => g.index === group.index)?.branch ?? '',
                files: group.files,
              })),
            log: this.deps.log,
          })
        : undefined;

    // Читаем запись ЗАНОВО: git шёл секунды, и за это время конвейер мог
    // записать конец другой цепочки. Перезаписать его нашей копией значило бы
    // потерять статус группы ради списка файлов.
    const fresh = this.deps.store.get(parentChatId) ?? record;
    const noticed = fresh.overlap?.noticed ?? [];
    const unseen = view.files.filter((file) => !noticed.includes(factOf(file)));
    let told = noticed;
    if (unseen.length > 0) {
      const titleOf = (index: number): string =>
        fresh.groups[index]?.title ?? `группа ${index + 1}`;
      const said = this.deps.emit(parentChatId, {
        kind: 'notice',
        code: 'overlap',
        text: overlapNotice(unseen, titleOf),
      });
      // Сказать не вышло (у родителя нет прогона) — факт не отмечаем: сводка
      // покажет его и так, а заметка догонит при следующем пересчёте.
      if (said) told = [...noticed, ...unseen.map(factOf)];
    }
    fresh.overlap = { ...view, noticed: told };
    if (shared && target) {
      applyDrift({
        record: fresh,
        target,
        shared,
        at: view.at,
        emit: (event) => this.deps.emit(parentChatId, event),
      });
    }
    this.deps.store.set(fresh);
    return view;
  }

  /** Опрос git по группам. Вынесено ради теста: сюда подаются уже готовые группы. */
  private async collect(
    mainDir: string,
    order: readonly number[],
    groups: readonly OverlapGroup[],
  ): Promise<{ view: SplitOverlapView; scanned: ScannedGroup[]; target?: string }> {
    const at = this.now().toISOString();
    const base = await this.mergeBase(mainDir);
    const counted: SplitOverlapView['counted'] = [];
    const unread: SplitOverlapView['unread'] = [];
    const scanned: ScannedGroup[] = [];

    for (const group of groups) {
      if (!group.path) continue;
      const from = group.base ?? base;
      if (!from) {
        unread.push({ index: group.index, reason: 'не удалось определить ветку основной копии' });
        continue;
      }
      try {
        const files = await this.deps.git.changedFiles({
          mainDir,
          worktreeDir: group.path,
          base: from,
          branch: group.branch,
        });
        scanned.push({ index: group.index, files, ...(group.owns ? { owns: group.owns } : {}) });
        // Не только счёт, но и первые имена: по ним группа, которая отведётся от
        // этой ветки следующей, узнаёт в своём задании, что тут уже трогали.
        // Потолок — чтобы запись в `state.json` не росла на дифф большой ветки.
        counted.push({
          index: group.index,
          files: files.length,
          ...(files.length > 0 ? { names: files.slice(0, COUNTED_NAMES_MAX) } : {}),
        });
      } catch (error) {
        unread.push({ index: group.index, reason: reasonOf(error) });
      }
    }

    const view = {
      at,
      files: intersectGroups(scanned),
      mergeOrder: mergeOrderOf(groups, order),
      counted,
      unread,
    };
    return { view, scanned, ...(base ? { target: base } : {}) };
  }

  private async mergeBase(mainDir: string): Promise<string | undefined> {
    try {
      return await this.deps.git.mergeBase(mainDir);
    } catch (error) {
      this.deps.log('split overlap: merge base unreadable', error);
      return undefined;
    }
  }
}
