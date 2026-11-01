import type {
  Phase4ReadClasses,
  Phase6ReadClasses,
  ReadClassDef,
} from '@agentdeck/contracts/core/facts';
import type { Phase3ReadClasses } from '@agentdeck/contracts/core/records';

/**
 * Реестр классов чтения (01 §Facts): имя, таймаут, действие на `unknown`. По нему идёт таблица
 * отказов P44 — каждый класс, что есть сейчас, получает таймаут, ENOENT, EPERM и мусор.
 * Классы публикации (пуш, MR, ответ в треде) читает форж и `ls-remote`
 * (`bootstrap/action-readers.ts`); трекера в ядре нет — его класс всегда отвечает `unknown`
 * с названной причиной, никогда «нет».
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
  },
  'mr.by-source-branch': {
    name: 'mr.by-source-branch',
    timeoutMs: 30_000,
    onUnknown: 'retry-until',
    retryUntilMs: 30 * 60_000,
  },
  'thread.reply-by-hash': {
    name: 'thread.reply-by-hash',
    timeoutMs: 30_000,
    onUnknown: 'retry-until',
    retryUntilMs: 30 * 60_000,
  },
  'tracker.write-by-hash': {
    name: 'tracker.write-by-hash',
    timeoutMs: 30_000,
    onUnknown: 'retry-until',
    retryUntilMs: 30 * 60_000,
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
  // Этап 4, дирижёр (`Phase4ReadClasses`, `core/facts.ts`). Сценарий, источник требований и дифф
  // единицы без ответа — отказ: угаданный сценарий или «готово» без диффа хуже остановки (P44).
  /** Библиотека сценариев в доме ядра (`scenarios/<id>@<v>.json`, запись один раз). */
  'scenario.library': { name: 'scenario.library', timeoutMs: 5_000, onUnknown: 'refuse' },
  /** Файл проекта `.agentdeck/scenario.json`: нечитаемый — не «файла нет». */
  'scenario.project': { name: 'scenario.project', timeoutMs: 5_000, onUnknown: 'refuse' },
  /** Настройки слоя для сверки копии Claude: `unknown` — без переписи, названо. */
  'layer.settings': { name: 'layer.settings', timeoutMs: 5_000, onUnknown: 'run' },
  /** Артефакт запроса — источник требований. */
  'requirements.source': { name: 'requirements.source', timeoutMs: 5_000, onUnknown: 'refuse' },
  /** Дифф единицы от её базы: без него вывода «готово» нет. */
  'git.diff-unit': { name: 'git.diff-unit', timeoutMs: 30_000, onUnknown: 'refuse' },
  /** История git для подсказок владения. */
  'git.history': { name: 'git.history', timeoutMs: 30_000, onUnknown: 'run' },
  /** `git fetch` базы при оценке: `unknown` — приколота локальная ссылка, названо. */
  'git.fetch-base': { name: 'git.fetch-base', timeoutMs: 60_000, onUnknown: 'run' },
  /** Выученные длительности из прошлых журналов: `unknown` — оценка `null`. */
  'durations.learned': { name: 'durations.learned', timeoutMs: 10_000, onUnknown: 'run' },
  /** Состояние копии между ходами (P69): `unknown` — бриф говорит «не прочитано». */
  'git.status': { name: 'git.status', timeoutMs: 15_000, onUnknown: 'run' },
  // Этап 6, публикация (`Phase6ReadClasses`, `core/facts.ts`). Закрытие пуша и merge-tree без
  // ответа — отказ: публиковать вслепую хуже, чем остановиться.
  /** `git ls-remote` задачи: конец шага (чужой пуш) и читатель пуша. */
  'git.ls-remote': {
    name: 'git.ls-remote',
    timeoutMs: 30_000,
    onUnknown: 'retry-until',
    retryUntilMs: 30 * 60_000,
  },
  /** Покопийный конфиг git (`pushurl`, `hooksPath`, `alias.*`): дрейф закрытия. */
  'git.worktree-config': { name: 'git.worktree-config', timeoutMs: 5_000, onUnknown: 'refuse' },
  /** `git merge-tree` с базой на сервере. */
  'git.merge-tree': { name: 'git.merge-tree', timeoutMs: 60_000, onUnknown: 'refuse' },
  /** Лента событий форжа: `unknown` — сигнал warn, назван. */
  'forge.activity': { name: 'forge.activity', timeoutMs: 30_000, onUnknown: 'run' },
  /** Нити MR, прочитанные один раз при открытии. */
  'forge.threads': {
    name: 'forge.threads',
    timeoutMs: 30_000,
    onUnknown: 'retry-until',
    retryUntilMs: 30 * 60_000,
  },
  /** CI — только когда человек для этой задачи просил ждать (P64). */
  'forge.ci': { name: 'forge.ci', timeoutMs: 30_000, onUnknown: 'run' },
  /** Карта покрытия кейсами: `unknown` — пробел назван предупреждением. */
  'tests.coverage-map': { name: 'tests.coverage-map', timeoutMs: 5_000, onUnknown: 'run' },
} as const satisfies Record<string, ReadClassDef>;

/**
 * Классы этапов 3 и 4 в контракте (`Phase3ReadClasses` в `core/records.ts`, `Phase4ReadClasses` в
 * `core/facts.ts`) привязаны к реестру: срок или действие на `unknown` разошлись — ошибка сборки,
 * а не два ответа на один вопрос (A1r4-F08).
 */
type Bound<T extends Phase3ReadClasses> = T;
export type Phase3ReadClassesBound = Bound<typeof READ_CLASSES>;
type Bound4<T extends Phase4ReadClasses> = T;
export type Phase4ReadClassesBound = Bound4<typeof READ_CLASSES>;
type Bound6<T extends Phase6ReadClasses> = T;
export type Phase6ReadClassesBound = Bound6<typeof READ_CLASSES>;

export type ReadClassName = keyof typeof READ_CLASSES;
export const READ_CLASS_NAMES = Object.keys(READ_CLASSES) as ReadClassName[];
