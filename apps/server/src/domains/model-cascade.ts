import { dirname, basename } from 'node:path';
import type { AppSettings, ModelInfo } from '@agentdeck/contracts';
import {
  ASSIGNABLE_MODELS,
  type CascadeCeiling,
  type AssignableModel,
} from '@agentdeck/contracts/model-cascade';
import { newestInFamily } from './models/model-defaults.ts';
import { normalizeProjectPath } from '../lib/app-store/projects.ts';
import { WORKTREES_DIR_SUFFIX } from './project-git/worktrees.ts';
import { matchesProject } from './group-activation.ts';

/**
 * Правило «подбирать модель под задачу» в его проектной области.
 *
 * Тумблер стоит в правах чата, но помнится на ПРОЕКТ: решение «здесь всё делает
 * только выбранная мной модель» относится к репозиторию и его цене ошибки, а не
 * к разговору, который человек заведёт завтра заново. Хранилище (`app-store/
 * cascade.ts`) знает только «путь → выключено»; кому этот путь соответствует —
 * решается здесь, потому что рабочая папка прогона это не всегда сам проект:
 * бывает подпапка, а бывает копия ветки `<репозиторий>-worktrees/<ветка>`.
 */

/**
 * Проект, к которому относится рабочая папка. Копия ветки — тот же проект, и
 * выключенное в репозитории правило обязано действовать и в ней: иначе агент,
 * заведённый разделением (а он ВСЕГДА работает в копии), правила бы не заметил.
 */
export function cascadeProjectKey(cwd: string): string {
  const normalized = normalizeProjectPath(cwd);
  if (!normalized) return '';

  const marker = `${WORKTREES_DIR_SUFFIX}/`;
  const at = normalized.lastIndexOf(marker);
  if (at < 0) return normalized;

  // `.../repo-worktrees/branch` → `.../repo`: отрезаем суффикс каталога копий
  // вместе с именем ветки, каким бы вложенным оно ни было (`feature/x`).
  const copies = normalized.slice(0, at + WORKTREES_DIR_SUFFIX.length);
  return `${dirname(copies)}/${basename(copies).slice(0, -WORKTREES_DIR_SUFFIX.length)}`;
}

/**
 * Действует ли подбор в этой рабочей папке. Умолчание — ВКЛЮЧЕНО: правило
 * существует, пока его не выключили, и запись в состоянии есть только у
 * выключенных проектов.
 *
 * Совпадений может быть несколько (проект и его подпапка, заведённая отдельно) —
 * выигрывает самое длинное: правило, поставленное ближе к работе, точнее.
 */
export function isCascadeEnabled(entries: Array<[string, boolean]>, cwd: string): boolean {
  const target = cascadeProjectKey(cwd);
  if (!target) return true;

  let best = '';
  let enabled = true;
  for (const [path, value] of entries) {
    if (!matchesProject(path, target)) continue;
    if (path.length < best.length) continue;
    best = path;
    enabled = value;
  }
  return enabled;
}

/**
 * Потолок разговора, если подбор в этом проекте действует. `undefined` — правило
 * выключено, и дальше по коду каскада нет вовсе: ни строки агенту, ни подбора
 * при запуске, ни пометки «проверить». Одна функция на все три места намеренно —
 * иначе где-то одном условие разошлось бы, и панель обещала бы одно, а
 * запускала другое.
 *
 * Оверрайд шапки чата сильнее настройки: человек, поставивший модель на этот
 * разговор, назначил потолок именно ему.
 */
export function cascadeCeilingFor(
  deps: {
    entries: Array<[string, boolean]>;
    settings: Pick<AppSettings, 'chatModel' | 'chatEffort'>;
  },
  cwd: string,
  override: { model?: string; effort?: string } = {},
): CascadeCeiling | undefined {
  if (!isCascadeEnabled(deps.entries, cwd)) return undefined;

  return {
    model: override.model || deps.settings.chatModel,
    effort: override.effort || deps.settings.chatEffort,
  };
}

/**
 * Алиас CLI → самая свежая модель этого семейства из каталога.
 *
 * Зачем вообще: партия подбора держит инвариант «устаревшее поколение
 * недостижимо» — назначать разрешено только алиасы, а алиас, как считалось,
 * всегда ведёт на свежую модель семейства. Живые прогоны 07.09.2026 показали
 * обратное: `--model sonnet` пошёл на `claude-sonnet-4-6`, `--model opus` — на
 * `claude-opus-4-8`, при том что в каталоге есть и Sonnet 5, и Opus 5, и
 * человек в шапке выбрал именно Opus 5. То есть алиас у CLI значит не «свежая
 * модель семейства», а «рекомендованная для этого уровня», и понижение ранга
 * молча превращалось ещё и в понижение ПОКОЛЕНИЯ — ровно то, чего партия
 * обещала не делать.
 *
 * Поэтому разворачивает алиас панель, а не CLI, и делает это в последний момент
 * — уже после клэмпа: сравнение силы живёт на алиасах (`MODEL_RANK`), и
 * конкретные имена ему только мешали бы.
 *
 * Не алиас (человек выбрал конкретное имя) — возвращается как есть: это его
 * выбор, а не наш подбор. Каталога нет или семейство в нём пустое — тоже как
 * есть: гадать не о чем, а прогон с алиасом заведомо запустится.
 */
export function expandAssignedModel(models: ModelInfo[], model: string): string {
  const alias = ASSIGNABLE_MODELS.find((known): known is AssignableModel => known === model);
  if (!alias) return model;

  return newestInFamily(models, `claude-${alias}`)?.id ?? model;
}
