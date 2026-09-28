import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ModalProps } from './modal.types';

/**
 * Коробка окна не зависит от содержимого — это договор раскладки, а не деталь
 * стиля: высота «по содержимому» заставляла окна прыгать на каждой смене
 * вкладки, догрузке и строке ошибки. Рендера в node-прогоне нет, поэтому
 * договор проверяется по самому модулю стилей; в браузере то же доказывает
 * `tools/qa/check-modal-stability.mjs`.
 */
const here = dirname(fileURLToPath(import.meta.url));
const scss = readFileSync(join(here, 'modal.module.scss'), 'utf8');

/** Тело правила верхнего уровня `.name { … }` без вложенных блоков. */
function rule(name: string): string {
  const start = scss.search(new RegExp(`^\\.${name} \\{`, 'm'));
  if (start < 0) return '';
  let depth = 0;
  let body = '';
  for (let i = scss.indexOf('{', start); i < scss.length; i += 1) {
    const ch = scss[i];
    if (ch === '{') depth += 1;
    if (ch === '}') depth -= 1;
    if (depth === 1 && ch !== '{') body += ch;
    if (depth === 0) break;
  }
  return body;
}

const SIZES: NonNullable<ModalProps['size']>[] = ['sm', 'md', 'lg', 'xl', 'full', 'fit'];

describe('раскладка модального окна', () => {
  it('каждый размер задаёт и ширину, и высоту', () => {
    for (const size of SIZES) {
      const body = rule(size);
      expect(body, size).toMatch(/--modal-width:\s*\d+px;/);
      expect(body, size).toMatch(/--modal-height:\s*\d+(px|dvh);/);
    }
  });

  it('высота окна задана размером, а не содержимым', () => {
    const content = rule('content');
    expect(content).toMatch(/\bheight:\s*min\(var\(--modal-height\)/);
    expect(content).toMatch(/\bwidth:\s*min\(var\(--modal-width\)/);
    expect(scss).not.toMatch(/min-height:\s*min\(/);
  });

  // Исключение одно и явное: fit растёт по содержимому, но не выше потолка своего
  // размера — и только оно; размеры шкалы остаются коробкой. Именно fit-content, а
  // не auto: у окна inset: 0, и auto растянуло бы его до потолка при любом тексте.
  it('fit — высота по содержимому с потолком, остальные размеры — коробка', () => {
    const fit = scss.match(/&\.fit \{[^}]*\}/g) ?? [];
    expect(fit.length).toBe(2);
    for (const block of fit) {
      expect(block).toMatch(/(^|[^-])height:\s*fit-content/);
      expect(block).toMatch(/max-height:\s*min\(var\(--modal-height\)/);
    }
    expect(scss.match(/fit-content/g)?.length).toBe(2);
    expect(scss).not.toMatch(/(^|[^-])height:\s*auto/m);
  });

  it('тело прокручивается само и держит место полосы прокрутки', () => {
    const body = rule('body');
    expect(body).toMatch(/overflow-y:\s*auto/);
    expect(body).toMatch(/scrollbar-gutter:\s*stable/);
    expect(body).toMatch(/min-height:\s*0/);
  });

  it('шапка и нижняя панель не сжимаются', () => {
    expect(rule('header')).toMatch(/flex-shrink:\s*0/);
    expect(rule('footer')).toMatch(/flex-shrink:\s*0/);
  });

  it('скругление — числом, а не токеном', () => {
    for (const match of scss.matchAll(/border-radius:\s*([^;]+);/g)) {
      expect(match[1]).toMatch(/^((\d+px|0)\s*)+$/);
    }
  });
});
