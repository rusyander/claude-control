import { dirname, basename } from 'node:path';
import type { AppSettings } from '@agentdeck/contracts';
import type { CascadeCeiling } from '@agentdeck/contracts/model-cascade';
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
