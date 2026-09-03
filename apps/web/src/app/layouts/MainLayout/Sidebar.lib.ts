import type { ProviderInfo } from '@claude-control/contracts';
import type { GatedNavItem } from '@entities/Provider';

/**
 * Подпись пункта меню. Раздел инструкций называется файлом, который правит: у
 * Claude — CLAUDE.md, у Codex/Kimi/OpenCode — AGENTS.md, у Gemini — GEMINI.md; у
 * провайдера без единого файла (список у Aider, каталог правил у Cursor) — общее
 * «Инструкции». Иначе меню обещало CLAUDE.md, а редактировался AGENTS.md.
 * Решает МОДЕЛЬ, не id провайдера: у Claude модель `file` и имя CLAUDE.md.
 */
export function navItemLabel(
  item: GatedNavItem,
  active: ProviderInfo | undefined,
  t: (key: string) => string,
): string {
  if (item.key !== 'claudeMd' || !active) return t(item.label);
  if (active.instructionsModel === 'file' && active.instructionsFileName) {
    return active.instructionsFileName;
  }
  return t('nav.instructions');
}

/**
 * Подсказка браузера для пункта меню. В свёрнутой панели подписи не видно —
 * её заменяет title, а раздел в разработке дописывает к нему пометку. В
 * развёрнутой подпись видна сама, поэтому подсказки нет вовсе.
 */
export function navItemTitle(
  item: GatedNavItem,
  labelText: string,
  isCollapsed: boolean,
  t: (key: string) => string,
): string | undefined {
  if (!isCollapsed) return undefined;
  if (item.access === 'inDevelopment') return `${labelText} — ${t('providers.inDevelopment')}`;
  return labelText;
}
