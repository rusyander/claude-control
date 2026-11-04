/**
 * `tests-cli delivery` — проба сдачи копии ДО ответа, тонкий клиент ядра (s10 G16).
 *
 * Проверка сдачи одна — у ядра: шаг публикации судит единицу `judgeUnit`
 * (`apps/core/src/bootstrap/publish-wiring/attempt.ts`: состав финальной проверки, база сервера,
 * merge-tree, требования, покрытие, сита исходящего, тексты коммитов и MR, открытые точки
 * человека), и тот же суд отвечает на `GET /v1/delivery?copy=<папка>`. Здесь только дорога:
 * панель (`/api/core/delivery`, токен панели, как у прочих её ручек) и печать ответа. Своей
 * логики сдачи у панели больше нет — прежняя проверка групп панели в архиве этапа.
 *
 * Коды выхода: 0 — сдавать нечего, 1 — отказ,
 * строки `- <условие>`; 2 — судить нечем (панель или ядро не ответили, копия не единицы ядра).
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Корень рабочего дерева копии: ядро знает копию по нему, а `--project` бывает подпапкой. */
function copyRoot(project) {
  const out = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: project,
    encoding: 'utf8',
  });
  return resolve(out.status === 0 && out.stdout.trim() ? out.stdout.trim() : project);
}

/**
 * GET к API панели: `{ status, body }` или `{ unreachable }`. Токен панели читается и уходит только
 * в заголовок, не печатается.
 */
async function panelGet(repo, path) {
  const brand = await import(
    pathToFileURL(join(repo, 'apps', 'server', 'src', 'lib', 'brand.mjs')).href
  );
  const base = (brand.brandEnv('URL') || 'http://127.0.0.1:5178').replace(/\/+$/, '');
  let token = '';
  try {
    token = readFileSync(brand.panelHomeFile('api-token'), 'utf8').trim();
  } catch {
    // Нет файла — пульт выключен: свой адрес панель пускает без токена.
  }
  try {
    const res = await fetch(`${base}${path}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(120_000),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  } catch (error) {
    return {
      unreachable: `panel unreachable at ${base} (${error?.cause?.code ?? error?.name ?? 'error'})`,
    };
  }
}

/**
 * @param {string} project каталог копии
 * @param {Record<string, unknown>} options разобранные опции `tests-cli`
 * @param {{ repo: string }} env корень репозитория панели
 */
export async function deliveryCheck(project, options, env) {
  const copy = copyRoot(project);
  for (const flag of ['answer', 'mr', 'mr-description']) {
    if (options[flag] !== undefined)
      console.log(
        `--${flag} is not read any more: the core judges the copy itself (commits, MR text, sieves).`,
      );
  }
  const got = await panelGet(env.repo, `/api/core/delivery?copy=${encodeURIComponent(copy)}`);
  if (got.unreachable) {
    console.log(`Delivery not judged: ${got.unreachable}. Start the panel and rerun.`);
    process.exitCode = 2;
    return;
  }
  const body = got.body ?? {};
  if (got.status !== 200 || (body.verdict !== 'ready' && body.verdict !== 'refused')) {
    const code = typeof body.code === 'string' ? body.code : `HTTP ${got.status}`;
    const why =
      typeof body.detail === 'string'
        ? body.detail
        : typeof body.error === 'string'
          ? body.error
          : '';
    console.log(`Delivery not judged (${code})${why ? `: ${why}` : ''}.`);
    process.exitCode = 2;
    return;
  }
  console.log(`Core unit ${body.unitId} of task ${body.taskId} — the publish step's own check:`);
  if (body.verdict === 'ready') {
    console.log('Delivery: nothing left before the answer.');
    return;
  }
  for (const line of body.unmet ?? []) console.log(`- ${line}`);
  console.log(`Next (the core): ${body.next}.`);
  process.exitCode = 1;
}
