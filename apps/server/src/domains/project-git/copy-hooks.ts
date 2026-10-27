import { join } from 'node:path';
import { readJsonFile, writeJsonFile } from '../../lib/safe-io/safe-io.ts';

/**
 * Хуки локального слоя копии — те же, что у оригинала.
 *
 * Скрипты `.claude/hooks` копия получает ссылкой (`LINK_DIRS`), а
 * `settings.local.json`, где эти хуки ПРОПИСАНЫ, — копией файла на момент
 * создания. Хук, заведённый в оригинале позже, лежал в копии файлом и не
 * срабатывал никогда: 27.10.2026 запрет ручного гейта дошёл до копии группы
 * скриптом, но не записью, и группа в шестой раз гоняла тяжёлые проверки сама.
 *
 * Сверка — по тому, ЧТО запускается: событие, matcher, тип и команда (адрес,
 * текст). Лишний хук копии — не дыра: его мог прописать сам агент, как лишний
 * сервер `.mcp.json`. Добор дописывает недостающие записи и не трогает
 * остального: разрешения, накопленные в копии, и её собственные хуки.
 */

export const LOCAL_SETTINGS = '.claude/settings.local.json';

type Json = Record<string, unknown>;

interface HookRef {
  event: string;
  matcher: string;
  hook: Json;
}

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Нечитаемый файл — не дыра: сверка не вправе держать копию из-за своей неуверенности. */
function readSettings(path: string): Json | undefined {
  try {
    const data = readJsonFile<unknown>(path, undefined);
    return isObject(data) ? data : undefined;
  } catch {
    return undefined;
  }
}

function matcherOf(group: Json): string {
  return typeof group.matcher === 'string' ? group.matcher : '';
}

function refsOf(settings: Json | undefined): HookRef[] {
  const block = settings?.hooks;
  if (!isObject(block)) return [];
  const refs: HookRef[] = [];
  for (const [event, groups] of Object.entries(block)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (!isObject(group) || !Array.isArray(group.hooks)) continue;
      for (const hook of group.hooks) {
        if (isObject(hook)) refs.push({ event, matcher: matcherOf(group), hook });
      }
    }
  }
  return refs;
}

/** Что запускается; таймаут и прочие поля записи в тождество не входят. */
function keyOf(ref: HookRef): string {
  const { hook } = ref;
  return JSON.stringify([
    ref.event,
    ref.matcher,
    hook.type ?? '',
    hook.command ?? hook.url ?? hook.prompt ?? '',
  ]);
}

/** Подпись для человека: событие и имя скрипта, иначе начало команды. */
function labelOf(ref: HookRef): string {
  const what = String(ref.hook.command ?? ref.hook.url ?? ref.hook.prompt ?? ref.hook.type ?? '');
  const scripts = what.match(/[\w.-]+\.(?:mjs|cjs|js|ts|py|sh|ps1)\b/g);
  const name = scripts ? scripts[scripts.length - 1] : what.trim().slice(0, 60);
  return `${ref.event}: ${name}`;
}

function missingRefs(mainDir: string, copyDir: string): { refs: HookRef[]; copy?: Json } {
  const main = readSettings(join(mainDir, LOCAL_SETTINGS));
  const copy = readSettings(join(copyDir, LOCAL_SETTINGS));
  // Файла копии нет — это дыра `file` (`CRITICAL`), её чинит перенос целиком.
  if (!main || !copy) return { refs: [] };
  const present = new Set(refsOf(copy).map(keyOf));
  const seen = new Set<string>();
  const refs = refsOf(main).filter((ref) => {
    const key = keyOf(ref);
    if (present.has(key) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { refs, copy };
}

/** Хуки оригинала, которых нет в `settings.local.json` копии, — подписями. */
export function missingHookLabels(mainDir: string, copyDir: string): string[] {
  return missingRefs(mainDir, copyDir).refs.map(labelOf);
}

/**
 * Дописать в `settings.local.json` копии недостающие хуки оригинала.
 * Запись ложится в группу с тем же matcher, а нет такой — новой группой.
 * Возвращает, сколько записей добавлено.
 */
export function addMissingHooks(mainDir: string, copyDir: string): number {
  const { refs, copy } = missingRefs(mainDir, copyDir);
  if (!copy || refs.length === 0) return 0;
  const block: Json = isObject(copy.hooks) ? copy.hooks : {};
  for (const ref of refs) {
    const groups = Array.isArray(block[ref.event]) ? (block[ref.event] as unknown[]) : [];
    const target = groups.find(
      (group): group is Json =>
        isObject(group) && Array.isArray(group.hooks) && matcherOf(group) === ref.matcher,
    );
    if (target) (target.hooks as unknown[]).push(ref.hook);
    else groups.push({ ...(ref.matcher ? { matcher: ref.matcher } : {}), hooks: [ref.hook] });
    block[ref.event] = groups;
  }
  writeJsonFile(join(copyDir, LOCAL_SETTINGS), { ...copy, hooks: block });
  return refs.length;
}
