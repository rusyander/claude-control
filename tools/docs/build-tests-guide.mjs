/**
 * Сборка руководства по тестовому контуру: `.agent/tests-guide/index.html` →
 * `docs/TESTS-GUIDE.ru.pdf`.
 *
 * Печать целиком в общем `build-guide.mjs`; здесь — только три значения, которыми
 * это руководство отличается от остальных. Кадры снимает
 * `tools/docs/shots-tests-guide.mjs` при поднятом стенде.
 */
import { buildGuide } from './build-guide.mjs';

await buildGuide({
  source: process.env.SOURCE ?? '.agent/tests-guide/index.html',
  out: process.env.OUT ?? 'docs/TESTS-GUIDE.ru.pdf',
  footer: process.env.FOOTER ?? 'Тестовый контур AgentDeck',
  pages: process.env.PAGES,
});
