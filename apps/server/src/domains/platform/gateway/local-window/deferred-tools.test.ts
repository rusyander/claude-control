import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DEFERRED_TOOL_MARK, expandDeferredTools } from './deferred-tools.ts';

/**
 * @covers gateway/local-window/deferred-tools.ts — отложенные инструменты на пути к llama-server (L7)
 * @scenario до `ToolSearch` отложенных в `tools` нет и заглушка снята; после — ссылка
 *   развёрнута в описание, инструмент в `tools` со схемой, а шапка (`tools` без
 *   пометки) та же, что до подгрузки; чужой шаблон получает инструмент как есть.
 *
 * Тела — форма двух запросов настоящего `claude` 2.1.286 с `ENABLE_TOOL_SEARCH=true`
 * (`__fixtures__/tool-search-2.1.286.json`, тексты урезаны, порядок и поля — с провода).
 */

interface Wire {
  before: Record<string, unknown>;
  after: Record<string, unknown>;
}
const wire = JSON.parse(
  readFileSync(new URL('./__fixtures__/tool-search-2.1.286.json', import.meta.url), 'utf8'),
) as Wire;

type Tool = { name: string; description?: string; input_schema?: unknown; defer_loading?: true };
const toolsOf = (body: Record<string, unknown>): Tool[] => (body.tools ?? []) as Tool[];
/** То, что шаблон напечатает в шапке: инструменты без пометки, по порядку. */
const header = (body: Record<string, unknown>): string =>
  JSON.stringify(toolsOf(body).filter((tool) => tool.description !== DEFERRED_TOOL_MARK));

describe('expandDeferredTools', () => {
  it('до подгрузки: заглушка снята, отложенных в списке нет', () => {
    const out = expandDeferredTools(wire.before, true);
    const names = toolsOf(out).map((tool) => tool.name);
    expect(names).not.toContain('DeferredToolPlaceholder');
    expect(names).toContain('ToolSearch');
    expect(toolsOf(out).some((tool) => tool.defer_loading)).toBe(false);
  });

  it('после подгрузки: ссылка развёрнута в описание, обещанное ToolSearch', () => {
    const out = expandDeferredTools(wire.after, true);
    const marker = toolsOf(wire.after).find((tool) => tool.name === 'mcp__t8marker__marker');
    const text = JSON.stringify(out.messages);
    expect(text).not.toContain('tool_reference');
    const line = `<function>${JSON.stringify({
      description: marker?.description,
      name: 'mcp__t8marker__marker',
      parameters: marker?.input_schema,
    })}</function>`;
    expect(text).toContain(JSON.stringify(`<functions>\n${line}\n</functions>`).slice(1, -1));
  });

  it('подгруженный — в tools со схемой (по нему грамматика вызова), но с пометкой', () => {
    const out = expandDeferredTools(wire.after, true);
    const marker = toolsOf(out).find((tool) => tool.name === 'mcp__t8marker__marker');
    expect(marker).toEqual({
      name: 'mcp__t8marker__marker',
      description: DEFERRED_TOOL_MARK,
      input_schema: toolsOf(wire.after).find((tool) => tool.name === 'mcp__t8marker__marker')
        ?.input_schema,
    });
  });

  it('шапка после подгрузки та же, что до неё: кеш сервера не перечитывается', () => {
    expect(header(expandDeferredTools(wire.after, true))).toBe(
      header(expandDeferredTools(wire.before, true)),
    );
  });

  it('чужой шаблон: инструмент в шапке как есть, без пометки и без defer_loading', () => {
    const out = expandDeferredTools(wire.after, false);
    const marker = toolsOf(out).find((tool) => tool.name === 'mcp__t8marker__marker');
    expect(marker?.description).toBe(
      toolsOf(wire.after).find((tool) => tool.name === 'mcp__t8marker__marker')?.description,
    );
    expect(marker?.defer_loading).toBeUndefined();
  });

  it('ссылка на инструмент, которого уже нет в списке, называется, а не теряется', () => {
    const body = {
      ...wire.after,
      tools: toolsOf(wire.after).filter((tool) => tool.name !== 'mcp__t8marker__marker'),
    };
    const text = JSON.stringify(expandDeferredTools(body, true).messages);
    expect(text).toContain('mcp__t8marker__marker: tool is no longer available');
  });

  it('без отложенных и без ссылок — тот же объект', () => {
    const body = { model: 'm', tools: [{ name: 'Read', input_schema: {} }], messages: [] };
    expect(expandDeferredTools(body, true)).toBe(body);
  });

  it('все отложенные без ссылок — поле tools уходит целиком, а не пустым списком', () => {
    const body = {
      model: 'm',
      tools: [{ name: 'DeferredToolPlaceholder', input_schema: {}, defer_loading: true }],
      messages: [],
    };
    expect('tools' in expandDeferredTools(body, true)).toBe(false);
  });

  it('каждый наш шаблон чата знает пометку: иначе она ушла бы модели текстом', () => {
    const dir = new URL('../../../local-models/data/templates/', import.meta.url);
    const templates = readdirSync(fileURLToPath(dir)).filter((name) => name.endsWith('.jinja'));
    expect(templates.length).toBeGreaterThan(0);
    for (const name of templates)
      expect(readFileSync(new URL(name, dir), 'utf8'), name).toContain(DEFERRED_TOOL_MARK);
  });
});
