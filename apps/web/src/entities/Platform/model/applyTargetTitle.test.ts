import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { PLATFORM_ASSISTANT_TARGET } from '@agentdeck/contracts';
import { applyTargetTitle } from './applyTargetTitle';

/**
 * Имя цели контура. Ассистента сервер называет по-русски (`serverText`), и
 * код к полю `title` плана не едет: перевод держит одна функция. Найдено
 * живьём: журнал применения брал `target.title` мимо неё и под английским
 * интерфейсом читался «Ассистент панели written». Закрепка серверных литералов
 * этого не видит — текст на сервере закодирован, а сырым его показал клиент;
 * поэтому сырой показ имени цели заперт здесь, обходом исходников.
 */

const SRC = resolve(import.meta.dirname, '../../..');
/** Срезы, которые показывают цели применения контура. */
const SLICES = ['pages/Platform', 'features/PlatformEditor', 'entities/Platform'];
const RAW_TITLE = /\btargets?\??\.title\b|\btarget\??\.title\b/;

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

describe('applyTargetTitle', () => {
  const t = (key: string) => (key === 'platform.consumer.assistant' ? 'Panel assistant' : key);

  it('ассистент — словом интерфейса, CLI — своим торговым именем', () => {
    expect(
      applyTargetTitle({ targetId: PLATFORM_ASSISTANT_TARGET, title: 'Ассистент панели' }, t),
    ).toBe('Panel assistant');
    expect(applyTargetTitle({ targetId: 'claude', title: 'Claude Code' }, t)).toBe('Claude Code');
  });

  it('ни один экран контура не показывает имя цели мимо applyTargetTitle', () => {
    const offenders = SLICES.flatMap((slice) => sources(join(SRC, slice)))
      .filter((file) => !file.endsWith('applyTargetTitle.ts'))
      .filter((file) => RAW_TITLE.test(readFileSync(file, 'utf8')))
      .map((file) => relative(SRC, file).replaceAll('\\', '/'));
    expect(offenders).toEqual([]);
  });
});
