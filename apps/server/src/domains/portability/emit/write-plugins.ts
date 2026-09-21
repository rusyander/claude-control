import { existsSync, statSync } from 'node:fs';
import type { EmitEntry } from '@agentdeck/contracts/portable-emit';
import type { FidelityVerdict } from '@agentdeck/contracts/portable-fidelity';
import type { PluginItem } from '@agentdeck/contracts/portable-env';
import { readProviderPluginsInfo } from '../../provider-plugins/info.ts';
import { saveProviderPluginFile } from '../../provider-plugins/files.ts';
import { saveProviderPluginPackages } from '../../provider-plugins/packages.ts';
import { hasPluginExtension, resolvePluginPath } from '../../provider-plugins/paths.ts';
import type { ProviderPluginsTarget } from '../../provider-plugins/types.ts';
import { readTextFile } from '../../../lib/safe-io.ts';
import {
  claimTargetFile,
  EmitMechanismMissingError,
  emitEntry,
  verdictOf,
  type EmitContext,
  type StageResult,
} from './context.ts';

/**
 * Плагины как ЕДИНИЦА.
 *
 * Содержимое плагина этот этап не возит вовсе: скиллы, команды, хуки и
 * субагенты приехали обычными записями со своим происхождением
 * (`source.plugin`), и их пишут свои слои. Здесь — только сам плагин, и едет он
 * ровно двумя формами, у каждой из которых задокументирован свой механизм:
 *
 *  - `module` — файл кода в каталоге плагинов цели. Содержимое канон везёт в
 *    `raw`: это исходник модуля, и он же весь плагин.
 *  - `package` — имя npm-пакета в списке конфига. Едет ИМЯ; пакет ставит сам
 *    CLI, а установка у цели прямо вне объёма партии.
 *
 * Форма `installed` сюда не доходит: её приговор — `unit_not_installable`, и
 * строку о ней пишет этап рантайма. Это и есть «плагин переносится содержимым»:
 * единица магазина остаётся у источника, а то, что она приносила, доезжает
 * записями.
 */
export function emitPluginsLayer(context: EmitContext): StageResult {
  const result: StageResult = { entries: [], writes: [] };
  const items = context.items.filter((item): item is PluginItem => item.kind === 'plugin');
  if (items.length === 0) return result;

  const target = context.targets.plugins;
  const info = target ? readProviderPluginsInfo(target) : undefined;
  /** Имена пакетов у цели — новые дописываются к ним, а не вместо них. */
  const packages: string[] = [...(info?.packages ?? [])];
  const packagesBefore = packages.length;
  const carriedPackages: string[] = [];

  for (const item of items) {
    const verdict = verdictOf(context, item);
    if (verdict.level !== 'native') continue;
    if (!target) throw new EmitMechanismMissingError(context.deps.target.id, 'plugin');

    if (!item.enabled) {
      // Выключателя ни у файла, ни у списка пакетов нет: записанный плагин
      // загружается. Включить то, что человек выключил сам, перенос не вправе.
      result.entries.push(emitEntry(item, verdict, 'disabled_at_source', target.pluginsDir));
      continue;
    }

    if (item.form === 'package') {
      const entry = carryPackage({ item, verdict, target, packages, info });
      result.entries.push(entry.entry);
      if (entry.carried) carriedPackages.push(item.id);
      continue;
    }

    result.entries.push(carryModule({ item, verdict, target, result, context }));
  }

  if (target?.configPath && packages.length !== packagesBefore) {
    const draft = [...packages];
    result.writes.push({
      kind: 'plugin',
      itemIds: carriedPackages,
      filePath: target.configPath,
      apply: (backupDir) => void saveProviderPluginPackages(target, draft, backupDir),
      applyTo: (path) =>
        void saveProviderPluginPackages({ ...target, configPath: path }, draft, undefined),
    });
  }

  return result;
}

/**
 * Имя пакета в списке конфига. Повтор того же имени НЕ создаёт второй записи
 * (инвариант 10): тождество здесь — само имя, другого ключа у строки списка нет.
 */
function carryPackage(params: {
  item: PluginItem;
  verdict: FidelityVerdict;
  target: ProviderPluginsTarget;
  packages: string[];
  info: { packagesReadOnly?: boolean } | undefined;
}): { entry: EmitEntry; carried: boolean } {
  const { item, verdict, target, packages, info } = params;

  // Списка у цели нет (`configPath` не задокументирован) или конфиг не разобран:
  // дописать имя в файл, формы которого панель не поняла, значило бы переписать
  // его своим представлением о ней.
  if (!target.configPath || info?.packagesReadOnly) {
    return {
      entry: emitEntry(item, verdict, 'refused_by_target', target.configPath ?? null),
      carried: false,
    };
  }

  if (!packages.includes(item.name)) packages.push(item.name);
  return { entry: emitEntry(item, verdict, 'written', target.configPath), carried: true };
}

/**
 * Файл плагина в каталоге цели. Файл с тем же именем и ДРУГИМ содержимым не
 * перезаписывается: выбор между двумя версиями чужого кода человеческий.
 */
function carryModule(params: {
  item: PluginItem;
  verdict: FidelityVerdict;
  target: ProviderPluginsTarget;
  result: StageResult;
  context: EmitContext;
}): EmitEntry {
  const { item, verdict, target, result, context } = params;

  // Имя плагина-файла — это ПУТЬ внутри каталога, и защита пути у него та же,
  // что у раздела: попытка выйти наружу — отказ, а не «поправленное» имя.
  if (!hasPluginExtension(item.name)) {
    return emitEntry(item, verdict, 'refused_by_target', null);
  }
  let filePath: string;
  try {
    filePath = resolvePluginPath(target, item.name);
  } catch {
    return emitEntry(item, verdict, 'refused_by_target', null);
  }

  const taken =
    existsSync(filePath) && (!statSync(filePath).isFile() || readTextFile(filePath) !== item.raw);
  // Занять путь обязан и тот план, где два плагина канона носят одно имя файла.
  if (taken || !claimTargetFile(context, 'plugin', filePath)) {
    return emitEntry(item, verdict, 'collision_needs_choice', filePath);
  }

  const draft = { path: item.name, content: item.raw };
  result.writes.push({
    kind: 'plugin',
    itemIds: [item.id],
    filePath,
    // Имя плагина может нести подкаталог (`sub/plugin.ts`), и адаптер выводит
    // путь из него: плоская копия в песочнице легла бы мимо каталога.
    sandboxSegments: draft.path.split('/').length,
    apply: (backupDir) => void saveProviderPluginFile(target, draft, backupDir),
    applyTo: (path) =>
      void saveProviderPluginFile(
        { ...target, pluginsDir: sandboxPluginsDir(path, draft.path) },
        draft,
        undefined,
      ),
  });
  return emitEntry(item, verdict, 'written', filePath);
}

/**
 * Каталог плагинов в песочнице: копия лежит по тому же относительному пути, что
 * и у цели, поэтому корень — путь файла без его отрезков.
 */
function sandboxPluginsDir(path: string, relative: string): string {
  const depth = relative.split('/').length;
  return path.split(/[\\/]/).slice(0, -depth).join('/');
}
