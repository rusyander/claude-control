/**
 * Сборка руководства по чату: `.agent/chat-guide/index.html` → `docs/CHAT-GUIDE.ru.pdf`.
 *
 * Печать целиком в общем `build-guide.mjs`; здесь — только три значения, которыми
 * это руководство отличается от остальных. `SOURCE`/`OUT`/`PAGES` по-прежнему
 * переопределяются окружением.
 */
import { buildGuide } from './build-guide.mjs';

await buildGuide({
  source: process.env.SOURCE ?? '.agent/chat-guide/index.html',
  out: process.env.OUT ?? 'docs/CHAT-GUIDE.ru.pdf',
  footer: process.env.FOOTER ?? 'Чат AgentDeck',
  pages: process.env.PAGES,
});
