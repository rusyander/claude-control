/**
 * Набор панели (В2) — от HTTP до процесса прогона, на одноразовом стенде.
 *
 * Юнит-тесты `domains/kit` проверяют сервис и сборку по отдельности; здесь
 * весь путь человека: маршруты `/api/kit` настоящей панели меняют режим,
 * копию «моё», выключенный хук и выбор в конфликте — и следующее сообщение
 * чата уходит в процесс с флагом плагина, чей каталог на диске собран ровно
 * так, как сказано на странице. Подменён только `claude`: фальшивый CLI на PATH
 * стенда записывает свои argv и переменную варианта правил и отвечает строкой
 * `result`. Сеть, токены и настоящий `~/.claude` не трогаются.
 *
 * Свидетели: argv процесса (что панель запустила), файлы собранного каталога
 * (что CLI прочитал бы) и вывод хука `session-rules.mjs` ИЗ собранного каталога
 * (что модель получила бы контекстом).
 *
 * Запуск: node tools/qa/check-kit.mjs   (стенд не нужен, CLI не нужен)
 */
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { runOnStand, wait } from './throwaway-stand.mjs';

const RULE = 'rules/standard.md';
const SKILL = 'skills/read-before-edit/SKILL.md';
const GUARD = 'hooks/guard-destructive.mjs';
const MARK = 'KIT-QA-MINE-RULE-MARKER';
const DUMP = 'kit-dump.jsonl';

/** Фальшивый `claude`: argv и вариант правил — строкой в файл рабочей папки, затем init и result. */
const FAKE_CLAUDE = String.raw`
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
const argv = process.argv.slice(2);
if (argv[0] === '--version' || argv[0] === '-v') {
  process.stdout.write('2.1.0 (Claude Code)\n');
  process.exit(0);
}
appendFileSync(
  join(process.cwd(), '${DUMP}'),
  JSON.stringify({ argv, variant: process.env.AGENTDECK_KIT_VARIANT ?? null }) + '\n',
);
const id = 'kit-qa-' + process.pid;
process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: id, model: 'stub', tools: [] }) + '\n');
process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', session_id: id, total_cost_usd: 0, duration_ms: 1, result: 'ок' }) + '\n');
process.exit(0);
`;

/** Отпечаток настоящего каталога набора человека: прогон обязан его не тронуть. */
function realKitStamp() {
  const path = join(
    process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'),
    'agentdeck',
    'kit',
  );
  if (!existsSync(path)) return 'absent';
  return readdirSync(path)
    .map((name) => `${name}:${statSync(join(path, name)).mtimeMs}`)
    .join('|');
}
const realBefore = realKitStamp();

await runOnStand(
  {
    label: 'kit',
    web: false,
    fakeCli: { claude: FAKE_CLAUDE },
    seed: ({ cfg }) => {
      // Одноимённый навык человека — конфликт имён гибрида.
      mkdirSync(join(cfg, 'skills', 'read-before-edit'), { recursive: true });
      writeFileSync(
        join(cfg, 'skills', 'read-before-edit', 'SKILL.md'),
        '---\nname: read-before-edit\ndescription: навык человека\n---\nМОЙ\n',
        'utf8',
      );
    },
  },
  async (stand, check) => {
    const project = join(stand.root, 'project');
    mkdirSync(project, { recursive: true });

    /** Одно сообщение чата; ответ — argv фальшивого CLI этого прогона. */
    const send = async (label) => {
      const before = existsSync(join(project, DUMP))
        ? readFileSync(join(project, DUMP), 'utf8').split('\n').filter(Boolean).length
        : 0;
      const sending = stand.api('/chat/send', {
        method: 'POST',
        body: { chatId: randomUUID(), prompt: `проверка набора: ${label}`, projectPath: project },
      });
      sending.catch(() => undefined);
      for (let i = 0; i < 120; i += 1) {
        const lines = existsSync(join(project, DUMP))
          ? readFileSync(join(project, DUMP), 'utf8').split('\n').filter(Boolean)
          : [];
        if (lines.length > before) {
          await Promise.race([sending, wait(10_000)]);
          return JSON.parse(lines.at(-1));
        }
        await wait(250);
      }
      throw new Error(`${label}: фальшивый CLI не запущен за 30 с\n${stand.log().slice(-1500)}`);
    };
    const pluginDir = (run) => {
      const at = run.argv.indexOf('--plugin-dir');
      return at >= 0 ? run.argv[at + 1] : undefined;
    };
    const sources = (run) => {
      const at = run.argv.indexOf('--setting-sources');
      return at >= 0 ? run.argv[at + 1] : undefined;
    };
    const hooksOf = (dir) =>
      JSON.parse(readFileSync(join(dir, 'hooks', 'hooks.json'), 'utf8')).hooks;
    /** Что хук SessionStart СОБРАННОГО набора отдал бы модели. */
    const sessionRules = (dir, variant) => {
      const out = spawnSync(process.execPath, [join(dir, 'hooks', 'session-rules.mjs')], {
        input: '{}',
        encoding: 'utf8',
        env: { ...process.env, AGENTDECK_KIT_VARIANT: variant },
      });
      return JSON.parse(out.stdout).hookSpecificOutput.additionalContext;
    };

    // ── 1. Снимок страницы ───────────────────────────────────────────────────
    const first = await stand.api('/kit');
    check('GET /api/kit — 200', first.status === 200, first.text.slice(0, 300));
    const view = first.body;
    const ids = (view.items ?? []).map((item) => item.id);
    check(
      'в наборе навыки, команды, правила и хуки приложения',
      [RULE, SKILL, GUARD, 'hooks/hooks.json', 'commands/review.md'].every((id) =>
        ids.includes(id),
      ),
      ids.join(', '),
    );
    const claude = view.providers?.find((p) => p.id === 'claude');
    check('Claude по умолчанию — «глобальные»', claude?.mode === 'global', JSON.stringify(claude));
    check(
      'конфликт с навыком человека виден, по умолчанию побеждает человек',
      view.items?.find((item) => item.id === SKILL)?.conflict?.winner === 'user',
    );
    const kitRoot = dirname(view.mineDir ?? '');
    check(
      'данные набора — в каталоге стенда, не в настоящем профиле',
      resolve(kitRoot).startsWith(resolve(stand.root)),
      kitRoot,
    );
    const effective = (mode) => join(kitRoot, 'effective', mode, 'agentdeck-kit');

    // ── 2. «Глобальные»: набор к прогону не едет ───────────────────────────
    const g = await send('global');
    check('«глобальные»: без --plugin-dir', pluginDir(g) === undefined, g.argv.join(' '));
    check('«глобальные»: без варианта правил', g.variant === null, String(g.variant));

    // ── 3. «Оба»: плагин, навык набора уступает навыку человека ─────────────
    const toHybrid = await stand.api('/kit/mode', {
      method: 'PUT',
      body: { provider: 'claude', mode: 'hybrid' },
    });
    check('PUT /api/kit/mode hybrid — 200', toHybrid.status === 200, toHybrid.text.slice(0, 200));
    const h = await send('hybrid');
    check(
      '«оба»: --plugin-dir — собранный каталог режима',
      pluginDir(h) && resolve(pluginDir(h)) === resolve(effective('hybrid')),
      `${pluginDir(h)} ≠ ${effective('hybrid')}`,
    );
    check('«оба»: без снятия источника user', sources(h) === undefined, h.argv.join(' '));
    check('«оба»: вариант правил standard', h.variant === 'standard', String(h.variant));
    check(
      '«оба»: одноимённый навык набора уступил человеку',
      !existsSync(join(effective('hybrid'), 'skills', 'read-before-edit')),
    );
    check(
      '«оба»: остальные навыки набора на месте',
      existsSync(join(effective('hybrid'), 'skills', 'verify-by-running', 'SKILL.md')),
    );

    // ── 4. Конфликт: побеждает набор ────────────────────────────────────────
    const win = await stand.api('/kit/conflict', {
      method: 'PUT',
      body: { id: SKILL, winner: 'kit' },
    });
    check('PUT /api/kit/conflict — 200', win.status === 200, win.text.slice(0, 200));
    await send('hybrid-kit-wins');
    check(
      'выбор «набор»: навык набора вернулся в сборку',
      existsSync(join(effective('hybrid'), SKILL)),
    );

    // ── 5. Правка «моё» доезжает до правил сессии ───────────────────────────
    const edit = await stand.api('/kit/item', {
      method: 'PUT',
      body: { id: RULE, content: `# Мои правила\n\n- ${MARK}\n` },
    });
    check('PUT /api/kit/item — 200', edit.status === 200, edit.text.slice(0, 200));
    check(
      'копия «моё» лежит в данных набора',
      readFileSync(join(view.mineDir, RULE), 'utf8').includes(MARK),
    );
    await send('mine');
    check(
      'собранные правила — копия «моё»',
      readFileSync(join(effective('hybrid'), RULE), 'utf8').includes(MARK),
    );
    check(
      'хук SessionStart собранного набора отдаёт модели правку «моё»',
      sessionRules(effective('hybrid'), 'standard').includes(MARK),
    );

    // ── 6. Выключенный хук: скрипта нет, hooks.json его не зовёт ────────────
    const off = await stand.api('/kit/item/enabled', {
      method: 'PUT',
      body: { id: GUARD, enabled: false },
    });
    check('PUT /api/kit/item/enabled false — 200', off.status === 200, off.text.slice(0, 200));
    await send('guard-off');
    check('выключенный хук: скрипта в сборке нет', !existsSync(join(effective('hybrid'), GUARD)));
    check(
      'выключенный хук: hooks.json его не зовёт, соседние события на месте',
      !JSON.stringify(hooksOf(effective('hybrid'))).includes('guard-destructive.mjs') &&
        'SessionStart' in hooksOf(effective('hybrid')) &&
        'PreToolUse' in hooksOf(effective('hybrid')),
      JSON.stringify(Object.keys(hooksOf(effective('hybrid')))),
    );

    // ── 7. «Вернуть встроенный»: копия в архиве, сборка — встроенный текст ──
    const reset = await stand.api(`/kit/item?id=${encodeURIComponent(RULE)}`, { method: 'DELETE' });
    check('DELETE /api/kit/item — 200', reset.status === 200, reset.text.slice(0, 200));
    const archive = join(kitRoot, 'archive');
    const archived = existsSync(archive)
      ? readdirSync(archive).some((stamp) => {
          const path = join(archive, stamp, RULE);
          return existsSync(path) && readFileSync(path, 'utf8').includes(MARK);
        })
      : false;
    check('копия «моё» ушла в архив набора, а не удалена', archived);
    await send('reset');
    check(
      'после возврата сборка несёт встроенные правила',
      !readFileSync(join(effective('hybrid'), RULE), 'utf8').includes(MARK) &&
        sessionRules(effective('hybrid'), 'standard').includes('agentdeck kit rules'),
    );

    // ── 8. Включение хука возвращает его ────────────────────────────────────
    await stand.api('/kit/item/enabled', { method: 'PUT', body: { id: GUARD, enabled: true } });
    await send('guard-on');
    check(
      'включённый хук вернулся: скрипт и его строка в hooks.json',
      existsSync(join(effective('hybrid'), GUARD)) &&
        JSON.stringify(hooksOf(effective('hybrid'))).includes('guard-destructive.mjs'),
    );

    // ── 9. «Только наш»: плагин и снятый источник user ──────────────────────
    const toOurs = await stand.api('/kit/mode', {
      method: 'PUT',
      body: { provider: 'claude', mode: 'ours' },
    });
    check('PUT /api/kit/mode ours — 200', toOurs.status === 200, toOurs.text.slice(0, 200));
    const o = await send('ours');
    check(
      '«только наш»: --plugin-dir — сборка режима ours',
      pluginDir(o) && resolve(pluginDir(o)) === resolve(effective('ours')),
      o.argv.join(' '),
    );
    check(
      '«только наш»: --setting-sources project,local',
      sources(o) === 'project,local',
      o.argv.join(' '),
    );
    check(
      '«только наш»: навык набора не уступает (личные навыки сняты флагом)',
      existsSync(join(effective('ours'), SKILL)),
    );

    // ── 10. Отказы ──────────────────────────────────────────────────────────
    const unknown = await stand.api(`/kit/item?id=${encodeURIComponent('../x')}`);
    check(
      'неизвестный id — 404 kit-item-unknown',
      unknown.status === 404 && unknown.body?.messageCode === 'kit-item-unknown',
      `${unknown.status} ${unknown.text.slice(0, 200)}`,
    );
    const codex = await stand.api('/kit/mode', {
      method: 'PUT',
      body: { provider: 'codex', mode: 'ours' },
    });
    check(
      'режим, которого CLI не умеет, — 400 kit-mode-unsupported',
      codex.status === 400 && codex.body?.messageCode === 'kit-mode-unsupported',
      `${codex.status} ${codex.text.slice(0, 200)}`,
    );
    const bad = await stand.api('/kit/mode', {
      method: 'PUT',
      body: { provider: 'claude', mode: 'all' },
    });
    check('неверное тело — 400', bad.status === 400, `${bad.status}`);

    // ── 11. «Глобальные» снова — и следа нет ────────────────────────────────
    await stand.api('/kit/mode', { method: 'PUT', body: { provider: 'claude', mode: 'global' } });
    const back = await send('global-again');
    check(
      'снова «глобальные»: без --plugin-dir со следующего сообщения',
      pluginDir(back) === undefined,
    );

    check('настоящий каталог набора человека не тронут', realKitStamp() === realBefore);
  },
);
