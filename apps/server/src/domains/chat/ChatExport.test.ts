import { describe, it, expect } from 'vitest';
import type { ChatMessage } from '@claude-control/contracts';
import { exportChatMarkdown, exportChatJson, buildChatExport } from './ChatExport.ts';

/**
 * Тесты выгрузки разговора. Ключевое: в файл идут только роль, время и текст;
 * размышления, вызовы инструментов и вложения-картинки не попадают (служебное и
 * секреты наружу не тащим). Проверяем оба формата и мета-данные файла.
 */
describe('ChatExport', () => {
  const messages: ChatMessage[] = [
    {
      id: 'u0',
      role: 'user',
      timestamp: '2026-07-18T10:00:00.000Z',
      blocks: [{ type: 'text', text: 'Собери страницу' }],
    },
    {
      id: 'a0',
      role: 'assistant',
      timestamp: '2026-07-18T10:01:00.000Z',
      blocks: [
        { type: 'thinking', text: 'секретное размышление' },
        { type: 'tool', name: 'Write', input: '{"path":"/secret"}' },
        { type: 'text', text: 'Готово' },
      ],
    },
    // Реплика без текста (только инструмент) — в выгрузку не идёт.
    {
      id: 'a1',
      role: 'assistant',
      timestamp: '2026-07-18T10:02:00.000Z',
      blocks: [{ type: 'image', source: 'data:image/png;base64,AAAA' }],
    },
  ];

  describe('Markdown', () => {
    const md = exportChatMarkdown(messages, 'Мой разговор');

    it('содержит заголовок, роли и текст реплик', () => {
      expect(md).toContain('# Мой разговор');
      expect(md).toContain('## Пользователь');
      expect(md).toContain('Собери страницу');
      expect(md).toContain('## Claude');
      expect(md).toContain('Готово');
    });

    it('несёт время реплики', () => {
      expect(md).toContain('2026-07-18 10:00:00');
    });

    it('не тащит размышления, инструменты и base64-картинки', () => {
      expect(md).not.toContain('секретное размышление');
      expect(md).not.toContain('Write');
      expect(md).not.toContain('/secret');
      expect(md).not.toContain('base64');
    });

    it('без заголовка подставляет умолчание', () => {
      expect(exportChatMarkdown(messages)).toContain('# Разговор Claude Code');
    });
  });

  describe('JSON', () => {
    const parsed = JSON.parse(exportChatJson(messages)) as {
      role: string;
      timestamp: string;
      text: string;
    }[];

    it('массив реплик с ролью, временем и текстом', () => {
      expect(parsed).toHaveLength(2);
      expect(parsed[0]).toEqual({
        role: 'user',
        timestamp: '2026-07-18T10:00:00.000Z',
        text: 'Собери страницу',
      });
      expect(parsed[1]?.role).toBe('assistant');
      expect(parsed[1]?.text).toBe('Готово');
    });

    it('не содержит служебного и base64', () => {
      const raw = exportChatJson(messages);
      expect(raw).not.toContain('секретное размышление');
      expect(raw).not.toContain('base64');
      expect(raw).not.toContain('/secret');
    });
  });

  describe('buildChatExport', () => {
    it('md — markdown с расширением md', () => {
      const file = buildChatExport(messages, 'md', 'T');
      expect(file.ext).toBe('md');
      expect(file.mime).toContain('text/markdown');
      expect(file.content).toContain('# T');
    });

    it('json — валидный JSON с расширением json', () => {
      const file = buildChatExport(messages, 'json');
      expect(file.ext).toBe('json');
      expect(file.mime).toContain('application/json');
      expect(() => JSON.parse(file.content)).not.toThrow();
    });
  });
});
