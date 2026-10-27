import type { WorktreeMirrorSettings } from '@agentdeck/contracts';
import { liveNaIds, touchKinds } from '@agentdeck/contracts/sieves';
import type { SplitPlanGroupRecord } from '../../../lib/app-store/app-store.types.ts';
import { serverText } from '../../../lib/server-texts/server-texts.ts';
import type { MrReview } from '../../integrations/mr-review/mr-review.types.ts';
import {
  missingDelivery,
  mrDescriptionGap,
  namesId,
  readDeliveryFacts,
} from '../../project-git/delivery-facts/delivery-facts.ts';
import { foreignReverts } from '../../project-git/delivery-facts/branch-commits.ts';
import { touchedFacts } from '../../project-git/sieve-facts/sieve-facts.ts';
import { reviewThreadsGap } from '../mr-watch/review-threads.ts';
import { sieveDeliveryGaps } from '../sieve-gate/sieve-gate.ts';
import type { DeliveryVerdict } from '../split-conveyor/split-conveyor.ts';
import { testsDeliveryGaps } from '../tests-gate/tests-gate.ts';
import { run } from '../../project-git/sieve-facts/sieve-facts.ts';
import { readTaskTickets } from '../task-tickets/task-tickets.ts';
import { ticketPointGaps } from '../ticket-points/ticket-points.ts';
import { taskSourceGaps } from './task-sources.ts';
import { trackerDeliveryGaps, type DeliveryTracker } from './tracker-comments.ts';

/**
 * Проверка доставки группы — ОДИН код на двух входах (g3 25.10, N1): панель зовёт
 * его после хода группы (`runtime.ts` → `SplitConveyor.delivery.facts`), а группа —
 * у себя в копии до ответа (`tests-cli delivery`). Раньше группа сверяла сама только
 * блок «Тесты» (`gaps`), а описание MR и ссылки сит узнавала следующим кругом —
 * 427k токенов за круг. Всё, чего у копии нет (токен форджа, сданный отчёт), приходит
 * зависимостями: панель читает фордж, CLI берёт описание MR из файла.
 */

/** Чем проверка достаёт то, что живёт вне копии. */
export interface DeliveryCheckDeps {
  /** Что зеркалит панель в копию (не «незакоммичено»). */
  mirror?: WorktreeMirrorSettings;
  /** Ветка-источник MR у форджа; нет форджа — не задано. */
  branchOfMr?: (url: string) => Promise<string | undefined>;
  /** Описание и ветки MR; `undefined` — не прочитать (нет форджа, токена, файла). */
  review?: (url: string) => Promise<MrReview | undefined>;
  /** Команда прогона блока «Тесты» — её называют строки пробелов. */
  testsCommand: string;
  /**
   * Звено доставки ещё впереди (`AGENTDECK_GROUP_DELIVER_AHEAD`): пуш и MR — его работа,
   * их пробелы в звене ревью не снять (g5 25.10). Панель после хода зовёт без него.
   */
  deliverAhead?: boolean;
  /**
   * Задачи трекера группы и чтение их комментариев (аудит g3 R7): у найденного MR
   * каждая сделанная задача несёт комментарий со ссылкой на него. Нет трекера — молчит.
   */
  tracker?: DeliveryTracker;
  /**
   * Тексты, из которых группа берёт пункты следа задач, кроме файла задач в копии и
   * описания MR: её задание, заметки плана, отданные ей пункты соседей
   * (`groupPointTexts`). По ним сверяются цитаты строк `task-N` (`taskSourceGaps`).
   */
  taskTexts?: readonly string[];
  log?: (message: string, error?: unknown) => void;
}

/** Группа плана в том виде, что нужен проверке. */
export type DeliveryCheckGroup = Pick<
  SplitPlanGroupRecord,
  'path' | 'branch' | 'startedAt' | 'base' | 'sieveRows' | 'taskTrace'
>;

/**
 * Факты доставки группы: git (ветка, MR по голове), описание MR, ветки ревьюера,
 * сита и блок «Тесты». Строки «не хватает» — тексты сервера; пункты владельца и
 * следы звеньев добавляет `deliveryGapLines` конвейера.
 */
export async function deliveryFacts(
  group: DeliveryCheckGroup,
  mrHint: string | undefined,
  claimed: readonly string[],
  deps: DeliveryCheckDeps,
): Promise<DeliveryVerdict> {
  if (!group.path) return { missing: [serverText('delivery-gap-no-copy')] };
  const log = deps.log ?? (() => undefined);
  const facts = await readDeliveryFacts({
    cwd: group.path,
    branch: group.branch,
    ...(mrHint ? { mr: mrHint } : {}),
    ...(deps.mirror ? { mirror: deps.mirror } : {}),
    claimed,
    ...(group.base ? { forkedFrom: group.base } : {}),
    // MR выбирается по ветке группы, а не по одной голове (ревью 29.09):
    // ветку-источник знает только фордж, без него — «неизвестно».
    ...(deps.branchOfMr ? { branchOfMr: deps.branchOfMr } : {}),
  });
  const missing = missingDelivery(facts, facts.branch ?? group.branch, {
    publishLater: deps.deliverAhead === true,
  });
  // Сита перед MR (решение владельца 28.09): механика git панели и судья
  // отчёта группы. Сеть уже не ответила — сита ждут следующей проверки.
  const sieves = facts.unreachable
    ? undefined
    : await sieveDeliveryGaps({
        cwd: group.path,
        ...(group.startedAt ? { startedAt: group.startedAt } : {}),
        ...(group.base ? { forkedFrom: group.base } : {}),
        rows: group.sieveRows ?? [],
      }).catch((error: unknown) => {
        log('split delivery: sieves unreadable', error);
        return undefined;
      });
  if (sieves?.unchecked) {
    log(`split delivery: sieves unchecked for ${group.branch}: ${sieves.unchecked.join('; ')}`);
  }
  // Вердикт группы — из кейсов и записанных прогонов блока «Тесты» в её
  // копии, а не из её слов (решение владельца 29.09). Блока в копии нет —
  // проверять нечем, группу это не держит.
  const tests = await testsDeliveryGaps({
    cwd: group.path,
    ...(group.startedAt ? { startedAt: group.startedAt } : {}),
    command: deps.testsCommand,
  }).catch((error: unknown) => {
    log('split delivery: tests block unreadable', error);
    return undefined;
  });
  // Ветка от основной или от предшественника — один разбор на снимки и задачи трекера.
  const cwd = group.path;
  let touched: Promise<{ paths: string[]; base?: string }> | undefined;
  const touchedOnce = (): Promise<{ paths: string[]; base?: string }> =>
    (touched ??= touchedFacts(cwd, group.base).catch((): { paths: string[]; base?: string } => ({
      paths: [],
    })));
  // Чужой коммит на ветке (бот CI, человек) убрал строки, добавленные группой, и их нет
  // в HEAD (g8 26.10, F1): MR ушёл в ревью с откатом её же правки. Пробел, пока группа
  // не закрепит файл своим коммитом — вернёт строки или поправит источник генерации.
  const reverts = await touchedOnce()
    .then(({ base }) => (base ? foreignReverts(cwd, base) : []))
    .catch((error: unknown) => {
      log('split delivery: branch commits unreadable', error);
      return [];
    });
  const revertGaps = reverts.map((item) =>
    serverText('delivery-gap-foreign-revert', {
      commit: item.commit,
      files:
        item.files.slice(0, 5).join(', ') +
        (item.files.length > 5 ? ` (+${item.files.length - 5})` : ''),
    }),
  );
  // Задачи трекера — у MR, который ведёт эта стадия: стадия ревью, чей MR откроет
  // доставка (`deliverAhead`), комментария со ссылкой оставить ещё не может.
  const tracker =
    facts.mr && deps.tracker && deps.deliverAhead !== true
      ? await trackerDeliveryGaps({
          cwd: group.path,
          base: (await touchedOnce()).base,
          mr: facts.mr,
          tracker: deps.tracker,
        }).catch((error: unknown) => {
          log('split delivery: tracker tickets unreadable', error);
          return undefined;
        })
      : undefined;
  // Заметки доставки (23.10): «не проверено» и красное не из-за ветки —
  // не пробелы, но описание MR обязано их назвать.
  const notes = [...(sieves?.notes ?? []), ...(tests?.notes ?? []), ...(tracker?.notes ?? [])];
  const noted = [...(sieves?.noted ?? []), ...(tests?.noted ?? [])];
  // Описание MR и ветки ревьюера — одним чтением, только у найденного по голове MR.
  const review =
    facts.mr && deps.review ? await deps.review(facts.mr).catch(() => undefined) : undefined;
  // Разделы описания доставки (P6, g5 25.10): проверки на финальном дереве всегда, снимки —
  // когда ветка задела интерфейс. Пути — тем же разбором, что у сит (`touchKinds`).
  const uiFiles =
    facts.mr && review?.description !== undefined
      ? (await touchedOnce()).paths.filter((path) => touchKinds([path]).has('ui'))
      : [];
  const description = facts.mr
    ? await mrDescriptionGap(
        facts.mr,
        async () => review,
        liveNaIds(group.sieveRows ?? []),
        noted,
        {
          checks: true,
          uiFiles,
        },
      )
    : {};
  // Ветки ревьюера держат доставку (24.10): наблюдатель MR смотрит только
  // группы в `done`, и группа в доставке сутки не видела трёх блокеров.
  const threads = review && facts.mr ? reviewThreadsGap(review, facts.mr) : undefined;
  // Источник строк следа задач (g0 26.10, F3): цитата пункта из тикета, задания или описания
  // MR, и переписанное без коммита доказательство.
  const tickets = group.taskTrace === true ? readTaskTickets(cwd) : undefined;
  const sources =
    group.taskTrace === true
      ? taskSourceGaps({
          rows: group.sieveRows,
          required: true,
          sources: {
            ...(tickets !== undefined ? { tickets } : {}),
            ...(review?.description !== undefined ? { description: review.description } : {}),
            ...(deps.taskTexts ? { texts: deps.taskTexts } : {}),
          },
          ...(await headCommittedAt(cwd)),
        })
      : [];
  // Пункт тикета без строки следа (аудит g5 27.10, H1): PDF из комментариев обеих задач не
  // назвала ни одна строка, а доставка судила только сданные.
  const points = ticketPointGaps({
    tickets,
    rows: group.sieveRows,
    required: group.taskTrace === true,
  });
  return {
    missing: [
      ...missing,
      ...revertGaps,
      ...(description.missing ?? []),
      ...(description.sections ?? []),
      ...(threads ? [threads.line] : []),
      ...(tracker?.missing ?? []),
      ...sources,
      ...points,
      ...(sieves?.missing ?? []),
      ...(tests?.missing ?? []),
    ],
    ...(notes.length > 0 ? { notes, noted } : {}),
    ...namedNotes(notes, noted, review?.description),
    ...(sieves?.rejected ? { rejected: sieves.rejected } : {}),
    ...(facts.head ? { head: facts.head } : {}),
    ...(tests?.verdict ? { tests: tests.verdict } : {}),
    ...(sieves?.classes.length ? { sieveClasses: sieves.classes } : {}),
    ...(facts.mr ? { mr: facts.mr } : {}),
    ...(facts.branch ? { branch: facts.branch } : {}),
    ...(facts.unreachable ? { unreachable: facts.unreachable } : {}),
    ...(description.unchecked ? { descriptionUnchecked: true } : {}),
    ...(threads ? { reviewThreads: threads.threads } : {}),
  };
}

/**
 * Заметки, которые живое описание MR уже называет (g1 26.10, F4): заметка — названная, когда
 * она несёт хоть один id из `noted` и описание называет каждый из них. Заметка без id
 * (трекер) или описание не прочитано — заметка остаётся в напоминании.
 */
export function namedNotes(
  notes: readonly string[],
  noted: readonly string[],
  description: string | undefined,
): { notesNamed?: string[] } {
  if (!description?.trim() || notes.length === 0) return {};
  const ids = [...new Set(noted)];
  const named = notes.filter((note) => {
    const own = ids.filter((id) => namesId(note, id));
    return own.length > 0 && own.every((id) => namesId(description, id));
  });
  return named.length > 0 ? { notesNamed: named } : {};
}

/**
 * Строка самопроверки о живом MR (g1 26.10, F6): что панель в нём увидела — открытые ветки,
 * последняя реплика (автор и время), какие id заметок называет описание. Группа цитирует её
 * доказательством, а не перечитывает MR форджем после выхода 0.
 */
export function liveMrLine(mr: string, review: MrReview, noted: readonly string[] = []): string {
  const open = review.threads.filter((thread) => thread.resolvable && !thread.resolved).length;
  const last = review.threads
    .flatMap((thread) => thread.notes)
    .filter((note) => note.createdAt)
    .sort((a, b) => Date.parse(a.createdAt ?? '') - Date.parse(b.createdAt ?? ''))
    .at(-1);
  const named = [...new Set(noted)].filter((id) => namesId(review.description ?? '', id));
  return (
    `The live MR ${mr} was read through the panel: ${open} unresolved reviewer thread(s)` +
    (last ? `, last note by ${last.author} at ${last.createdAt ?? ''}` : '') +
    (named.length > 0 ? `; the description names ${named.join(', ')}` : '') +
    '. The description and the threads are checked above — quote this line as the evidence ' +
    'and do not read them again through the forge; no description file is needed.'
  );
}

/** Время коммита HEAD копии (ISO): после него ли сдана прежняя строка следа задач. */
async function headCommittedAt(cwd: string): Promise<{ headCommittedAt?: string }> {
  const out = await run(cwd, ['log', '-1', '--format=%cI', 'HEAD']);
  const at = out.code === 0 ? out.stdout.trim() : '';
  return at ? { headCommittedAt: at } : {};
}
