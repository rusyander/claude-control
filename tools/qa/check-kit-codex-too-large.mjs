/**
 * Набор панели слишком велик для командной строки Codex — отказ называет предел
 * и размер (Z-fix 2, 07.10.2026).
 *
 * Одноразовый стенд с провайдером Codex и ФАЛЬШИВЫМ `codex` на PATH: он только
 * отмечает, что его запустили. Через API панели (как человек) правило набора
 * раздувается за предел `CODEX_KIT_ARG_LIMIT`, режим Codex — «Ваши и набор
 * панели», в чат Codex уходит вопрос.
 *
 * Свидетели:
 *   - в ленте разговора — отказ, в котором есть и предел (24 000), и настоящий
 *     размер набора: «набор не собрался» без причины человеку не поможет;
 *   - фальшивый `codex` не запускался — прогон отказан ДО процесса;
 *   - контроль: с обычным правилом отказа нет и `codex` запускается — иначе
 *     первая половина доказывала бы только то, что Codex не стартует вообще.
 *
 * Сеть не нужна, настоящий Codex не нужен, настоящие `~/.codex` и `~/.claude`
 * не читаются и не пишутся (дом стенда временный).
 *
 * Запуск: node tools/qa/check-kit-codex-too-large.mjs
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startStand, wait } from './throwaway-stand.mjs';

let bad = 0;
const check = (text, ok, detail) => {
  console.log(
    `  ${ok ? '✓' : '✗'} ${text}${!ok && detail ? ` — ${String(detail).slice(0, 600)}` : ''}`,
  );
  if (!ok) bad += 1;
  return ok;
};

async function until(probe, seconds) {
  for (let i = 0; i < seconds * 2; i += 1) {
    const value = await probe();
    if (value) return value;
    await wait(500);
  }
  return undefined;
}

// Фальшивый codex: отметка о запуске рядом с собой и тишина. Отвечать модели
// ему незачем — проверке важен только факт запуска.
const FAKE_CODEX = `
import { appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
appendFileSync(join(dirname(fileURLToPath(import.meta.url)), 'codex-started.log'), process.argv.slice(2).join(' ') + '\\n');
process.stdout.write('OK\\n');
process.exit(0);
`;

async function scenario(oversized) {
  console.log(`\n— ${oversized ? 'набор длиннее предела' : 'контроль: обычный набор'}`);
  let stand;
  try {
    stand = await startStand({
      web: false,
      label: `kit-codex-big-${oversized ? 'big' : 'ok'}`,
      settings: { provider: 'codex' },
      fakeCli: { codex: FAKE_CODEX },
    });
    const kit = (await stand.api('/kit')).body;
    const rule = kit?.items?.find((item) => item.kind === 'rule' && item.enabled);
    if (!check('в наборе есть включённое правило', rule, JSON.stringify(kit?.items?.length)))
      return;
    const base =
      (await stand.api(`/kit/item?id=${encodeURIComponent(rule.id)}`)).body?.content ?? '';
    const filler = oversized ? `\n${'- keep every answer short and exact.\n'.repeat(900)}` : '';
    const put = await stand.api('/kit/item', {
      method: 'PUT',
      body: { id: rule.id, content: `${base}${filler}` },
    });
    check('правило набора записано', put.status === 200, put.text);
    const set = await stand.api('/kit/mode', {
      method: 'PUT',
      body: { provider: 'codex', mode: 'hybrid' },
    });
    check('режим Codex — «Ваши и набор панели»', set.status === 200, set.text);

    const chat = await stand.api('/provider-chat/chats', { method: 'POST', body: {} });
    if (!check('разговор создан', chat.status === 200 && chat.body?.id, chat.text)) return;
    const id = chat.body.id;
    const sent = await stand.api(`/provider-chat/chats/${id}/send`, {
      method: 'POST',
      body: { text: 'Привет' },
    });
    if (!check('вопрос принят', sent.status === 200, sent.text)) return;

    const started = join(stand.bin, 'codex-started.log');
    const answer = await until(async () => {
      const messages = (await stand.api(`/provider-chat/chats/${id}`)).body?.messages ?? [];
      const reply = messages.find((message) => message.role !== 'user');
      return reply ? reply : existsSync(started) && !oversized ? { started: true } : undefined;
    }, 60);
    const ran = existsSync(started) && readFileSync(started, 'utf8').trim() !== '';
    const text = JSON.stringify(answer ?? null);
    if (oversized) {
      check('в ленте есть ответ панели', answer, stand.log().slice(-1500));
      check('отказ называет предел 24 000 знаков', /24[\s ]?000/.test(text), text);
      const size = /(\d[\d\s ]{4,})\s*знак/.exec(text)?.[1]?.replace(/\D/g, '');
      check(
        'отказ называет настоящий размер набора (больше предела)',
        size !== undefined && Number(size) > 24000,
        text,
      );
      check('фальшивый codex не запускался', !ran, ran ? readFileSync(started, 'utf8') : '');
    } else {
      check('codex запущен — набор в пределе', ran, text);
      check('отказа о пределе нет', !/24[\s ]?000/.test(text), text);
    }
  } finally {
    await stand?.stop?.();
  }
}

await scenario(true);
await scenario(false);
console.log(bad ? `\nРасхождений: ${bad}` : '\nВсё сходится.');
process.exit(bad ? 1 : 0);
