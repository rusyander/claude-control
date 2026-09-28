#!/usr/bin/env node
/**
 * Фальшивый `claude` для кадров «Тесты → папка e2e» со стороны чата — подменена
 * ТОЛЬКО модель. Панель запускает его своим маршрутом чата с теми же флагами,
 * что и живой CLI, и всё вокруг настоящее: строку о папке тестов он читает из
 * той системной дописки, которую панель ему передала, тест кладёт в ту папку,
 * которую она назвала, а кейс по концу хода заводит сама панель — без просьбы
 * и без второго захода агента.
 *
 * Не нашёл строки о папке — пишет об этом и ничего не кладёт: кадр «тест лёг в
 * папку» тогда не снимется, и пропажа строки видна, а не спрятана.
 *
 * Ход печатается строками stream-json (`domains/chat/ChatRunner.ts`); живой
 * режим (`--input-format stream-json`) держит процесс и ждёт следующей реплики.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const argv = process.argv.slice(2);
if (argv.includes('--version')) {
  process.stdout.write('2.1.177 (Claude Code)\n');
  process.exit(0);
}

const SESSION = '5f0e2c1a-7b3d-4e8f-9a61-2c4d8e0f1a37';
const out = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
const valueOf = (name) => {
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : undefined;
};

function appended() {
  const file = valueOf('--append-system-prompt-file');
  if (file) {
    try {
      return readFileSync(file, 'utf8');
    } catch {
      return '';
    }
  }
  return valueOf('--append-system-prompt') ?? '';
}

const SPEC = [
  "import { test, expect } from '@playwright/test';",
  '',
  "test.describe('Оформление', () => {",
  "  test('[checkout-001] заказ оплачивается картой @smoke', async ({ page }) => {",
  '    // Given в корзине один товар',
  "    await page.goto('/cart');",
  '    // When покупатель платит картой',
  "    await page.getByRole('button', { name: 'Оплатить картой' }).click();",
  '    // Then показан номер заказа',
  "    await expect(page.getByTestId('order-number')).toBeVisible();",
  '  });',
  '});',
  '',
].join('\n');

function turn(text) {
  const english = /[a-z]{3}/i.test(text) && !/[а-яё]/i.test(text);
  const dir = appended().match(/e2e folder "([^"]+)"/)?.[1];
  out({ type: 'system', subtype: 'init', session_id: SESSION, model: 'claude-opus-5', tools: [] });
  const say = (line) =>
    out({
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: line } },
    });
  if (!dir) {
    say(english ? 'The panel named no test folder.' : 'Панель не назвала папку тестов.');
  } else {
    const file = join(process.cwd(), dir, 'checkout.spec.ts');
    mkdirSync(join(process.cwd(), dir), { recursive: true });
    writeFileSync(file, SPEC, 'utf8');
    out({
      type: 'assistant',
      message: {
        id: 'msg_write',
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_write',
            name: 'Write',
            input: { file_path: file, content: SPEC },
          },
        ],
      },
    });
    out({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_write', content: 'File created' }],
      },
    });
    say(
      english
        ? `The test is in ${dir}/checkout.spec.ts — the autotest folder the panel named. The case «[checkout-001]» appears in Tests by itself when this turn ends.`
        : `Тест лёг в ${dir}/checkout.spec.ts — в папку автотестов, которую назвала панель. Кейс «[checkout-001]» раздел «Тесты» заведёт сам, когда ход закончится.`,
    );
  }
  out({
    type: 'result',
    subtype: 'success',
    is_error: false,
    total_cost_usd: 0,
    duration_ms: 1,
    session_id: SESSION,
  });
}

if (argv.includes('--input-format')) {
  createInterface({ input: process.stdin }).on('line', (line) => {
    if (!line.trim()) return;
    const message = JSON.parse(line);
    const content = message.message?.content;
    const text = Array.isArray(content)
      ? content.map((part) => part.text ?? '').join(' ')
      : String(content ?? '');
    turn(text);
    // Один ход на съёмку. Живой процесс держит каталог проекта, а ретранслятор
    // панели переживает её остановку — без выхода съёмка не убрала бы проект.
    setTimeout(() => process.exit(0), 3000);
  });
} else {
  turn(argv.at(-1) ?? '');
}
