/**
 * `tests-cli delivery` — проверка доставки группы у неё в копии, ДО ответа (g3 25.10, N1).
 *
 * Тот же код, что панель зовёт после хода группы: `deliveryFacts` (git, описание MR,
 * сита, блок «Тесты») и `deliveryGapLines` конвейера (пункты владельца, следы звеньев).
 * Раньше группа сверяла сама только блок «Тесты» (`gaps`), а описание MR и ссылки сит
 * узнавала следующим кругом — круг стоил ~427k токенов. Отдельным модулем: раннер
 * `tests-cli.mjs` правят параллельно, и команда не должна делить с ним функции.
 *
 * Чего у копии нет, то приходит аргументами: сданный блок сит — `--answer <файл>`
 * (тот же разбор, что у ответа группы). Описание MR и ветки ревьюера читает панель — ключ
 * форджа только у неё (`GET /api/integrations/forge/mr-review`, F-14 25.10): группа
 * публикует описание один раз и проверяет его, а не пишет файл и затем то же — в фордж.
 * `--mr-description <файл>` — проверить черновик до публикации или без панели.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

/** Модуль сервера по пути от корня репозитория панели. */
async function serverModule(repo, ...path) {
  return await import(pathToFileURL(join(repo, 'apps', 'server', 'src', ...path)).href);
}

const samePath = (path) =>
  resolve(String(path ?? ''))
    .replaceAll('\\', '/')
    .toLowerCase();

/**
 * Состояние панели, где группа с этой копией: тот же поиск, что у `gaps`
 * (каталог настроек CLI, оба имени бренда). Нет — `undefined`.
 */
function findGroup(project, slugs) {
  const want = samePath(project);
  const roots = [process.env.CLAUDE_CONFIG_DIR, join(homedir(), '.claude')].filter(Boolean);
  for (const root of roots)
    for (const name of slugs) {
      let state;
      try {
        state = JSON.parse(readFileSync(join(root, name, 'state.json'), 'utf8'));
      } catch {
        continue;
      }
      for (const record of Object.values(state?.splitPlans ?? {})) {
        const at = (record?.groups ?? []).findIndex(
          (group) => group?.path && samePath(group.path) === want,
        );
        if (at >= 0) return { state, record, group: record.groups[at], at };
      }
    }
  return undefined;
}

/** Текущая ветка копии — для копии, которой нет в состоянии панели. */
function currentBranch(project) {
  const out = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
    cwd: project,
    encoding: 'utf8',
  });
  return out.status === 0 ? out.stdout.trim() : '';
}

/**
 * GET к API панели: `{ status, body }` или `{ unreachable }` — панель не ответила. Токен API
 * панели читается и уходит только в заголовок (как у `tools/mcp/atlassian.mjs`), не печатается.
 */
async function panelGet(repo, path) {
  const brand = await serverModule(repo, 'lib', 'brand.mjs');
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
      signal: AbortSignal.timeout(20_000),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  } catch (error) {
    return {
      unreachable: `panel unreachable at ${base} (${error?.cause?.code ?? error?.name ?? 'error'})`,
    };
  }
}

/** MR через панель: `{ review }` или `{ miss }` — почему не прочитан. */
async function panelReview(repo, url) {
  const got = await panelGet(
    repo,
    `/api/integrations/forge/mr-review?url=${encodeURIComponent(url)}`,
  );
  if (got.unreachable) return { miss: got.unreachable };
  if (got.body?.review) return { review: got.body.review };
  return { miss: typeof got.body?.reason === 'string' ? got.body.reason : `HTTP ${got.status}` };
}

/**
 * Задачи трекера группы — как `deliveryTracker` панели (`runtime.ts`): те же ключи, комментарии
 * читает панель (ключ трекера только у неё). g8 26.10: без них пробел «нет комментария со
 * ссылкой на MR» группа узнавала только следующим кругом. Трекер у панели не подключён —
 * `undefined`, панель тогда задачи не проверяет; задача, которую панель не прочла (или сама
 * панель не ответила), бросает — та же заметка «не прочитаны», что у панели.
 */
async function panelTracker(repo, keys) {
  if (keys.length === 0) return undefined;
  const read = async (key) => {
    const got = await panelGet(
      repo,
      `/api/integrations/jira/issue/${encodeURIComponent(key)}/comments`,
    );
    if (Array.isArray(got.body?.comments)) return got.body.comments;
    if (got.body?.reason === 'not-connected') return null;
    throw new Error(got.unreachable ?? got.body?.reason ?? `HTTP ${got.status}`);
  };
  // Подключён ли трекер, решает первый ответ; его же и отдаём проверке.
  const first = await read(keys[0]).then(
    (comments) => ({ comments }),
    (error) => ({ error }),
  );
  if (first.comments === null) return undefined;
  return {
    keys,
    comments: async (key) => {
      if (key === keys[0]) {
        if (first.error) throw first.error;
        return first.comments;
      }
      const comments = await read(key);
      if (comments === null) throw new Error('not-connected');
      return comments;
    },
  };
}

function readArgFile(project, file, what) {
  try {
    return readFileSync(resolve(project, file), 'utf8');
  } catch (error) {
    throw new Error(`${what} не прочитан (${file}): ${error.message}`, { cause: error });
  }
}

/**
 * Строки сит из файла `--answer`: блок ```agentdeck:sieves``` в ответе или файл, который
 * весь — тело блока (`{"sieves":[…]}`). g8 26.10 (F8): голый JSON давал «сито не сдано»
 * по всем пяти строкам, и группа потратила круг, оборачивая тот же файл в блок.
 *
 * @param {{ scanSieveBlocks: (text: string) => { rows: unknown[] } }} contracts
 * @param {string} text
 */
function sieveRowsOf(contracts, text) {
  const rows = contracts.scanSieveBlocks(text).rows;
  const bare = text.trim();
  if (rows.length > 0 || !bare.startsWith('{')) return rows;
  return contracts.scanSieveBlocks(`\`\`\`agentdeck:sieves\n${bare}\n\`\`\``).rows;
}

/**
 * @param {string} project каталог копии группы
 * @param {Record<string, unknown>} options разобранные опции `tests-cli`
 * @param {{ repo: string, cli: string, slugs: readonly string[] }} env корень панели,
 *   команда самого `tests-cli` (её называют строки пробелов) и имена каталога бренда
 */
export async function deliveryCheck(project, options, env) {
  const contracts = await import(
    pathToFileURL(join(env.repo, 'packages', 'contracts', 'src', 'sieves.ts')).href
  );
  const { deliveryFacts, liveMrLine } = await serverModule(
    env.repo,
    'domains',
    'chat',
    'delivery-check',
    'delivery-check.ts',
  );
  const conveyor = await serverModule(
    env.repo,
    'domains',
    'chat',
    'split-conveyor',
    'split-conveyor.ts',
  );
  const { getWorktreeMirror } = await serverModule(
    env.repo,
    'lib',
    'app-store',
    'worktree-mirror.ts',
  );
  const { localizeText, matchText } = await serverModule(
    env.repo,
    'lib',
    'server-texts',
    'server-texts.ts',
  );

  const found = findGroup(project, env.slugs);
  const answerText =
    typeof options.answer === 'string' ? readArgFile(project, options.answer, 'Ответ') : undefined;
  const answer =
    answerText !== undefined
      ? contracts.stampSieveRows(sieveRowsOf(contracts, answerText), new Date().toISOString())
      : [];
  const link = found?.group.chatId ? found.state.chatLinks?.[found.group.chatId] : undefined;
  // Строки сит — как их сложит конвейер после хода: запись группы, звенья цепочки,
  // затем этот ответ (`onChainEnded`).
  const sieveRows = contracts.mergeSieveRows(
    contracts.mergeSieveRows(found?.group.sieveRows, link?.sieveRows ?? []),
    answer,
  );
  const group = found
    ? { ...found.group, sieveRows, stageTrace: structuredClone(found.group.stageTrace) }
    : { path: project, branch: currentBranch(project), sieveRows };
  // Вердикт ревью — так же, как сита: каким его запишет конвейер после хода (`traceStage`
  // с числом замечаний блока ```agentdeck:review``` ответа, chain-outcome). Сверка брала
  // только записанный след, и на этапе ревью «вердикта нет» было не снять: группа #5
  // (25.10) четыре вызова искала в коде панели, чем, и приклеенный к --answer вердикт
  // строку не убрал.
  const { scanReviewBlocks } = await import(
    pathToFileURL(join(env.repo, 'packages', 'contracts', 'src', 'model-cascade.ts')).href
  );
  const findings =
    found && link?.stage === 'review' && answerText !== undefined
      ? scanReviewBlocks(answerText).findings
      : undefined;
  if (findings) conveyor.traceStage(group, link, new Date(), findings.length);
  const description =
    typeof options['mr-description'] === 'string'
      ? readArgFile(project, options['mr-description'], 'Описание MR')
      : undefined;
  // Звено до доставки (панель ставит процессу звена `AGENTDECK_GROUP_DELIVER_AHEAD=1`, как
  // для `gate-at-end`): пуш и MR — работа звена доставки, в ревью их не снять (g5 25.10).
  const deliverAhead = process.env.AGENTDECK_GROUP_DELIVER_AHEAD === '1';
  // До звена доставки задачи трекера проверка не смотрит (как у панели) — и не спрашивает.
  const { groupPointTexts, groupTaskKeys } = await serverModule(
    env.repo,
    'domains',
    'chat',
    'split-tasks',
    'split-tasks.ts',
  );
  const tracker =
    found && !deliverAhead
      ? await panelTracker(env.repo, groupTaskKeys(found.record, found.group))
      : undefined;
  // Без файла — живое MR через панель; `live` — что вышло (нет чтения — нет и поля).
  let live;
  const verdict = await deliveryFacts(
    group,
    typeof options.mr === 'string' ? options.mr : group.mr,
    found ? conveyor.claimedBranches(found.record, found.at) : [],
    {
      ...(found
        ? { mirror: getWorktreeMirror(found.state, conveyor.copyRootOf(found.record)) }
        : {}),
      review:
        description !== undefined
          ? async () => ({ state: 'open', threads: [], description })
          : async (url) => {
              live = await panelReview(env.repo, url);
              return live.review;
            },
      testsCommand: `${env.cli} run --project .`,
      ...(tracker ? { tracker } : {}),
      // Тексты пунктов следа задач — как у панели (`runtime.ts` `deliveryTaskTexts`).
      ...(found ? { taskTexts: groupPointTexts(found.record, found.group) } : {}),
      ...(deliverAhead ? { deliverAhead: true } : {}),
    },
  );
  if (deliverAhead) {
    console.log(
      'The delivery stage is still ahead: push and MR are its work and are not checked here.',
    );
  }
  const missing = found
    ? conveyor.deliveryGapLines(verdict, group, found.record)
    : [...verdict.missing];
  const left = [...conveyor.deliveryModelLines(missing)];
  // Без --answer строки сит и пунктов судятся по сданному в прошлом раунде (F5, аудит g0
  // 27.10: семь жалоб на старые строки, 4,5k знаков) — сказать это до них.
  const rowGap = (line) =>
    /^(sieve-gap-|delivery-gap-(task|owner)-)/.test(matchText(line)?.messageCode ?? '');
  if (answerText === undefined && sieveRows.length > 0 && missing.some(rowGap)) {
    console.log(
      'No --answer: the sieve and task rows below are the ones reported in an earlier round — ' +
        "pass --answer <file> with this round's ```agentdeck:sieves``` block to check the rows " +
        'you are about to report.',
    );
  }
  const lastStage = group.stageTrace?.at(-1);
  if (lastStage?.stage === 'review' && lastStage.findings === undefined) {
    left.push(
      '- the reviewer verdict is read from the final answer of the review stage: end it with an ' +
        '```agentdeck:review``` block {"findings":[…]} ([] = approved); pass that answer as ' +
        '--answer to check it now',
    );
  }
  // Черновик описания сверяется и с живым MR (g9 26.10, F9): снимки, вписанные прямо в
  // фордж, файл не знал, и перезапись из него убирала их из MR. Панель не прочла MR —
  // сравнивать не с чем, строки нет (файл и нужен для проверки без панели).
  const mrUrl = verdict.mr ?? (typeof options.mr === 'string' ? options.mr : group.mr);
  if (description !== undefined && mrUrl) {
    const published = (await panelReview(env.repo, mrUrl)).review?.description;
    const { droppedImageLinks } = await serverModule(
      env.repo,
      'domains',
      'project-git',
      'delivery-facts',
      'delivery-facts.ts',
    );
    const dropped = typeof published === 'string' ? droppedImageLinks(published, description) : [];
    if (dropped.length > 0) {
      left.push(
        `- the description file ${options['mr-description']} drops ${dropped.length} image ` +
          `link(s) the live MR ${mrUrl} shows: ${dropped.join(', ')} — copy them into the file ` +
          'before publishing it, or the rewrite removes them from the MR',
      );
    }
  }
  if (verdict.mr && description === undefined && !live?.review) {
    const ids = [...new Set([...contracts.liveNaIds(sieveRows), ...(verdict.noted ?? [])])];
    left.push(
      `- the MR description of ${verdict.mr} was not checked (the panel did not read the MR: ` +
        `${live?.miss ?? 'not asked'}): post it to the MR once and rerun this command, or pass ` +
        '--mr-description <file>' +
        (ids.length > 0 ? ` — it must name each of: ${ids.join(', ')}` : ''),
    );
  }
  if (!found) {
    console.log(
      'This copy is not a panel group (state.json has no group with this path): sieve rows ' +
        'come only from --answer; owner items and stage traces are not checked.',
    );
  }
  for (const line of left) console.log(line);
  // Заметки, что живое описание MR уже называет, — счётом, не текстом (F4, g1 26.10).
  const namedNotes = verdict.notesNamed ?? [];
  for (const line of verdict.notes ?? []) {
    if (namedNotes.includes(line)) continue;
    console.log(`note (name it in the MR description): ${localizeText(line, 'en')}`);
  }
  if (namedNotes.length > 0) {
    console.log(
      `${namedNotes.length} note(s) already named in the live MR description — keep them there.`,
    );
  }
  if (verdict.mr && live?.review) {
    // Что панель увидела — цитируемой строкой (F6, g1 26.10): перечитывать MR незачем.
    console.log(liveMrLine(verdict.mr, live.review, verdict.noted ?? []));
  } else if (verdict.mr) {
    console.log(
      'Reviewer threads are checked by the panel only (it holds the forge token): answer every ' +
        'open thread of the MR yourself.',
    );
  }
  if (left.length > 0) process.exitCode = 1;
  else console.log('Delivery: nothing left before the answer.');
}
