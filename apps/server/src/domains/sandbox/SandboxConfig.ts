import {
  mkdirSync,
  writeFileSync,
  copyFileSync,
  existsSync,
  readdirSync,
  statSync,
  type Dirent,
} from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { copyRecursive, removeEntry } from '../../lib/safe-io.ts';
import { readRules } from '../rules.ts';
import { readSkills } from '../skills.ts';
import { readHooks } from '../hooks.ts';
import { readMcpServers } from '../mcp.ts';
import type { ClaudeLocation } from '@claude-control/contracts';
import type { AppStore } from '../../lib/app-store.ts';
import {
  readClaudeCredentials,
  writeSecretFile,
  type CredentialsSource,
} from '../../lib/credentials.ts';

/**
 * Изолированная конфигурация для проверки отдельных настроек.
 *
 * Claude Code читает всё из каталога, на который указывает CLAUDE_CONFIG_DIR.
 * Песочница пользуется этим: во временный каталог кладётся только то, что
 * проверяют, и ничего больше. Проверено на практике — в таком запуске у Claude
 * 30 инструментов вместо 165, ни одного MCP-сервера и ни одного стороннего
 * хука, а переписка пишется в тот же временный каталог, а не в настоящий.
 *
 * Наружу из песочницы не выходит ничего: настоящие настройки открываются
 * только на чтение, файл с токенами MCP-серверов не копируется, а рабочая
 * папка своя. Единственное исключение — учётные данные Claude Code: без них
 * проверять нечего (см. lib/credentials.ts, там же разница между системами).
 */

/** Что именно проверяем. */
export interface SandboxSelection {
  ruleIds?: string[];
  skillIds?: string[];
  hookIds?: string[];
  mcpIds?: string[];
  /** Файлы скриптов из hooks/, которые нужны выбранным хукам. */
  scriptNames?: string[];
  /** Текст правила, которого ещё нет в настройках, — для проверки черновика. */
  draftRule?: { title: string; text: string };
}

export interface SandboxDescription {
  /** Что попало в песочницу — показывается пользователю перед прогоном. */
  rules: string[];
  skills: string[];
  hooks: string[];
  mcpServers: string[];
  scripts: string[];
}

export interface Sandbox {
  id: string;
  configDir: string;
  workDir: string;
  description: SandboxDescription;
  /**
   * Откуда взялся токен и почему не взялся. Нужно интерфейсу: без токена
   * разговор в песочнице не пойдёт, и причину лучше назвать заранее.
   */
  credentials: { source: CredentialsSource; reason?: string };
  /** Переменные окружения для запуска: сюда попадает ключ API, если доступ им. */
  env: Record<string, string>;
}

/** Корень всех песочниц — намеренно вне каталога Claude Code: туда писать нельзя. */
function sandboxRoot(): string {
  return join(homedir(), '.claude-control', 'sandboxes');
}

/**
 * Имя папки песочницы по её идентификатору.
 *
 * Оставляем только безопасные символы: так `../foo` не выберется за пределы
 * корня. Но у чистки есть край — id из одних запрещённых символов (`..`,
 * `///`, пустая строка) схлопывается в пустоту, и тогда `root` совпал бы с
 * самим корнем песочниц. А по этому пути `createSandbox`/`removeSandbox`
 * делают `rmSync(root, recursive)` — то есть снесли бы разом ВСЕ песочницы
 * (в каждой лежит копия .credentials.json и env MCP-серверов). Поэтому
 * вырожденный id — это ошибка, а не «корневая» песочница.
 *
 * Это же имя — ключ реестров ниже: подметание видит на диске папки, а не id.
 */
function sandboxKey(id: string): string {
  const safe = id.replace(/[^a-zA-Z0-9-]/g, '');
  if (!safe) throw new Error(`Недопустимый идентификатор песочницы: ${JSON.stringify(id)}`);
  return safe;
}

export function sandboxPaths(id: string): { root: string; configDir: string; workDir: string } {
  const root = join(sandboxRoot(), sandboxKey(id));
  return { root, configDir: join(root, 'config'), workDir: join(root, 'work') };
}

/**
 * Песочницы с живым прогоном: пока внутри работает CLI, подметать нельзя.
 *
 * Свежесть по mtime — признак приблизительный: длинный агентный ход может
 * часами ничего не писать на диск, и такая песочница читалась как брошенная.
 * Сервер при этом точно знает, что в ней кто-то работает (реестр `running` в
 * маршрутах), — этим знанием и пользуемся.
 */
const busySandboxes = new Set<string>();

/**
 * Песочницы, которые унесло подметание. Нужны маршруту прогона: папки нет, но
 * это не «песочницы никогда не было», а «время вышло». Разница видима
 * пользователю — без неё на месте стёртой молча собиралась ПУСТАЯ песочница, и
 * прогон отвечал так, будто проверяемое правило ни на что не влияет.
 */
const expiredSandboxes = new Set<string>();

/** Потолок памяти реестра: за сутки работы панели имён накапливается много. */
const EXPIRED_LIMIT = 200;

export function markSandboxBusy(id: string): void {
  busySandboxes.add(sandboxKey(id));
}

export function markSandboxFree(id: string): void {
  busySandboxes.delete(sandboxKey(id));
}

/** Песочницу унесло подметание — папки нет по истечении простоя, а не по ошибке. */
export function isSandboxExpired(id: string): boolean {
  return expiredSandboxes.has(sandboxKey(id));
}

function markExpired(key: string): void {
  busySandboxes.delete(key);
  expiredSandboxes.add(key);

  // Set хранит порядок вставки — вычёркиваем самое старое имя.
  if (expiredSandboxes.size > EXPIRED_LIMIT) {
    const oldest = expiredSandboxes.values().next().value;
    if (oldest !== undefined) expiredSandboxes.delete(oldest);
  }
}

/**
 * Собирает песочницу под выбранные элементы.
 *
 * Учётные данные — единственное, что переносится из настоящего каталога:
 * без них Claude Code отвечает «Not logged in» и проверить ничего нельзя.
 * Файл с токенами MCP-серверов не копируется никогда.
 */
export function createSandbox(
  id: string,
  selection: SandboxSelection,
  location: ClaudeLocation,
  store: AppStore,
): Sandbox {
  const { root, configDir, workDir } = sandboxPaths(id);

  // Первая же песочница взводит периодическое подметание: иначе брошенная копия
  // доступа лежала бы на диске до перезапуска сервера (см. startSandboxSweeper).
  // Сервер взводит его и на старте, но createSandbox бывает и вне сервера.
  armSandboxSweeper();

  // Собранная заново песочница живая, чем бы ни была прежняя с тем же именем.
  expiredSandboxes.delete(sandboxKey(id));

  // Старую песочницу с тем же id сносим ПРОВЕРЕННО: если от неё что-то уцелело,
  // это «что-то» окажется внутри новой — вместе с чужими скиллами и настройками.
  const wiped = removeTree(root);
  if (!wiped.ok) throw new Error(`Не удалось очистить прежнюю песочницу: ${wiped.error}`);

  mkdirSync(configDir, { recursive: true });
  mkdirSync(workDir, { recursive: true });

  // Источник токена зависит от системы: файл на Windows и Linux, связка ключей
  // на macOS. Не нашлось — песочницу всё равно собираем: пусть человек увидит
  // внятную причину в интерфейсе, а не «Not logged in» из недр CLI.
  const credentials = readClaudeCredentials(location.paths.root);
  if (credentials.content) {
    // Именно writeSecretFile: это копия настоящего доступа к аккаунту, и она
    // не должна ни мгновения лежать с правами по умолчанию.
    writeSecretFile(join(configDir, '.credentials.json'), credentials.content);
  }

  const description: SandboxDescription = {
    rules: writeRules(configDir, selection, location, store),
    skills: copySkills(configDir, selection, location, store),
    scripts: [],
    hooks: [],
    mcpServers: [],
  };

  copyScripts(configDir, selection, location, description);

  const settings = buildSettings(configDir, selection, location, store, description);
  writeFileSync(join(configDir, 'settings.json'), JSON.stringify(settings, null, 2), 'utf8');

  return {
    id,
    configDir,
    workDir,
    description,
    credentials: { source: credentials.source, reason: credentials.reason },
    // Окружение запуска этой песочницы. Рабочая папка едет здесь, а не через
    // глобальный process.env: раньше collectHooks писал её в process.env сервера,
    // и при параллельной сборке двух песочниц значение протекало во все
    // последующие дочерние процессы (побеждала последняя). Здесь оно привязано к
    // конкретной песочнице. Ключ API файлом не кладётся — Claude Code читает его
    // из окружения.
    env: {
      CLAUDE_CONTROL_SANDBOX_WORKDIR: workDir,
      ...(credentials.apiKey ? { ANTHROPIC_API_KEY: credentials.apiKey } : {}),
    },
  };
}

/**
 * Удаление папки песочницы С ПРОВЕРКОЙ результата.
 *
 * Рекурсивный `rmSync` здесь запрещён по той же причине, что и во всех прочих
 * модулях (см. safe-io.ts): на Windows он рапортует об успехе, ничего не удалив,
 * если в пути есть нелатинские символы, — а внутрь песочницы копируются папки
 * скиллов с пользовательскими именами, то есть кириллица там ожидаема. Молчаливый
 * «успех» оставлял бы на диске копию `.credentials.json` и значения `env`
 * MCP-серверов открытым текстом, пока панель говорит «песочница стёрта».
 *
 * Поэтому удаляем поштучно через `removeEntry` и сверяемся с диском: пережила
 * папка удаление или упало само удаление (файл держит ещё не умерший процесс
 * CLI) — наружу уходит причина, а не тишина.
 */
function removeTree(root: string): { ok: true } | { ok: false; error: string } {
  try {
    removeEntry(root);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }

  return existsSync(root)
    ? { ok: false, error: `каталог ${root} остался на диске после удаления` }
    : { ok: true };
}

/**
 * Удаление песочницы. Ошибку НЕ глотаем: внутри лежит копия доступа к аккаунту,
 * и «удалили» вместо «не смогли удалить» — худший из возможных ответов. Маршрут
 * `DELETE /api/sandbox/:id` возвращает `{ok:true}` последней строкой, поэтому
 * непроверенный отказ доходил до пользователя как успех; брошенное исключение
 * до этой строки не доводит.
 */
export function removeSandbox(id: string): void {
  const { root } = sandboxPaths(id);
  const result = removeTree(root);

  // Удалили по просьбе — это не «время вышло»: следующий прогон с тем же id
  // должен собрать песочницу заново, а не получить отказ по истечению.
  const key = sandboxKey(id);
  busySandboxes.delete(key);
  expiredSandboxes.delete(key);

  if (!result.ok) {
    throw new Error(
      `Песочницу не удалось удалить (${result.error}). В ней осталась копия доступа к аккаунту — удалите папку ${root} вручную.`,
    );
  }
}

/**
 * Пауза, на которую подметание щадит свежие папки: два сервера, стартующие
 * почти одновременно, не должны сносить песочницы друг друга.
 */
const SWEEP_GRACE_MS = 60_000;

/** Как часто работающий сервер подметает песочницы. */
const SWEEP_INTERVAL_MS = 10 * 60_000;

/** Сколько песочница может простоять без единой записи, прежде чем считается брошенной. */
const SANDBOX_IDLE_MS = 2 * 60 * 60_000;

/**
 * Предел обхода при поиске свежести: песочница мелкая, но копия скилла тянет за
 * собой references/ и шаблоны. Упёрлись в предел — считаем найденное достаточным.
 */
const MTIME_SCAN_LIMIT = 2000;

let sweepTimer: ReturnType<typeof setInterval> | undefined;
let deferredTimer: ReturnType<typeof setTimeout> | undefined;

/** Песочница, которую не удалось убрать: внутри осталась копия доступа. */
export interface SweepFailure {
  id: string;
  path: string;
  error: string;
}

export interface SweepReport {
  removed: string[];
  failed: SweepFailure[];
}

/**
 * Куда уходит жалоба подметания.
 *
 * Молчаливый отказ здесь — та же беда, что и молчаливое удаление: на диске
 * осталась копия доступа к аккаунту, а узнать об этом неоткуда. Панель о
 * фоновом подметании не спрашивает, поэтому единственное место, где человек
 * это увидит, — поток ошибок сервера; в тестах сюда подставляется свой сток.
 */
export type SweepReporter = (line: string) => void;

const stderrReporter: SweepReporter = (line) => {
  process.stderr.write(`${line}\n`);
};

function reportFailures(failed: SweepFailure[], report: SweepReporter): void {
  for (const item of failed) {
    report(
      `Песочницу не удалось убрать: ${item.path} — ${item.error}. В ней осталась копия доступа к аккаунту, удалите папку вручную.`,
    );
  }
}

/** Итог одного удаления в проходе подметания: успех — в список, отказ — в жалобу. */
function collect(dir: string, name: string, into: SweepReport): void {
  const wiped = removeTree(dir);

  if (wiped.ok) {
    into.removed.push(name);
    markExpired(name);
    return;
  }

  into.failed.push({ id: name, path: dir, error: wiped.error });
}

/**
 * Периодическое подметание брошенных песочниц — то, чего не хватало.
 *
 * Удаление жило ровно в двух местах: DELETE из размонтирования модалки и
 * подметание при СТАРТЕ сервера. Закрытая вкладка, перезагрузка страницы или
 * падение браузера никакого DELETE не шлют, а локальный сервер работает сутками —
 * и копия `.credentials.json` лежала на диске всё это время, хотя интерфейс
 * обещает «всё созданное стирается при закрытии окна». Каждое открытие модалки
 * заводит новый id, так что копии ещё и накапливались.
 *
 * Отличить открытую вкладку от закрытой сервер не может (реестр песочниц живёт в
 * памяти и о браузере ничего не знает), поэтому признак один — время. Берём самую
 * свежую отметку файла ВНУТРИ песочницы: любой прогон пишет и в config/ (там
 * переписка), и в work/. Запас намеренно большой: два часа тишины живой разговор
 * не выдержит, а секрет столько лежать не должен.
 */
export function startSandboxSweeper(
  options: { intervalMs?: number; idleMs?: number; root?: string; report?: SweepReporter } = {},
): () => void {
  stopSandboxSweeper();

  const idleMs = options.idleMs ?? SANDBOX_IDLE_MS;
  const root = options.root ?? sandboxRoot();
  const report = options.report ?? stderrReporter;

  const timer = setInterval(() => {
    // Ошибка подметания не должна ронять сервер: следующий тик попробует снова.
    // Но и промолчать нельзя — иначе копия доступа лежит на диске без следа.
    try {
      reportFailures(sweepIdleSandboxes(Date.now(), root, idleMs).failed, report);
    } catch (error) {
      report(
        `Подметание песочниц не выполнено: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }, options.intervalMs ?? SWEEP_INTERVAL_MS);

  // Таймер не держит процесс живым: подметание — фон, а не работа сервера.
  timer.unref?.();
  sweepTimer = timer;

  return stopSandboxSweeper;
}

export function stopSandboxSweeper(): void {
  if (deferredTimer) {
    clearTimeout(deferredTimer);
    deferredTimer = undefined;
  }

  if (!sweepTimer) return;
  clearInterval(sweepTimer);
  sweepTimer = undefined;
}

/** Взвести подметание один раз — повторные вызовы ничего не меняют. */
function armSandboxSweeper(): void {
  if (!sweepTimer) startSandboxSweeper();
}

/**
 * Один проход подметания по простою. В отличие от стартового, время считается по
 * самому свежему файлу внутри: на старте всё лежащее на диске брошено по
 * определению, а у работающего сервера часть песочниц открыта прямо сейчас.
 */
export function sweepIdleSandboxes(
  now: number = Date.now(),
  root: string = sandboxRoot(),
  idleMs: number = SANDBOX_IDLE_MS,
): SweepReport {
  const report: SweepReport = { removed: [], failed: [] };
  if (!existsSync(root)) return report;

  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;

    // Живой прогон важнее отметок времени: длинный агентный ход может часами
    // ничего не писать, и по одному mtime песочницу снесло бы из-под него.
    if (busySandboxes.has(entry.name)) continue;

    const dir = join(root, entry.name);
    if (now - newestMtime(dir, { left: MTIME_SCAN_LIMIT }) < idleMs) continue;

    collect(dir, entry.name, report);
  }

  return report;
}

/** Отметка времени пути; недоступный путь считаем свежим — трогать его не наше дело. */
function mtimeOf(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return Date.now();
  }
}

/** Самая свежая отметка внутри дерева: mtime самой папки не меняется от записи вглубь. */
function newestMtime(dir: string, budget: { left: number }): number {
  let newest = mtimeOf(dir);
  if (budget.left <= 0) return newest;

  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return newest;
  }

  for (const entry of entries) {
    if (budget.left-- <= 0) break;

    const child = join(dir, entry.name);
    const stamp = entry.isDirectory() ? newestMtime(child, budget) : mtimeOf(child);
    if (stamp > newest) newest = stamp;
  }

  return newest;
}

/**
 * Подметание при старте. Реестр песочниц живёт только в памяти сервера,
 * поэтому всё, что осталось на диске к моменту запуска, — след аварийного
 * завершения. Внутри такой папки лежит копия `.credentials.json` и значения
 * `env` MCP-серверов открытым текстом, и ждать, пока человек удалит её руками,
 * неправильно.
 */
export function sweepAbandonedSandboxes(
  now: number = Date.now(),
  root: string = sandboxRoot(),
): SweepReport & { deferred: string[] } {
  const report: SweepReport & { deferred: string[] } = { removed: [], failed: [], deferred: [] };
  if (!existsSync(root)) return report;

  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;

    const dir = join(root, entry.name);

    // Пощажённые паузой не забываются: их доберёт отложенный проход, иначе
    // песочница, созданная за минуту до перезапуска панели, пережила бы старт и
    // осталась бы с копией доступа внутри до следующего перезапуска.
    if (now - statSync(dir).mtimeMs < SWEEP_GRACE_MS) {
      report.deferred.push(entry.name);
      continue;
    }

    // Только подтверждённое удаление: раньше сюда попадали и папки, которые
    // rmSync «удалил» лишь на словах, и лог старта врал про очистку.
    collect(dir, entry.name, report);
  }

  return report;
}

/**
 * Второй проход по тем, кого на старте пощадила пауза.
 *
 * Пауза защищает от гонки двух серверов, стартующих одновременно, — но не
 * должна дарить брошенной песочнице жизнь до следующего перезапуска. Условие
 * удаления жёсткое: внутри папки НИЧЕГО не менялось с момента запуска сервера.
 * Так отсеиваются и песочницы соседнего сервера (он в них пишет), и созданные
 * этим сервером уже после старта — у тех отметки заведомо новее.
 */
export function sweepDeferredSandboxes(
  names: string[],
  startedAt: number,
  root: string = sandboxRoot(),
): SweepReport {
  const report: SweepReport = { removed: [], failed: [] };

  for (const name of names) {
    if (busySandboxes.has(name)) continue;

    const dir = join(root, name);
    if (!existsSync(dir)) continue;
    if (newestMtime(dir, { left: MTIME_SCAN_LIMIT }) > startedAt) continue;

    collect(dir, name, report);
  }

  return report;
}

/**
 * Уборка песочниц на старте сервера — всё вместе и в одном месте.
 *
 * Три вещи, каждая из которых по отдельности дырява: разовый проход по диску
 * (следы аварийного завершения), взведённое подметание по простою (без него
 * таймер заводился только из createSandbox — то есть в процессе, где модалку
 * песочницы ни разу не открыли, его не было вовсе) и отложенный проход по
 * пощажённым паузой.
 */
export function startSandboxHousekeeping(
  options: {
    root?: string;
    now?: number;
    graceMs?: number;
    intervalMs?: number;
    idleMs?: number;
    report?: SweepReporter;
  } = {},
): SweepReport & { deferred: string[]; stop: () => void } {
  const root = options.root ?? sandboxRoot();
  const startedAt = options.now ?? Date.now();
  const report = options.report ?? stderrReporter;

  const first = sweepAbandonedSandboxes(startedAt, root);
  reportFailures(first.failed, report);

  startSandboxSweeper({
    intervalMs: options.intervalMs,
    idleMs: options.idleMs,
    root,
    report,
  });

  if (first.deferred.length > 0) {
    const timer = setTimeout(() => {
      deferredTimer = undefined;
      try {
        reportFailures(sweepDeferredSandboxes(first.deferred, startedAt, root).failed, report);
      } catch (error) {
        report(
          `Отложенная уборка песочниц не выполнена: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }, options.graceMs ?? SWEEP_GRACE_MS);

    // Как и подметание, отложенный проход процесс не держит.
    timer.unref?.();
    deferredTimer = timer;
  }

  return { ...first, stop: stopSandboxSweeper };
}

/**
 * Скрипты, выбранные сами по себе, а не через хук. Копия нужна затем же,
 * зачем и хукам: запускать в песочнице надо копию, чтобы запуск не задел
 * настоящий файл и то, что скрипт по дороге пишет.
 */
function copyScripts(
  configDir: string,
  selection: SandboxSelection,
  location: ClaudeLocation,
  description: SandboxDescription,
): void {
  if (!selection.scriptNames?.length) return;

  const hooksDir = join(configDir, 'hooks');
  mkdirSync(hooksDir, { recursive: true });

  for (const name of selection.scriptNames) {
    const source = join(location.paths.hooks, name);
    if (!existsSync(source)) continue;

    copyFileSync(source, join(hooksDir, name));
    if (!description.scripts.includes(name)) description.scripts.push(name);
  }
}

/** Правила — это текст в CLAUDE.md, поэтому файл собирается из выбранных. */
function writeRules(
  configDir: string,
  selection: SandboxSelection,
  location: ClaudeLocation,
  store: AppStore,
): string[] {
  const parts: string[] = [];
  const names: string[] = [];

  if (selection.ruleIds?.length) {
    const all = readRules(location.paths.claudeMd, store);

    for (const rule of all.filter((item) => selection.ruleIds?.includes(item.id))) {
      parts.push(`## ПРАВИЛО: ${rule.title}\n\n${rule.body}`);
      names.push(rule.title);
    }
  }

  if (selection.draftRule) {
    parts.push(`## ПРАВИЛО: ${selection.draftRule.title}\n\n${selection.draftRule.text}`);
    names.push(`${selection.draftRule.title} (черновик)`);
  }

  if (parts.length > 0) {
    writeFileSync(join(configDir, 'CLAUDE.md'), `${parts.join('\n\n')}\n`, 'utf8');
  }

  return names;
}

/** Скиллы — каталоги, поэтому копируются целиком со всем содержимым. */
function copySkills(
  configDir: string,
  selection: SandboxSelection,
  location: ClaudeLocation,
  store: AppStore,
): string[] {
  if (!selection.skillIds?.length) return [];

  const skills = readSkills(location.paths.skills, store).filter((skill) =>
    selection.skillIds?.includes(skill.id),
  );
  if (skills.length === 0) return [];

  mkdirSync(join(configDir, 'skills'), { recursive: true });

  return skills.map((skill) => {
    // Идентификатор скилла — имя его папки, оттуда и копируем целиком:
    // скилл может тянуть за собой references/ и шаблоны.
    //
    // Копируем `copyRecursive`, а не `cpSync`: рекурсивный cpSync на путях с
    // нелатинскими символами убивает процесс молча, без исключения и с нулевым
    // кодом (см. safe-io.ts), а имя папки скилла пишет пользователь.
    const source = join(location.paths.skills, skill.id);
    if (existsSync(source)) {
      copyRecursive(source, join(configDir, 'skills', skill.id));
    }
    return skill.name;
  });
}

/**
 * Настройки песочницы: выбранные хуки и MCP-серверы плюс запреты, которые
 * не дают выйти за её пределы.
 */
function buildSettings(
  configDir: string,
  selection: SandboxSelection,
  location: ClaudeLocation,
  store: AppStore,
  description: SandboxDescription,
): Record<string, unknown> {
  const settings: Record<string, unknown> = {
    permissions: { deny: denyRules(location) },
  };

  const hooks = collectHooks(configDir, selection, location, store, description);
  if (Object.keys(hooks).length > 0) settings.hooks = hooks;

  const servers = collectMcpServers(selection, location, store, description);
  if (Object.keys(servers).length > 0) settings.mcpServers = servers;

  return settings;
}

/**
 * Границы песочницы. Правки и так разрешены только в рабочей папке, но запреты
 * добавляют второй рубеж: настоящую конфигурацию нельзя ни прочитать, ни
 * изменить, а файл с токенами закрыт целиком.
 */
function denyRules(location: ClaudeLocation): string[] {
  const real = location.paths.root.replace(/\\/g, '/');

  return [
    `Read(${real}/.credentials.json)`,
    `Read(${real}/.mcp-secrets.env)`,
    `Edit(${real}/**)`,
    `Write(${real}/**)`,
    'Bash(rm -rf /*)',
    'Bash(shutdown:*)',
  ];
}

/** Хуки: их описания идут в настройки, а файлы скриптов — рядом. */
function collectHooks(
  configDir: string,
  selection: SandboxSelection,
  location: ClaudeLocation,
  store: AppStore,
  description: SandboxDescription,
): Record<string, unknown[]> {
  if (!selection.hookIds?.length) return {};

  const hooksDir = join(configDir, 'hooks');
  mkdirSync(hooksDir, { recursive: true });

  const result: Record<string, unknown[]> = {};

  for (const hook of readHooks(location.paths.settings, store)) {
    if (!selection.hookIds.includes(hook.id)) continue;

    let command = hook.command;

    // Скрипт копируем в песочницу и подменяем путь: хук должен запускать
    // копию, иначе правки в песочнице задели бы настоящий файл.
    if (hook.scriptPath && existsSync(hook.scriptPath)) {
      const name = hook.scriptPath.split(/[\\/]/).pop() ?? 'hook.mjs';
      const target = join(hooksDir, name);

      copyFileSync(hook.scriptPath, target);
      command = command.split(hook.scriptPath).join(target);
      description.scripts.push(name);
    }

    const entry = { matcher: hook.matcher ?? '', hooks: [{ type: 'command', command }] };
    result[hook.event] = [...(result[hook.event] ?? []), entry];
    description.hooks.push(`${hook.event}${hook.matcher ? ` · ${hook.matcher}` : ''}`);
  }

  return result;
}

function collectMcpServers(
  selection: SandboxSelection,
  location: ClaudeLocation,
  store: AppStore,
  description: SandboxDescription,
): Record<string, unknown> {
  if (!selection.mcpIds?.length) return {};

  const result: Record<string, unknown> = {};

  for (const server of readMcpServers(location.paths.mcpConfig, store)) {
    if (!selection.mcpIds.includes(server.id)) continue;

    result[server.name] = {
      type: server.transport,
      command: server.command,
      args: server.args,
      env: server.env,
      url: server.url,
      headers: server.headers,
    };
    description.mcpServers.push(server.name);
  }

  return result;
}
