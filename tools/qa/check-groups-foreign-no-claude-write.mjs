/**
 * Группы панели при чужом активном CLI не пишут в `~/.claude` (cli-pass X2,
 * F2 владельца 06.10).
 *
 * Раньше каждый запуск, который панель заводит сама под чужим CLI, включал
 * группы, привязанные к проекту, тумблером каталогов Claude: дети разделения,
 * продолжение в чистой сессии, перенос разговора, а отправка в чат — ещё и
 * выбранную группу. CLI файлов Claude не читает, так что группа ему ничего не
 * давала, а настройки человека менялись молча.
 *
 * Здесь не подменяется ничего, кроме самого CLI: одноразовая панель со своим
 * каталогом Claude (`CLAUDE_CONFIG_DIR` во временном доме), активный goose —
 * фальшивый на PATH (у goose слоя группы нет, ровно случай «не действует»).
 * В каталоге Claude — группа, привязанная к проекту, выключенная (её скилл
 * лежит в `skills-disabled`), и общая группа, выбранная в чате. Ход за ходом:
 * чат с выбранной группой, разделение, продолжение в чистой сессии, перенос
 * разговора Claude → goose. После КАЖДОГО — отпечаток всего каталога Claude
 * (кроме хранилища панели) равен снятому до первого хода, и в ленте чужих
 * разговоров стоит заметка «группа не действует».
 *
 * Обязан краснеть: та же проверка над копией сервера, где у детей разделения
 * снова зовётся тумблер (`--server-dir <копия apps/server>`), видит другой
 * отпечаток после хода «разделение».
 *
 * Запуск: `node tools/qa/check-groups-foreign-no-claude-write.mjs [--server-dir <копия>]`
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { runOnStand, wait } from './throwaway-stand.mjs';

const serverAt = process.argv.indexOf('--server-dir');
const SERVER_DIR = serverAt > 0 ? process.argv[serverAt + 1] : undefined;

// Фальшивый goose: версия на `--version`, на остальное — короткий ответ и выход.
// Прогон чата при этом может упасть (живого `goose acp` нет) — проверке важно
// не что ответил CLI, а что панель сделала с каталогом Claude до запуска.
const FAKE_GOOSE = `
const argv = process.argv.slice(2);
if (argv.includes('--version') || argv[0] === '-V') console.log('1.9.0');
else console.log('ok');
`;

/** Отпечаток каталога Claude: пути и байты всего, кроме хранилища панели. */
function treeHash(cfg) {
  const hash = createHash('sha256');
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : 1,
    )) {
      const full = join(dir, entry.name);
      if (dir === cfg && entry.name === 'agentdeck') continue;
      const rel = relative(cfg, full).replaceAll('\\', '/');
      hash.update(`${rel}\n`);
      if (entry.isDirectory()) walk(full);
      else {
        files.push(rel);
        hash.update(readFileSync(full));
      }
    }
  };
  walk(cfg);
  return { hash: hash.digest('hex').slice(0, 16), files };
}

await runOnStand(
  {
    label: 'groups-foreign-x2',
    web: false,
    fakeCli: { goose: FAKE_GOOSE },
    settings: { provider: 'goose' },
    ...(SERVER_DIR ? { serverDir: SERVER_DIR } : {}),
    seed: ({ root, cfg }) => {
      const project = join(root, 'project');
      mkdirSync(project, { recursive: true });
      writeFileSync(join(project, 'README.md'), '# Shop\n', 'utf8');
      // Опора продолжения: перенос без неё отказывает (`checkpoint_missing`).
      mkdirSync(join(project, '.agent'), { recursive: true });
      writeFileSync(join(project, '.agent', 'PROGRESS.md'), '# Ход\n\nПодписи готовы.\n', 'utf8');
      // Настоящий репозиторий: разделение заводит детей в копиях (`git worktree`).
      const git = (...args) => execFileSync('git', args, { cwd: project, stdio: 'ignore' });
      git('init', '-q', '-b', 'main');
      git('-c', 'user.email=qa@example.com', '-c', 'user.name=qa', 'add', '.');
      git('-c', 'user.email=qa@example.com', '-c', 'user.name=qa', 'commit', '-q', '-m', 'init');
      for (const id of ['bound-skill', 'chosen-skill']) {
        mkdirSync(join(cfg, 'skills', id), { recursive: true });
        writeFileSync(
          join(cfg, 'skills', id, 'SKILL.md'),
          `---\nname: ${id}\ndescription: ${id} marker\n---\n\nMarker ${id}.\n`,
          'utf8',
        );
      }
      writeFileSync(join(cfg, 'CLAUDE.md'), '# Правила человека\n', 'utf8');
      // Разговор Claude в этом проекте — источник переноса на goose.
      const sid = '11111111-2222-4333-8444-555555555555';
      const dir = join(cfg, 'projects', project.replace(/[^A-Za-z0-9]/g, '-'));
      mkdirSync(dir, { recursive: true });
      const at = new Date().toISOString();
      const line = (type, message, n) =>
        JSON.stringify({
          type,
          sessionId: sid,
          cwd: project,
          timestamp: at,
          uuid: `${sid}-${n}`,
          message,
        });
      writeFileSync(
        join(dir, `${sid}.jsonl`),
        [
          line('user', { role: 'user', content: 'Посчитать скидку по купону в корзине' }, 1),
          line(
            'assistant',
            {
              id: 'm1',
              role: 'assistant',
              model: 'x',
              content: [{ type: 'text', text: 'Начал.' }],
            },
            2,
          ),
        ].join('\n') + '\n',
        'utf8',
      );
      return { project, sid };
    },
  },
  async (stand, check) => {
    const project = join(stand.root, 'project');
    const sid = '11111111-2222-4333-8444-555555555555';
    const added = await stand.api('/projects', {
      method: 'POST',
      body: { name: 'Shop', path: project },
    });
    check('проект заведён', added.status < 300, `${added.status} ${added.text.slice(0, 200)}`);

    const draft = (name, members, projectPaths) => ({
      name,
      description: '',
      color: 'accent',
      icon: 'folder',
      members,
      env: {},
      projectPaths,
    });
    const bound = await stand.api('/groups', {
      method: 'POST',
      body: draft('Привязанная', [{ kind: 'skill', id: 'bound-skill' }], [project]),
    });
    const chosen = await stand.api('/groups', {
      method: 'POST',
      body: draft('Выбранная', [{ kind: 'skill', id: 'chosen-skill' }], []),
    });
    check(
      'группы заведены',
      bound.status < 300 && chosen.status < 300,
      `${bound.text} ${chosen.text}`,
    );
    // Обе выключены: их скиллы лежат в skills-disabled, тумблер вернул бы их назад.
    for (const id of [bound.body?.id, chosen.body?.id]) {
      await stand.api(`/groups/${id}/enabled`, {
        method: 'POST',
        body: { isEnabled: false, provider: 'claude' },
      });
    }
    const groups = (await stand.api('/groups')).body ?? [];
    check(
      'обе группы выключены в Claude до первого хода',
      groups.length === 2 && groups.every((group) => group.isEnabled === false),
      JSON.stringify(groups.map((group) => [group.name, group.isEnabled])),
    );

    const base = treeHash(stand.cfg);
    console.log(
      `  · отпечаток каталога Claude до ходов: ${base.hash} (${base.files.length} файлов)`,
    );
    // Сравнение — с отпечатком ПЕРЕД этим ходом: краснеет ровно тот ход, что
    // записал в Claude (у мутанта следующие ходы видели бы уже включённую группу).
    let last = base;
    const same = async (step) => {
      await wait(1500);
      const now = treeHash(stand.cfg);
      const extra = now.files.filter((file) => !last.files.includes(file));
      const gone = last.files.filter((file) => !now.files.includes(file));
      check(
        `${step}: каталог Claude не тронут`,
        now.hash === last.hash,
        `${last.hash} → ${now.hash}; появились: ${extra.join(', ') || '—'}; пропали: ${gone.join(', ') || '—'}`,
      );
      last = now;
    };
    const noneText = 'группа на этот прогон не действует';
    const chatsIn = async () =>
      (
        (await stand.api('/provider-chat/chats')).body?.chats ??
        (await stand.api('/provider-chat/chats')).body ??
        []
      ).filter((chat) => chat.workdir);
    const noticeOf = async (id) => {
      const chat = (await stand.api(`/provider-chat/chats/${id}`)).body;
      const messages = chat?.messages ?? chat?.chat?.messages ?? [];
      return messages.filter((item) => item.role === 'notice').map((item) => item.content);
    };

    // 1. Чат goose в проекте с выбранной общей группой.
    const chat = await stand.api('/provider-chat/chats', {
      method: 'POST',
      body: { title: 'Вопрос', workdir: project },
    });
    check('чат goose заведён', chat.status < 300, chat.text.slice(0, 200));
    const chatId = chat.body?.id;
    const pinned = await stand.api(
      `/chat/${encodeURIComponent(`goose:${chatId}`)}/group-settings?projectPath=${encodeURIComponent(project)}`,
      { method: 'PUT', body: { groupChoice: `global:${chosen.body?.id}` } },
    );
    check('группа выбрана в чате', pinned.status < 300, pinned.text.slice(0, 200));
    const sent = await stand.api(`/provider-chat/chats/${chatId}/send`, {
      method: 'POST',
      body: { text: 'Привет' },
    });
    check('сообщение принято', sent.status < 300, sent.text.slice(0, 200));
    await same('чат с выбранной группой');
    const said = await noticeOf(chatId);
    check(
      'в ленте чата — заметка с обеими группами и «не действует»',
      said.some(
        (text) =>
          text.includes('«Выбранная»') && text.includes('«Привязанная»') && text.includes(noneText),
      ),
      JSON.stringify(said),
    );

    // 2. Разделение: двое детей goose в копиях проекта.
    const before = new Set((await chatsIn()).map((item) => item.id));
    const split = await stand.api('/chat/split', {
      method: 'POST',
      body: {
        projectPath: project,
        startRuns: true,
        proposal: {
          groups: [
            {
              title: 'Подписи',
              branch: 'split/labels',
              kind: 'mechanical',
              tasks: ['переименовать подписи'],
            },
            {
              title: 'Скидка',
              branch: 'split/discount',
              kind: 'implementation',
              tasks: ['посчитать скидку'],
            },
          ],
        },
      },
    });
    check('разделение принято', split.status < 300, `${split.status} ${split.text.slice(0, 300)}`);
    await same('разделение');
    const children = (await chatsIn()).filter((item) => !before.has(item.id));
    check('дети разделения заведены у goose', children.length >= 2, String(children.length));
    for (const child of children) {
      const notes = await noticeOf(child.id);
      check(
        `ребёнок «${child.title}»: заметка «не действует» с привязанной группой`,
        notes.some((text) => text.includes('«Привязанная»') && text.includes(noneText)),
        JSON.stringify(notes),
      );
    }

    // 3. Продолжение в чистой сессии.
    const known = new Set((await chatsIn()).map((item) => item.id));
    const handoff = await stand.api('/chat/handoff', {
      method: 'POST',
      body: {
        projectPath: project,
        startRun: true,
        proposal: { done: 'подписи переименованы', next: 'посчитать скидку по купону' },
      },
    });
    check(
      'продолжение заведено',
      handoff.status < 300,
      `${handoff.status} ${handoff.text.slice(0, 300)}`,
    );
    await same('продолжение в чистой сессии');
    const next = (await chatsIn()).filter((item) => !known.has(item.id));
    check('продолжение — разговор goose', next.length === 1, String(next.length));
    if (next[0]) {
      const notes = await noticeOf(next[0].id);
      check(
        'в ленте продолжения — заметка «не действует»',
        notes.some((text) => text.includes('«Привязанная»') && text.includes(noneText)),
        JSON.stringify(notes),
      );
    }

    // 4. Перенос разговора Claude → goose.
    const plan = await stand.api('/portability/carry');
    const candidate = (plan.body?.candidates ?? []).find((item) => item.key === sid);
    check('разговор Claude предложен к переносу', Boolean(candidate), plan.text.slice(0, 300));
    const carried = new Set((await chatsIn()).map((item) => item.id));
    const carry = await stand.api('/portability/carry/apply', {
      method: 'POST',
      body: { keys: [sid] },
    });
    check('перенос выполнен', carry.status < 300, `${carry.status} ${carry.text.slice(0, 300)}`);
    await same('перенос Claude → goose');
    const moved = (await chatsIn()).filter((item) => !carried.has(item.id));
    check(
      'перенесённый разговор — у goose',
      moved.length === 1,
      `${moved.length}; ответ переноса: ${carry.text.slice(0, 400)}`,
    );
    if (moved[0]) {
      const notes = await noticeOf(moved[0].id);
      check(
        'в ленте перенесённого — заметка «не действует»',
        notes.some((text) => text.includes(noneText)),
        JSON.stringify(notes),
      );
    }
    const end = treeHash(stand.cfg);
    check(
      'после всех ходов каталог Claude тот же, что до них',
      end.hash === base.hash,
      `${base.hash} → ${end.hash}`,
    );
    const states = ((await stand.api('/groups')).body ?? []).map((group) => group.isEnabled);
    check(
      'после всех ходов группы в Claude выключены',
      states.every((state) => state === false),
      JSON.stringify(states),
    );
  },
);
