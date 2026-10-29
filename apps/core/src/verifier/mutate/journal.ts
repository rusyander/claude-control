import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import { MutateRefusal, type MustfailJournal, type MutateIo } from './mutate.types.ts';

/**
 * Журнал подмен в формате mustfail (G6). Мутант пишет прямо в рабочую копию, поэтому каждая запись
 * сначала ложится в журнал рядом с репозиторием (`<git-path mustfail>/journal-<pid>.json`), а
 * оригинал — в резервную копию: процесс, убитый посреди мутанта, не оставит дерево подменённым —
 * следующий старт (наш или mustfail) вернёт файл. Формат общий нарочно: `tools/mutation-guard.mjs`
 * отказывает чужим прогонам тестов, пока журнал жив, а mustfail и мы не пишем одно дерево вдвоём.
 */

export const JOURNAL_NAME = /^journal-(\d+)\.json$/;

export function sha1(bytes: Buffer | null): string {
  return bytes === null ? 'absent' : createHash('sha1').update(bytes).digest('hex');
}

export interface JournalPlace {
  stateDir: string;
  scope: string;
  /** Вершина рабочего дерева: ни план, ни журнал не пишут вне её. */
  top: string;
}

/** Где живёт журнал этого дерева. Вне git — отказ: журналу нужно место, что переживёт перезагрузку и не видно `git status`. */
export async function journalPlace(io: MutateIo, root: string): Promise<JournalPlace> {
  const top = await io.gitRevParse(root, ['--show-toplevel']);
  const gitPath =
    top === undefined ? undefined : await io.gitRevParse(root, ['--git-path', 'mustfail']);
  if (top === undefined || gitPath === undefined)
    throw new MutateRefusal(
      `mutate: ${root} не рабочее дерево git — журналу подмен негде жить, мутант не пишется`,
    );
  const stateDir = /^([a-zA-Z]:)?[\\/]/.test(gitPath) ? gitPath : join(root, gitPath);
  // Та же область, что у mustfail и mutation-guard: путь вершины, прямые слэши, нижний регистр.
  return { stateDir, scope: top.replace(/\\/g, '/').toLowerCase(), top };
}

export interface LiveForeign {
  pid: number;
  started: string;
  file: string;
}

/** Кто сверяет журналы: pid и метка своего журнала, если он уже на диске (иначе `null`). */
export interface JournalSelf {
  pid: number;
  started: string | null;
}

/**
 * Разобрать журналы этого дерева: мёртвый прогон — вернуть его файлы (только те, что ещё держат
 * записанные им байты; изменённый после смерти файл не перезаписывается — отказ с путём копии);
 * живой чужой — ответ, вызывающий ждёт или отказывает. Нечитаемый журнал — отказ: файлы могли
 * остаться подменёнными, и угадывать нельзя. Журнал под СВОИМ pid, но не свой текущий — прогон
 * этого же процесса, чей возврат не подтвердился (или pid переиспользован после смерти): он мёртв,
 * его файлы возвращаются, а не затираются новым журналом под тем же именем.
 */
export function settleJournals(
  io: MutateIo,
  place: JournalPlace,
  self: JournalSelf,
  log: (line: string) => void,
): LiveForeign | null {
  const names = io.listDir(place.stateDir);
  if ('absent' in names) return null;
  if ('unknown' in names)
    throw new MutateRefusal(
      `mutate: каталог журналов ${place.stateDir} не читается: ${names.unknown}`,
    );
  for (const name of names.value) {
    const match = JOURNAL_NAME.exec(name);
    if (!match) continue;
    const file = join(place.stateDir, name);
    const journal = readJournal(io, file);
    if (journal.scope !== place.scope) continue;
    const own = journal.pid === self.pid;
    if (own && journal.started === self.started) continue;
    if (!own && io.pidAlive(journal.pid))
      return { pid: journal.pid, started: journal.started, file };
    restoreDead(io, place, journal, file, log);
  }
  return null;
}

// Форма журнала mustfail: pid — целое (он же имя каталога копий), пути — строки. Чужие поля не мешают.
const journalSchema = z.object({
  pid: z.number().int().positive(),
  scope: z.string(),
  started: z.string(),
  cmd: z.string(),
  files: z.record(
    z.string(),
    z.object({ backup: z.string(), before: z.string(), written: z.array(z.string()) }),
  ),
});

function readJournal(io: MutateIo, file: string): MustfailJournal {
  const bytes = io.readBytes(file);
  if (!('value' in bytes))
    throw new MutateRefusal(
      `mutate: журнал ${file} не читается — убитый прогон мог оставить файлы подменёнными. Сверьте их с git и удалите журнал`,
    );
  let json: unknown;
  try {
    json = JSON.parse(bytes.value.toString('utf8'));
  } catch {
    json = undefined; // не JSON — схема ниже откажет так же, как чужой форме
  }
  const parsed = journalSchema.safeParse(json);
  if (!parsed.success)
    throw new MutateRefusal(
      `mutate: журнал ${file} не разбирается — убитый прогон мог оставить файлы подменёнными. Сверьте их с git и удалите журнал`,
    );
  return parsed.data;
}

/**
 * Записи журнала, которым нельзя верить: файл вне дерева или копия вне каталога копий этого pid.
 * Журнал с диска пишет любой, кто пишет каталог git; без этой сверки «возврат» перезаписал бы
 * произвольный файл байтами, что подложил автор журнала.
 */
function outsideEntries(io: MutateIo, place: JournalPlace, journal: MustfailJournal): string[] {
  const backups = join(place.stateDir, String(journal.pid));
  const bad: string[] = [];
  for (const [full, entry] of Object.entries(journal.files)) {
    if (!io.inside(place.top, full)) bad.push(`${full} — вне дерева ${place.top}`);
    else if (!io.inside(backups, entry.backup))
      bad.push(`${full} — копия ${entry.backup} вне ${backups}`);
  }
  return bad;
}

function restoreDead(
  io: MutateIo,
  place: JournalPlace,
  journal: MustfailJournal,
  file: string,
  log: (line: string) => void,
): void {
  const bad = outsideEntries(io, place, journal);
  if (bad.length > 0)
    throw new MutateRefusal(
      `mutate: журнал ${file} называет пути вне дерева или своих копий — возврат по нему не делается:\n  ${bad.join('\n  ')}\nСверьте файлы с git и удалите журнал`,
    );
  const restored: string[] = [];
  const stuck: string[] = [];
  for (const [full, entry] of Object.entries(journal.files)) {
    const now = io.readBytes(full);
    if ('unknown' in now) {
      stuck.push(`${full} — не читается (${now.unknown}); оригинал в ${entry.backup}`);
      continue;
    }
    const nowSha = sha1('value' in now ? now.value : null);
    if (nowSha === entry.before) continue;
    if (!entry.written.includes(nowSha)) {
      stuck.push(`${full} — изменён после смерти прогона; оригинал в ${entry.backup}`);
      continue;
    }
    const original = entry.before === 'absent' ? null : io.readBytes(entry.backup);
    if (original === null) {
      // Файла до прогона не было: его создал прогон, вернуть — значит удалить.
      const gone = io.remove(full);
      if (gone.removed) restored.push(full);
      else stuck.push(`${full} — не удалился: ${gone.reason}`);
      continue;
    }
    if (!('value' in original) || sha1(original.value) !== entry.before) {
      stuck.push(`${full} — резервная копия ${entry.backup} не совпадает с журналом`);
      continue;
    }
    io.writeBytes(full, original.value);
    const back = io.readBytes(full);
    if ('value' in back && sha1(back.value) === entry.before) restored.push(full);
    else stuck.push(`${full} — запись не подтвердилась чтением; оригинал в ${entry.backup}`);
  }
  if (restored.length > 0)
    log(
      `mutate: вернул ${restored.length} файл(ов), оставленных убитым прогоном (pid ${journal.pid}, ${journal.started}): ${restored.join(', ')}`,
    );
  if (stuck.length > 0)
    throw new MutateRefusal(
      `mutate: убитый прогон (pid ${journal.pid}, ${journal.started}) оставил файлы, которые нельзя вернуть без человека:\n  ${stuck.join('\n  ')}\nВерните их руками и удалите ${file}`,
    );
  io.remove(file);
  io.remove(join(place.stateDir, String(journal.pid)));
}

/**
 * Свой журнал прогона: каждая подмена записана ДО записи в файл. Сам журнал ложится на диск при
 * захвате дерева (`open`), до первого прогона теста: пока он только в памяти, второй прогон того же
 * дерева его не видит и принимает наши мутанты за оригиналы.
 */
export class OwnJournal {
  readonly file: string;
  readonly backups: string;
  readonly place: JournalPlace;
  private readonly journal: MustfailJournal;
  private readonly io: MutateIo;
  private opened = false;

  constructor(io: MutateIo, place: JournalPlace, pid: number, cmd: string) {
    this.io = io;
    this.place = place;
    this.file = join(place.stateDir, `journal-${pid}.json`);
    this.backups = join(place.stateDir, String(pid));
    this.journal = { pid, scope: place.scope, started: new Date().toISOString(), cmd, files: {} };
  }

  /** Кто мы для `settleJournals`: метка — только когда журнал уже на диске. */
  get self(): JournalSelf {
    return { pid: this.journal.pid, started: this.opened ? this.journal.started : null };
  }

  /** Захват дерева: пустой журнал на диске — mutation-guard и соседний прогон видят занятость сразу. */
  open(): void {
    this.persist();
    this.opened = true;
  }

  private persist(): void {
    this.io.ensureDir(this.backups);
    this.io.writeBytes(this.file, Buffer.from(JSON.stringify(this.journal), 'utf8'));
  }

  /** Резервная копия оригинала — один раз, до первой подмены файла; копия сверяется чтением. */
  track(full: string, original: Buffer): void {
    if (this.journal.files[full]) return;
    this.io.ensureDir(this.backups);
    const backup = join(this.backups, `${Object.keys(this.journal.files).length}-backup`);
    this.io.writeBytes(backup, original);
    const check = this.io.readBytes(backup);
    if (!('value' in check) || !check.value.equals(original))
      throw new MutateRefusal(`mutate: резервная копия ${full} не подтвердилась чтением`);
    this.journal.files[full] = { backup, before: sha1(original), written: [] };
    this.persist();
  }

  /** Байты, что сейчас лягут в файл, — в журнал строго ДО записи. */
  intend(full: string, bytes: Buffer): void {
    const entry = this.journal.files[full];
    if (!entry) throw new Error(`mutate: ${full} не взят под журнал`);
    const hash = sha1(bytes);
    if (entry.written.includes(hash)) return;
    entry.written.push(hash);
    this.persist();
  }

  /**
   * Вернуть каждый файл к оригиналу и проверить чтением. Синхронно — зовётся и из обработчика
   * сигнала. Список невернувшихся — наверх; журнал тогда остаётся для следующего старта.
   */
  restoreAll(): string[] {
    const stuck: string[] = [];
    for (const [full, entry] of Object.entries(this.journal.files)) {
      const now = this.io.readBytes(full);
      if ('value' in now && sha1(now.value) === entry.before) continue;
      const original = this.io.readBytes(entry.backup);
      if (!('value' in original)) {
        stuck.push(`${full} (оригинал в ${entry.backup})`);
        continue;
      }
      try {
        this.io.writeBytes(full, original.value);
      } catch {
        // запись не прошла — проверка чтением ниже назовёт файл
      }
      const back = this.io.readBytes(full);
      if (!('value' in back) || sha1(back.value) !== entry.before)
        stuck.push(`${full} (оригинал в ${entry.backup})`);
    }
    return stuck;
  }

  /** Всё на месте: журналу и копиям нечего охранять. */
  close(): void {
    this.io.remove(this.file);
    this.io.remove(this.backups);
    this.opened = false;
  }

  /**
   * Захват не удался: убрать свой журнал, только если он на диске. Не открытый — каталог `<pid>` может
   * держать копии мёртвого прогона того же pid, чей возврат отказал; их удалять нельзя.
   */
  abandon(): void {
    if (this.opened && Object.keys(this.journal.files).length === 0) this.close();
  }
}
