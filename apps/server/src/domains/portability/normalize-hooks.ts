import { isAbsolute, resolve } from 'node:path';
import type { EnvSkip, EnvTrigger, HookItem } from '@agentdeck/contracts/portable-env';
import type { ConfigProvider } from '../../providers/types.ts';
import { envItemId, envSkip, needsUndetermined } from './canon.ts';
import { blockingOfEvent } from './hook-events.ts';
import { resolveHookNeeds, triggerOfEvent } from './needs.ts';
import type { EnvSourceFactory } from './normalize-types.ts';
import type { ObservedNeeds } from './types.ts';

/**
 * Хуки → канон.
 *
 * Хук — это произвольный код, поэтому здесь действует инвариант 9: запись
 * приезжает ВЫКЛЮЧЕННОЙ, если её источник не собственный дом человека. Включение
 * каждого скрипта — отдельное подтверждение с показанным содержимым, и решать
 * это импортёру нельзя: он передаёт факт, а не разрешение.
 *
 * Единица таймаута едет ВМЕСТЕ со значением: у `qwen` это миллисекунды, у `kimi`
 * секунды, и «60» без единицы — это либо минута, либо шестнадцать часов.
 */

/** Одно правило хука в общем виде — то, что умеют отдать все адаптеры панели. */
export interface HookInput {
  event: string;
  matcher?: string | null;
  command: string;
  timeout?: number | null;
  scriptPath?: string | null;
  enabled: boolean;
  /** Исходный кусок источника — для точного возврата записи. */
  raw?: string;
}

export interface NormalizeHooksOptions {
  source: EnvSourceFactory;
  /**
   * CLI, У КОТОРОГО снят хук. Нужен ровно за одним фактом: умеет ли ЭТО событие
   * остановить действие ЗДЕСЬ. Общего ответа на такой вопрос не существует —
   * `Stop` блокирует у Claude и у Kimi, `PermissionRequest` у Kimi нет, — и пока
   * ответ давал общий словарь канона, перенос в тот же самый CLI объявлялся
   * потерей блокировки (ревью волны П1, блокер 1).
   */
  provider: ConfigProvider;
  timeoutUnit: 'ms' | 's';
  observedNeeds?: ObservedNeeds;
  /**
   * Дом человека — источник, которому можно доверять включённость. Канон,
   * приехавший извне, несёт `enabled: false` независимо от файла.
   */
  ownMachine: boolean;
  /**
   * Работает ли раздел ЦЕЛИКОМ. Рубильник источника (`disableAllHooks` у Qwen и
   * его аналоги) опускается на каждую запись: у источника они не исполняются, и
   * приехать к цели действующими не имеют права (П2.6). Не задан — раздел
   * работает: у большинства форматов рубильника нет вовсе.
   */
  sectionEnabled?: boolean;
  /**
   * Корень, от которого источник разрешает ОТНОСИТЕЛЬНЫЙ путь скрипта. Канон
   * везёт путь уже разрешённым: относительный путь чужой CLI отсчитает от
   * своего рабочего каталога, и хук, работавший у источника, у цели молча не
   * найдёт скрипт (П2.6). Не задан — путь берётся как есть.
   */
  resolveFrom?: string;
}

export interface NormalizedHooks {
  items: HookItem[];
  skipped: EnvSkip[];
}

/**
 * Определить, что именно запускает хук. Незнакомое событие НЕ толкуется: запись
 * уходит в пропуск с причиной — записать её у цели значило бы выдумать чужое
 * событие (правило 3 универсальных провайдеров).
 */
function triggerOf(hook: HookInput): EnvTrigger | undefined {
  return triggerOfEvent(hook.event, hook.matcher ?? null);
}

export function normalizeHooks(
  hooks: readonly HookInput[],
  options: NormalizeHooksOptions,
): NormalizedHooks {
  const items: HookItem[] = [];
  const skipped: EnvSkip[] = [];

  for (const hook of hooks) {
    const trigger = triggerOf(hook);
    if (!trigger) {
      skipped.push(
        envSkip(
          'hook',
          'unsupported_format',
          `событие «${hook.event}» не описано ни у одного известного формата: нагрузку и смысл выдумывать нельзя`,
        ),
      );
      continue;
    }

    const written = hook.scriptPath ?? null;
    // Требования ищутся по ТОМУ ЖЕ пути, каким скрипт записан в команде: карта
    // наблюдений собрана живым прогоном и ключи в ней от него же.
    const observed = written ? options.observedNeeds?.get(written) : undefined;
    const scriptPath = written ? absolutePath(written, options.resolveFrom) : null;

    items.push({
      id: envItemId('hook', `${hook.event}-${hook.matcher ?? ''}-${hook.command}`),
      kind: 'hook',
      source: options.source('file'),
      intent: intentOf(hook),
      trigger,
      blocking: blockingOfEvent(options.provider, hook.event),
      needs: resolveHookNeeds({ event: hook.event, scriptPath, observed }),
      // Хук запускает процесс всегда — это и есть его определение; остальное
      // (запись файлов, сеть) разобрать по тексту команды честно нельзя.
      sideEffects: ['runs_process'],
      command: hook.command,
      scriptPath,
      timeout:
        typeof hook.timeout === 'number'
          ? { value: hook.timeout, unit: options.timeoutUnit }
          : null,
      // Инвариант 9: приехавший извне хук всегда выключен. Рубильник раздела
      // выключает и то, что в файле помечено действующим.
      enabled: options.ownMachine && options.sectionEnabled !== false && hook.enabled,
      raw: hook.raw ?? hook.command,
    });
  }

  return { items, skipped };
}

/**
 * Путь скрипта внутри команды хука — по нему проверяется, что скрипт с диска
 * человека, по нему же идёт разбор требований, и он же уезжает к цели
 * абсолютным. Берём ПЕРВЫЙ аргумент, похожий на путь файла: угадывать дальше
 * нечестно.
 *
 * Разделителем считается И прямая косая, И обратная. Путь в написании Windows
 * (`C:\Users\…\hook.mjs` — именно так его кладут и проводник, и сам JSON после
 * разбора) иначе не распознавался вовсе: скрипт не проверялся на диске, а к
 * чужому CLI команда уезжала дословно — и оболочка семейства sh съедала каждую
 * обратную косую, превращая путь в `C:Usershook.mjs` (П2.6).
 */
export function scriptPathOf(command: string): string | null {
  const match =
    /(?:^|\s)((?:[A-Za-z]:)?[^\s"']*[\\/][^\s"']*\.(?:sh|bash|js|mjs|cjs|ts|py|ps1))/.exec(command);
  return match?.[1] ?? null;
}

/**
 * Путь скрипта абсолютным. Уже абсолютный остаётся собой; относительный
 * разрешается от корня источника, а без корня — берётся как есть: выдумать
 * корень значило бы назвать в паспорте путь, которого никто не писал.
 */
function absolutePath(written: string, root: string | undefined): string {
  if (isAbsolute(written)) return written;
  return root ? resolve(root, written) : written;
}

function intentOf(hook: HookInput): string {
  const where = hook.matcher ? ` по фильтру ${hook.matcher}` : '';
  return `на событие ${hook.event}${where} запускается: ${hook.command}`;
}

/**
 * Хуки OpenCode устроены иначе: не «событие → команда», а два описанных события
 * с действиями-argv. Приводим их к общей форме, НЕ теряя того, что команда там —
 * массив аргументов (OpenCode запускает её без оболочки, и склейка в строку
 * изменила бы смысл при пробелах внутри аргумента).
 */
export function opencodeHookInputs(params: {
  fileEdited: readonly { pattern: string; actions: readonly { command: readonly string[] }[] }[];
  sessionCompleted: readonly { command: readonly string[] }[];
}): HookInput[] {
  const inputs: HookInput[] = [];

  for (const group of params.fileEdited) {
    for (const action of group.actions) {
      inputs.push({
        // `file_edited` — правка файла инструментом, то есть событие ПОСЛЕ
        // вызова инструмента; матчер — шаблон файлов.
        event: 'PostToolUse',
        matcher: group.pattern,
        command: action.command.join(' '),
        scriptPath: action.command[0] ?? null,
        enabled: true,
        raw: JSON.stringify({ pattern: group.pattern, command: action.command }),
      });
    }
  }

  for (const action of params.sessionCompleted) {
    inputs.push({
      event: 'SessionEnd',
      matcher: null,
      command: action.command.join(' '),
      scriptPath: action.command[0] ?? null,
      enabled: true,
      raw: JSON.stringify({ command: action.command }),
    });
  }

  return inputs;
}

/**
 * Хук, у которого нет ни скрипта, ни известного события, но который источник
 * СОХРАНИЛ как непонятную ему запись. Канон везёт его с требованиями
 * `undetermined`: он существует, он что-то делает, и что именно — неизвестно.
 */
export function preservedHookItem(params: {
  source: EnvSourceFactory;
  key: string;
  value: string;
}): HookItem {
  return {
    id: envItemId('hook', `preserved-${params.key}`),
    kind: 'hook',
    source: params.source('file'),
    intent: `запись ${params.key}, форму которой источник не разбирает`,
    trigger: { on: 'always' },
    blocking: 'blocks',
    needs: needsUndetermined(
      'форму записи не разбирает даже её собственный источник: что она читает — неизвестно',
    ),
    sideEffects: ['runs_process'],
    command: params.value,
    scriptPath: null,
    timeout: null,
    enabled: false,
    raw: params.value,
  };
}
