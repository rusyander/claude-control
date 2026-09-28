/**
 * Сквозной ход агента панели над её собственными настройками (U5b). Кейс
 * panel-agent-manage-001.
 *
 * Подменена только модель — фальшивый `claude` (`fake-cli-panel-agent-manage.mjs`)
 * на PATH одноразовой панели. Путь целиком настоящий: `POST /api/agent/run` →
 * процесс CLI с `--mcp-config` панели → переходник `tools/mcp/panel.mjs` →
 * действия (удалить копию, каркас плагина, журнал защиты данных) → карточки →
 * решение человека (`/api/agent/pending/:id` с Origin окна) → диск.
 *
 * Свидетельства: файлы на диске одноразового дома (копия, каркас), строки
 * `agent-cli.jsonl` (что модель ПОЛУЧИЛА от панели) и ответ в файле разговора.
 * Ветки: отклонено (копия цела), одобрено (копии нет), повтор (отказ до
 * карточки), изменение (каркас на диске), чтение (ни одной карточки).
 *
 * Стенд одноразовый: свой дом, свой PATH; стенд человека не трогается.
 * Запуск: `node tools/qa/check-agent-manage-walk.mjs`.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { runOnStand, wait } from './throwaway-stand.mjs';
import { FAKE_PANEL_AGENT_MANAGE_CLI_SOURCE } from './fake-cli-panel-agent-manage.mjs';

const BACKUP = 'settings.json.2026-09-01T10-00-00-000Z.bak';
let backupPath = '';
let pluginDir = '';

const journalEntry = (at) =>
  JSON.stringify({
    at,
    path: '/v1/messages',
    apiKind: 'anthropic',
    decision: 'masked',
    bytes: 100,
    hits: [{ ruleId: 'r', ruleName: 'Имя', action: 'mask', placeholder: '[ИМЯ_1]', count: 1 }],
  });

await runOnStand(
  {
    label: 'agent-manage-walk',
    web: false,
    fakeCli: { claude: FAKE_PANEL_AGENT_MANAGE_CLI_SOURCE },
    seed: ({ root, cfg }) => {
      const appData = join(cfg, 'agentdeck');
      mkdirSync(join(appData, 'backups'), { recursive: true });
      backupPath = join(appData, 'backups', BACKUP);
      writeFileSync(backupPath, '{"model":"old"}\n');
      writeFileSync(
        join(appData, 'dlp-journal.jsonl'),
        `${journalEntry('2026-09-28T10:00:00.000Z')}\n${journalEntry('2026-09-28T11:00:00.000Z')}\n`,
      );
      pluginDir = join(root, 'plugins');
      mkdirSync(pluginDir, { recursive: true });
    },
  },
  async (stand, check) => {
    // Без фронта окном панели считается адрес WEB_PORT = порт API + 1 (throwaway-stand).
    const origin = `http://127.0.0.1:${Number(new URL(stand.apiUrl).port) + 1}`;
    const cliCalls = () => {
      const file = join(stand.bin, 'agent-cli.jsonl');
      return existsSync(file)
        ? readFileSync(file, 'utf8')
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line))
        : [];
    };

    async function turn(content, decide) {
      const conversationId = `walk-${randomUUID()}`;
      const cards = [];
      let settled = false;
      const running = fetch(`${stand.apiUrl}/api/agent/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin },
        body: JSON.stringify({
          messages: [{ role: 'user', content }],
          conversationId,
          context: { route: '/history' },
        }),
      })
        .then(async (res) => ({ status: res.status, text: await res.text() }))
        .finally(() => (settled = true));
      const seen = new Set();
      for (let t = 0; t < 120_000 && !settled; t += 200) {
        for (const card of (await stand.api('/agent/pending')).body ?? []) {
          if (seen.has(card.id)) continue;
          seen.add(card.id);
          cards.push(card);
          const answer = await stand.api(`/agent/pending/${card.id}`, {
            method: 'POST',
            headers: { origin },
            body: { decision: decide(card) },
          });
          if (answer.status !== 200) throw new Error(`решение карточки: HTTP ${answer.status}`);
        }
        await wait(200);
      }
      const response = await running;
      const conversation = (await stand.api(`/agent/conversations/${conversationId}`)).body;
      return { response, cards, reply: conversation?.messages?.at(-1)?.content ?? '' };
    }

    // ── Удалить копию: отклонено ─────────────────────────────────────────────
    const rejected = await turn(`Удали копию «${BACKUP}»`, () => 'reject');
    check(
      'отклонено: запуск принят (200)',
      rejected.response.status === 200,
      rejected.response.text,
    );
    check(
      'отклонено: одна карточка delete_backup:danger с русской сводкой',
      rejected.cards.length === 1 &&
        rejected.cards[0].name === 'delete_backup' &&
        rejected.cards[0].risk === 'danger' &&
        /[а-я]/i.test(rejected.cards[0].preview?.summary ?? ''),
      JSON.stringify(rejected.cards.map((card) => [card.name, card.risk, card.preview?.summary])),
    );
    check('отклонено: копия на диске цела', existsSync(backupPath));
    check(
      'отклонено: ответ говорит, что копия не удалена',
      rejected.reply.startsWith(`Копия ${BACKUP} не удалена`),
      rejected.reply,
    );

    // ── Удалить копию: одобрено ──────────────────────────────────────────────
    const approved = await turn(`Удали копию «${BACKUP}»`, () => 'approve');
    check('одобрено: одна карточка', approved.cards.length === 1);
    check('одобрено: копии на диске нет', !existsSync(backupPath));
    check(
      'одобрено: ответ называет сделанное',
      approved.reply === `Удалил копию ${BACKUP}.`,
      approved.reply,
    );

    // ── Повтор: копии нет — отказ до карточки ────────────────────────────────
    const again = await turn(`Удали копию «${BACKUP}»`, () => 'approve');
    check('повтор: ни одной карточки', again.cards.length === 0);
    check(
      'повтор: ответ передаёт отказ панели «No backup»',
      again.reply.startsWith(`Копия ${BACKUP} не удалена`) && again.reply.includes('No backup'),
      again.reply,
    );

    // ── Каркас плагина: изменение, файлы на диске ────────────────────────────
    const plugin = await turn(`Создай плагин walk-kit в папке «${pluginDir}»`, () => 'approve');
    check(
      'плагин: карточка scaffold_plugin:change',
      plugin.cards.map((card) => `${card.name}:${card.risk}`).join(',') ===
        'scaffold_plugin:change',
      JSON.stringify(plugin.cards.map((card) => [card.name, card.risk])),
    );
    const target = join(pluginDir, 'walk-kit');
    check(
      'плагин: манифест и commands/ на диске, agents/ нет',
      existsSync(join(target, '.claude-plugin', 'plugin.json')) &&
        existsSync(join(target, 'commands')) &&
        !existsSync(join(target, 'agents')),
    );
    check(
      'плагин: ответ называет сделанное',
      plugin.reply === 'Создал каркас плагина walk-kit.',
      plugin.reply,
    );

    // ── Журнал защиты данных: чтение без карточки ────────────────────────────
    const before = cliCalls().length;
    const journal = await turn('Сколько записей в журнале защиты данных?', () => 'approve');
    const call = cliCalls()
      .slice(before)
      .find((item) => item.name === 'dlp_journal');
    check('журнал: ни одной карточки', journal.cards.length === 0);
    check(
      'журнал: модель получила ответ dlp_journal',
      call?.isError === false,
      JSON.stringify(call),
    );
    check(
      'журнал: ответ называет две записи',
      journal.reply === 'В журнале защиты данных записей: 2.',
      journal.reply,
    );
  },
);
