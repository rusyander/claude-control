import type { ReadClassDef } from '@agentdeck/contracts/core/facts';
import type { Phase3ReadClasses } from '@agentdeck/contracts/core/records';

/**
 * Реестр классов чтения (01 §Facts): имя, таймаут, действие на `unknown`. По нему идёт таблица
 * отказов P44 — каждый класс, что есть сейчас, получает таймаут, ENOENT, EPERM и мусор.
 * Классы фазы 6 (пуш, MR, ответ в треде, трекер, контейнер) уже названы: их читатели —
 * типизированные заглушки, которые отвечают `unknown`, а не «нет».
 */
export const READ_CLASSES = {
  /** Жив ли процесс по pid + время старта (сверка сессий и действия `process-start`). */
  'process.alive': {
    name: 'process.alive',
    timeoutMs: 10_000,
    onUnknown: 'retry-until',
    retryUntilMs: 60_000,
  },
  /** Есть ли каталог копии (действия `copy-create` / `copy-remove`). */
  'copy.exists': {
    name: 'copy.exists',
    timeoutMs: 5_000,
    onUnknown: 'retry-until',
    retryUntilMs: 60_000,
  },
  /** Свой файл ядра (снимок, владелец аренды, procs.json) — читается при открытии. */
  'core.file': { name: 'core.file', timeoutMs: 5_000, onUnknown: 'refuse' },
  'push.remote-sha': {
    name: 'push.remote-sha',
    timeoutMs: 30_000,
    onUnknown: 'retry-until',
    retryUntilMs: 30 * 60_000,
    stubUntilPhase: 6,
  },
  'mr.by-source-branch': {
    name: 'mr.by-source-branch',
    timeoutMs: 30_000,
    onUnknown: 'retry-until',
    retryUntilMs: 30 * 60_000,
    stubUntilPhase: 6,
  },
  'thread.reply-by-hash': {
    name: 'thread.reply-by-hash',
    timeoutMs: 30_000,
    onUnknown: 'retry-until',
    retryUntilMs: 30 * 60_000,
    stubUntilPhase: 6,
  },
  'tracker.write-by-hash': {
    name: 'tracker.write-by-hash',
    timeoutMs: 30_000,
    onUnknown: 'retry-until',
    retryUntilMs: 30 * 60_000,
    stubUntilPhase: 6,
  },
  'container.by-label': {
    name: 'container.by-label',
    timeoutMs: 15_000,
    onUnknown: 'retry-until',
    retryUntilMs: 10 * 60_000,
    stubUntilPhase: 3,
  },
  // Факты маршрута (11 R:PR-03, P111). Действие класса — по умолчанию; маршрут объявляет своё
  // в `Route.facts` (вход CLI: доступность `unknown` → запуск, отказ читается в потоке).
  /** Маршрут поднят / поднимется сам; облачный `unknown` — единицы ждут в безопасной точке (P77). */
  'route.availability': {
    name: 'route.availability',
    timeoutMs: 10_000,
    onUnknown: 'retry-until',
    retryUntilMs: 10 * 60_000,
  },
  'route.models': { name: 'route.models', timeoutMs: 10_000, onUnknown: 'run' },
  /** Окно без задокументированного события — `unknown` → запуск, отказ читается в потоке (11 R:PR-06). */
  'route.limit': { name: 'route.limit', timeoutMs: 10_000, onUnknown: 'run' },
  /** Цена неизвестна → только токены, никогда угаданная цена (P127). */
  'route.price': { name: 'route.price', timeoutMs: 10_000, onUnknown: 'run' },
  /** Только наличие доступа; нечитаемое хранилище — отказ, не «ключа нет». */
  'route.credential': { name: 'route.credential', timeoutMs: 5_000, onUnknown: 'refuse' },
  'route.context': { name: 'route.context', timeoutMs: 10_000, onUnknown: 'run' },
  /** Память карты (P129): `unknown` → подбор по оценке, названный в решении. */
  'gpu.memory': { name: 'gpu.memory', timeoutMs: 20_000, onUnknown: 'run' },
  // Этап 3, проверки (04, `core/records.ts`). «Сомнение — прогон» (04:55): нечитаемое хранилище
  // или дерево ведут к прогону, а не к повтору записи; реестр, движок, доступ к репозиторию и стенд
  // без ответа — отказ: зелёного без них не бывает (P58, P106).
  /** Записи проверок в хранилище (`<common>/agentdeck-verify/v2/`). */
  'check.records': { name: 'check.records', timeoutMs: 5_000, onUnknown: 'run' },
  /**
   * Реестр проверок проекта — источник команды и единиц: неизвестный — гнать нечего, угадать нельзя
   * (P44), пустой набор дал бы зелёный без проверок. Отказ `registry-unreadable` (fix-w2R-X01).
   */
  'check.registry': { name: 'check.registry', timeoutMs: 10_000, onUnknown: 'refuse' },
  /** Строки дерева git (путь, режим, blob) для ключа. */
  'git.tree': { name: 'git.tree', timeoutMs: 30_000, onUnknown: 'run' },
  /** Профиль репозитория в доме ядра. */
  'profile.read': { name: 'profile.read', timeoutMs: 10_000, onUnknown: 'run' },
  /** Кейсы блока тестов; без сопоставления запись остаётся записью (P50). */
  'tests.cases': { name: 'tests.cases', timeoutMs: 5_000, onUnknown: 'run' },
  /** Движок контейнеров: нет ответа — `no-verdict(env)`, не зелёный (P58). */
  'engine.info': { name: 'engine.info', timeoutMs: 10_000, onUnknown: 'refuse' },
  /** Свободное место диска (04 §Machine resources). */
  'machine.disk': { name: 'machine.disk', timeoutMs: 5_000, onUnknown: 'run' },
  /** Доступ к папке репозитория; TCC macOS — `unknown(tcc)` (P106). */
  'repo.access': { name: 'repo.access', timeoutMs: 5_000, onUnknown: 'refuse' },
  /** Здоровье стенда задачи: нет ответа — `no-verdict(stand)`. */
  'stand.health': { name: 'stand.health', timeoutMs: 5_000, onUnknown: 'refuse' },
  /** Каталог `spool/` захвата без ядра. */
  'capture.spool': {
    name: 'capture.spool',
    timeoutMs: 5_000,
    onUnknown: 'retry-until',
    retryUntilMs: 60_000,
  },
} as const satisfies Record<string, ReadClassDef>;

/**
 * Классы этапа 3 в контракте (`Phase3ReadClasses`, `core/records.ts`) привязаны к реестру: срок
 * или действие на `unknown` разошлись — ошибка сборки, а не два ответа на один вопрос (A1r4-F08).
 */
type Bound<T extends Phase3ReadClasses> = T;
export type Phase3ReadClassesBound = Bound<typeof READ_CLASSES>;

export type ReadClassName = keyof typeof READ_CLASSES;
export const READ_CLASS_NAMES = Object.keys(READ_CLASSES) as ReadClassName[];
