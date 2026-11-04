/**
 * Чистые модули телефона (`apps/mobile/src/**`) в проверке на Node — тем же кодом, что в
 * приложении, без копии. Приложение собирает Metro: относительные импорты без расширения и
 * `@agentdeck/contracts/<модуль>` прямо в исходник (`apps/mobile/metro.config.js`). Здесь то же
 * разрешение — хуком загрузчика Node, только для импортов из `apps/mobile/src`.
 *
 * Годится только модулям без React Native (подпись, разбор): сеть, SecureStore и экран — нет.
 */
import { register } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MOBILE_SRC = pathToFileURL(join(ROOT, 'apps/mobile/src')).href;
const CONTRACTS = pathToFileURL(join(ROOT, 'packages/contracts/src')).href;

const HOOK = `
const MOBILE_SRC = ${JSON.stringify(MOBILE_SRC)};
const CONTRACTS = ${JSON.stringify(CONTRACTS)};
export async function resolve(specifier, context, next) {
  const fromMobile = context.parentURL?.startsWith(MOBILE_SRC);
  if (fromMobile && specifier.startsWith('@agentdeck/contracts/')) {
    return next(CONTRACTS + '/' + specifier.slice('@agentdeck/contracts/'.length) + '.ts', context);
  }
  const out = fromMobile && specifier.startsWith('.') && !/\\.[cm]?[jt]sx?$/.test(specifier)
    ? await next(specifier + '.ts', context)
    : await next(specifier, context);
  // package.json приложения без "type": исходник телефона — ESM на TypeScript, как у Metro.
  return out.url.startsWith(MOBILE_SRC) && out.url.endsWith('.ts')
    ? { ...out, format: 'module-typescript' }
    : out;
}
`;

register(`data:text/javascript,${encodeURIComponent(HOOK)}`, import.meta.url);

/** Модуль телефона по пути от `apps/mobile/src` (`shared/api/signing/signing.ts`). */
export function mobileModule(rel) {
  return import(`${MOBILE_SRC}/${rel}`);
}
