import { dirname } from 'node:path';
import type { EnvVarItem, HookItem, McpServerItem } from '@agentdeck/contracts/portable-env';
import type { ProviderHookRule } from '@agentdeck/contracts';
import { readProviderEnvVars, saveProviderEnvVars } from '../../provider-env.ts';
import type { ProviderEnvVar, UniversalMcpServerDraft } from '@agentdeck/contracts';
import { readProviderHooksInfo } from '../../provider-hooks/info.ts';
import { saveProviderHookRules } from '../../provider-hooks/event-rules.ts';
import { readProviderMcpServers, upsertProviderMcpServer } from '../../provider-mcp/section.ts';
import type { ProviderMcpTarget } from '../../provider-mcp/types.ts';
import { targetEventName } from '../fidelity.ts';
import { hookCommandForTarget } from './hook-command.ts';
import { hookShimCommand, hookShimPath, installHookShim } from './hook-shim.ts';
import {
  EmitMechanismMissingError,
  emitEntry,
  ownedByPanel,
  verdictOf,
  type EmitContext,
  type StageResult,
} from './context.ts';

/**
 * Слои, которые у цели лежат КЛЮЧАМИ в её конфиге: хуки, MCP-серверы,
 * переменные окружения.
 *
 * Ни один из них не пишется здесь руками: за формой файла, чужими ключами и
 * резервной копией отвечают адаптеры разделов (`saveProvider*`), и каждый из них
 * сверяет свой результат с намерением ДО записи. Поэтому критерий «незнакомые
 * ключи и соседние записи остаются по значению» выполняется адаптером, а не
 * повторяется здесь второй реализацией.
 */
export function emitConfigLayers(context: EmitContext): StageResult {
  const hooks = emitHooks(context);
  const mcp = emitMcp(context);
  const env = emitEnvVars(context);
  return {
    entries: [...hooks.entries, ...mcp.entries, ...env.entries],
    writes: [...hooks.writes, ...mcp.writes, ...env.writes],
  };
}

/**
 * Положить переходники рядом с конфигом цели.
 *
 * Идемпотентно и не молча: `installHookShim` не перезаписывает файл, который
 * человек правил руками, и повторное применение того же плана не создаёт правки
 * (инвариант 10).
 */
function installShims(
  dir: string,
  shims: readonly { event: string; command: string }[],
  backupDir: string | undefined,
): void {
  for (const shim of shims) {
    installHookShim({
      dir,
      event: shim.event,
      command: shim.command,
      ...(backupDir ? { backupDir } : {}),
    });
  }
}

/**
 * Хуки: весь раздел пишется ОДНИМ черновиком — и у Qwen (ключ `hooks`), и у
 * Kimi (регион `[[hooks]]`) адаптер принимает список целиком. Поэтому чужие
 * правила читаются и едут в том же списке: передать только свои значило бы
 * стереть остальные.
 */
function emitHooks(context: EmitContext): StageResult {
  const result: StageResult = { entries: [], writes: [] };
  const items = context.items.filter((item): item is HookItem => item.kind === 'hook');
  if (items.length === 0) return result;

  const target = context.targets.hooks;
  const info = target ? readProviderHooksInfo(target) : undefined;
  const rules: ProviderHookRule[] = info?.error ? [] : [...(info?.rules ?? [])];
  const before = rules.length;
  const carried: string[] = [];
  /** Переходники, которые нужно положить рядом с конфигом при применении. */
  const shims: { event: string; command: string }[] = [];

  for (const item of items) {
    const verdict = verdictOf(context, item);
    if (verdict.level !== 'native') continue;
    if (!target || !info || info.error) {
      throw new EmitMechanismMissingError(context.deps.target.id, 'hook');
    }

    if (!item.enabled) {
      // У обоих форматов выключателя нет: записанный хук исполняется. Включить
      // то, что человек выключил сам, перенос не имеет права.
      result.entries.push(emitEntry(item, verdict, 'disabled_at_source', target.filePath));
      continue;
    }

    const event = targetEventName(context.deps.target, item.trigger);
    if (!event) throw new EmitMechanismMissingError(context.deps.target.id, 'hook');

    // Переходник (П3.3): в конфиг цели встаёт не скрипт человека, а сгенерированный
    // рядом посредник — он приводит нагрузку хозяина к форме Claude и зовёт
    // исходный скрипт по его пути, не правя и не копируя его. Путь считается
    // здесь, а САМ ФАЙЛ пишется в момент применения: этап расчёта ничего на диск
    // не кладёт, иначе правка ушла бы без резервной копии и без плана.
    const userCommand = hookCommandForTarget(item);
    shims.push({ event, command: userCommand });

    const rule: ProviderHookRule = {
      event,
      // Путь скрипта — абсолютный и в написании, которое цель исполнит: скрипты
      // хуков не копируются, они зовутся по своему пути на этой же машине.
      command: hookShimCommand(
        hookShimPath(dirname(target.filePath), { event, command: userCommand }),
      ),
      ...(matcherOf(item) ? { matcher: matcherOf(item) as string } : {}),
      ...(timeoutFor(item, info.timeoutUnit) === undefined
        ? {}
        : { timeout: timeoutFor(item, info.timeoutUnit) as number }),
    };

    // Повторное применение того же плана не создаёт второй записи (инвариант 10):
    // тождество хука — событие, матчер и команда, потому что список у обоих
    // форматов плоский и ключа у записи нет.
    if (!rules.some((existing) => sameRule(existing, rule))) rules.push(rule);
    carried.push(item.id);
    result.entries.push(emitEntry(item, verdict, 'written', target.filePath));
  }

  if (target && rules.length !== before) {
    const draft = { rules };
    result.writes.push({
      kind: 'hook',
      itemIds: carried,
      filePath: target.filePath,
      apply: (backupDir) => {
        installShims(dirname(target.filePath), shims, backupDir);
        void saveProviderHookRules(target, draft, backupDir);
      },
      applyTo: (path) => {
        // Предпросмотр пишет конфиг в другое место — переходники кладутся туда же,
        // иначе команда в показанном файле вела бы на файл, которого там нет.
        installShims(dirname(path), shims, undefined);
        void saveProviderHookRules(
          { ...target, filePath: path, backupName: undefined },
          draft,
          undefined,
        );
      },
    });
  }

  return result;
}

/**
 * MCP-серверы: ОДНА правка на файл цели, сколько бы серверов ни ехало.
 *
 * Правка на сервер выглядела бы честнее — каждый `upsert` перечитывает файл, и
 * записи не затирают друг друга, — но у всех целей MCP ложатся в один файл, и
 * план получал несколько правок одного слоя с одним путём. Страж плана
 * (`assertNoSilentOverwrite`) такое запрещает по делу: отличить «перечитывает и
 * дописывает» от «затирает» он не может, а цена ошибки — молча потерянная
 * запись. Дом с двумя серверами и больше падал из-за этого 500 на самом
 * построении плана; фикстуры несли по одному, и юниты этого не видели.
 *
 * Внутри — тот же `upsert`, которым правит панель, по серверу за раз: имя,
 * занятое ДРУГИМ сервером, адаптер отвергает (`McpServerExistsError`) — выбор
 * между двумя записями человеческий, а не эмиттера.
 */
function emitMcp(context: EmitContext): StageResult {
  const result: StageResult = { entries: [], writes: [] };
  const items = context.items.filter((item): item is McpServerItem => item.kind === 'mcpServer');
  if (items.length === 0) return result;

  const target = context.targets.mcp;
  const existing = target ? readProviderMcpServers(target) : [];
  /** Серверы, которые поедут, — все в одну правку файла цели. */
  const carried: { itemId: string; name: string; draft: UniversalMcpServerDraft }[] = [];

  for (const item of items) {
    const verdict = verdictOf(context, item);
    if (verdict.level !== 'native') continue;
    if (!target) throw new EmitMechanismMissingError(context.deps.target.id, 'mcpServer');

    if (!item.enabled) {
      // Выключателя у чужих форматов нет: записанный сервер ДЕЙСТВУЕТ. Сервер,
      // выключенный человеком у источника, приехал бы к цели работающим — то
      // есть перенос включил бы то, что было выключено намеренно (П2.6).
      result.entries.push(emitEntry(item, verdict, 'disabled_at_source', target.filePath));
      continue;
    }

    // Транспорт `sdk` сюда не доходит: приговор объявляет его непереносимым.
    // `sse` доходит, а универсальный черновик его не выражает — панель пишет
    // только `stdio` и `http`. Выдать sse-сервер за http значило бы записать
    // чужому CLI адрес, по которому он пойдёт другим протоколом.
    if (item.transport !== 'stdio' && item.transport !== 'http') {
      result.entries.push(emitEntry(item, verdict, 'refused_by_target', target.filePath));
      continue;
    }

    const draft = {
      name: item.name,
      transport: item.transport,
      ...(item.command ? { command: item.command } : {}),
      args: [...item.args],
      // Значений переменных канон не носит (инвариант 5) — пустая карта здесь
      // не потеря формы, а отказ выдумывать значения. Ключи доедут окружением
      // запуска (П3.5); круговая проверка держит это в списке объявленных
      // деградаций, чтобы потеря не была молчаливой.
      env: {},
      ...(item.url ? { url: item.url } : {}),
      headers: {},
    };

    const already = existing.find((server) => server.name === item.name);
    if (already && !sameServer(already, draft) && !ownedByPanel(context, item)) {
      result.entries.push(emitEntry(item, verdict, 'collision_needs_choice', target.filePath));
      continue;
    }

    carried.push({ itemId: item.id, name: item.name, draft });
    result.entries.push(emitEntry(item, verdict, 'written', target.filePath));
  }

  if (target && carried.length > 0) {
    // Серверы пишутся ПО ОЧЕРЕДИ и каждый своим `upsert`: файл перечитывается
    // перед каждым, так что второй видит первого и дописывается к нему.
    //
    // Повтор того же самого — `allowOverwrite`: запись уже наша и совпала по
    // значению, иначе сюда бы не дошли. Но ЕСТЬ ЛИ она, спрашивается в момент
    // записи, а не при построении плана: после первого применения сервер в файле
    // уже лежит — свой собственный, — и решённое заранее «создать» превратило бы
    // второй прогон того же плана в отказ «сервер уже есть».
    const write = (into: ProviderMcpTarget, backupDir: string | undefined): void => {
      for (const server of carried) {
        const lives = readProviderMcpServers(into).some((live) => live.name === server.name);
        void upsertProviderMcpServer(into, lives ? server.name : null, server.draft, backupDir, {
          allowOverwrite: lives,
        });
      }
    };

    result.writes.push({
      kind: 'mcpServer',
      itemIds: carried.map((server) => server.itemId),
      filePath: target.filePath,
      apply: (backupDir) => write(target, backupDir),
      applyTo: (path) => write({ ...target, filePath: path, backupName: undefined }, undefined),
    });
  }

  return result;
}

/**
 * Переменные окружения: адаптер принимает НАБОР целиком, поэтому существующие
 * переменные цели читаются и едут вместе с новыми. Переменная с тем же именем и
 * ДРУГИМ значением не перезаписывается: чьё значение верное — вопрос к человеку.
 */
function emitEnvVars(context: EmitContext): StageResult {
  const result: StageResult = { entries: [], writes: [] };
  const items = context.items.filter((item): item is EnvVarItem => item.kind === 'envVar');
  if (items.length === 0) return result;

  const target = context.targets.env;
  const vars: ProviderEnvVar[] = target ? [...readProviderEnvVars(target)] : [];
  const before = vars.length;
  const carried: string[] = [];

  for (const item of items) {
    const verdict = verdictOf(context, item);
    if (verdict.level !== 'native') continue;
    if (!target) throw new EmitMechanismMissingError(context.deps.target.id, 'envVar');

    const already = vars.find((variable) => variable.key === item.name);
    if (already && already.value !== item.value && !ownedByPanel(context, item)) {
      result.entries.push(emitEntry(item, verdict, 'collision_needs_choice', target.filePath));
      continue;
    }
    if (!already) vars.push({ key: item.name, value: item.value });
    carried.push(item.id);
    result.entries.push(emitEntry(item, verdict, 'written', target.filePath));
  }

  if (target && vars.length !== before) {
    result.writes.push({
      kind: 'envVar',
      itemIds: carried,
      filePath: target.filePath,
      apply: (backupDir) => void saveProviderEnvVars(target, vars, backupDir),
      applyTo: (path) =>
        void saveProviderEnvVars(
          { ...target, filePath: path, backupName: undefined },
          vars,
          undefined,
        ),
    });
  }

  return result;
}

/** Матчер хука есть только у событий инструмента. */
function matcherOf(item: HookItem): string | null {
  return item.trigger.on === 'tool' ? item.trigger.match : null;
}

/**
 * Таймаут в единице ЦЕЛИ. Единица едет вместе со значением (`qwen` — мс,
 * `kimi` — секунды), поэтому пересчёт здесь обязателен: число без единицы
 * превратило бы шестьдесят секунд в шестьдесят миллисекунд.
 */
function timeoutFor(item: HookItem, unit: 'ms' | 's' | undefined): number | undefined {
  if (!item.timeout) return undefined;
  const target = unit ?? 's';
  if (item.timeout.unit === target) return item.timeout.value;
  return target === 'ms' ? item.timeout.value * 1000 : Math.ceil(item.timeout.value / 1000);
}

/** Тождество хука в плоском списке: событие, матчер и команда. */
function sameRule(left: ProviderHookRule, right: ProviderHookRule): boolean {
  return (
    left.event === right.event &&
    (left.matcher ?? null) === (right.matcher ?? null) &&
    left.command === right.command
  );
}

/** Совпадает ли сервер у цели с тем, что мы собираемся записать. */
function sameServer(
  already: {
    transport: string;
    command?: string | undefined;
    args: readonly string[];
    url?: string | undefined;
  },
  draft: { transport: string; command?: string; args: readonly string[]; url?: string },
): boolean {
  return (
    already.transport === draft.transport &&
    (already.command ?? null) === (draft.command ?? null) &&
    (already.url ?? null) === (draft.url ?? null) &&
    already.args.join('\u0000') === draft.args.join('\u0000')
  );
}
