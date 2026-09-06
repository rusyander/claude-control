/**
 * Проверка ссылок в Markdown-документации: относительные пути и якоря.
 *
 * Обходит все `.md` репозитория (кроме зависимостей и локального слоя агента),
 * для каждой ссылки вида `[текст](путь#якорь)` проверяет, что файл существует,
 * а якорь совпадает с каким-нибудь заголовком целевого файла — по тем же
 * правилам, по которым GitHub строит id заголовков (строчные буквы, пунктуация
 * долой, пробелы → дефис, повтор → `-1`, `-2`). Внешние адреса не трогает:
 * сеть — не предмет проверки, а вот битая внутренняя ссылка ломает навигацию
 * по документации молча.
 *
 * Запуск: node tools/check-doc-links.mjs   (ненулевой код — есть битые ссылки)
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, dirname, resolve, relative, sep } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const SKIP_DIRS = new Set(['node_modules', '.git', '.agent', 'android', 'dist', 'coverage']);

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const path = join(dir, name);
    const stats = statSync(path);
    if (stats.isDirectory()) yield* walk(path);
    else if (name.endsWith('.md')) yield path;
  }
}

/** Идентификатор заголовка по правилам GitHub. */
function slugify(heading) {
  return (
    heading
      .toLowerCase()
      .replace(/[`*_~]/g, '')
      .replace(/[^\p{L}\p{N}\s_-]/gu, '')
      .trim()
      // GitHub меняет КАЖДЫЙ пробел на дефис и не схлопывает их: «раздел → провайдер»
      // после удаления стрелки даёт `раздел--провайдер`, с двумя дефисами.
      .replace(/ /g, '-')
  );
}

/** Все якоря файла: заголовки с учётом повторов + явные `<a id="…">`/`name="…"`. */
function anchorsOf(text) {
  const anchors = new Set();
  const seen = new Map();
  let inFence = false;
  for (const line of text.split('\n')) {
    if (/^\s*```/.test(line)) inFence = !inFence;
    if (inFence) continue;
    const match = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (!match) continue;
    // Ссылки в заголовке дают якорь по тексту, не по адресу.
    const plain = match[1].replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
    const base = slugify(plain);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    anchors.add(count === 0 ? base : `${base}-${count}`);
  }
  for (const match of text.matchAll(/<a\s+(?:id|name)="([^"]+)"/g)) anchors.add(match[1]);
  return anchors;
}

const anchorCache = new Map();
const anchorsOfFile = (path) => {
  if (!anchorCache.has(path)) anchorCache.set(path, anchorsOf(readFileSync(path, 'utf8')));
  return anchorCache.get(path);
};

const broken = [];
let checked = 0;

for (const file of walk(ROOT)) {
  const text = readFileSync(file, 'utf8');
  let inFence = false;
  const lines = text.split('\n');
  lines.forEach((line, index) => {
    if (/^\s*```/.test(line)) inFence = !inFence;
    if (inFence) return;
    for (const match of line.matchAll(/\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      const target = match[1];
      if (/^(https?:|mailto:|tel:|data:)/i.test(target)) continue;
      if (target.startsWith('<')) continue;
      checked += 1;
      const [pathPart, anchor] = target.split('#');
      const targetFile = pathPart ? resolve(dirname(file), decodeURIComponent(pathPart)) : file;
      const where = `${relative(ROOT, file).split(sep).join('/')}:${index + 1}`;
      if (!existsSync(targetFile)) {
        broken.push(`${where}  нет файла: ${target}`);
        continue;
      }
      if (anchor === undefined || anchor === '') continue;
      if (!targetFile.endsWith('.md')) continue;
      const anchors = anchorsOfFile(targetFile);
      if (!anchors.has(decodeURIComponent(anchor).toLowerCase())) {
        broken.push(`${where}  нет якоря: ${target}`);
      }
    }
  });
}

if (broken.length > 0) {
  console.log(`Битых ссылок: ${broken.length} из ${checked}\n  ${broken.join('\n  ')}`);
  process.exit(1);
}
console.log(`Все внутренние ссылки целы (${checked} проверено).`);
