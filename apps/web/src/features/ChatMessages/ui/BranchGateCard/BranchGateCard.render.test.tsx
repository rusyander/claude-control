import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from '@tanstack/react-router';
import { i18n } from '@shared/config/i18n';
import type { PendingBranchGate } from '../BranchGateCard.types';
import { gateTarget } from '../../lib/gateTarget';
import { BranchGateCard } from './BranchGateCard';

/**
 * Карточка «Первая правка — где работаем?» (Telegram 26.10, R1): на ней не было
 * ни файла, который агент собирался править, ни «?» в справку — человек видел
 * каталог и имя ветки и не понимал, о чём его спрашивают.
 */

const gate = (input: unknown): PendingBranchGate => ({
  toolName: 'Edit',
  input,
  toolUseId: 'tool-1',
  cwd: 'C:/work/app',
  branch: 'agent/poprav-shapku-cdd372',
  children: [{ number: 1, title: 'Шапка', branch: 'fix/header', status: 'started' }],
});

async function render(input: unknown): Promise<string> {
  // Ссылка справки — роутерная: карточка рисуется под настоящим роутером.
  const router = createRouter({
    routeTree: createRootRoute({
      component: () => (
        <BranchGateCard gates={[gate(input)]} onDecide={async () => ({ ok: true })} />
      ),
    }),
    history: createMemoryHistory({ initialEntries: ['/chat'] }),
  });
  await router.load();
  return renderToStaticMarkup(<RouterProvider router={router} />);
}

describe('карточка ворот ветки', () => {
  it('называет файл правки и ведёт «?» в справку чата', async () => {
    const html = await render({ file_path: 'C:/work/app/src/Header.tsx', old_string: 'a' });

    expect(html).toContain(i18n.t('chat.branchGate.target'));
    expect(html).toContain('C:/work/app/src/Header.tsx');
    expect(html).toMatch(/href="\/help\?topic=chat"/);
    expect(html).toContain('data-branch-gate');
  });

  it('без пути во входе — ни строки файла, ни выдуманного пути', async () => {
    const html = await render({ command: 'sed -i s/a/b/ x.ts' });

    expect(html).not.toContain(i18n.t('chat.branchGate.target'));
    expect(html).toMatch(/href="\/help\?topic=chat"/);
  });
});

describe('файл правки из входа вызова', () => {
  it('свой CLI, тетрадка, чужой CLI', () => {
    expect(gateTarget({ file_path: 'a.ts' })).toBe('a.ts');
    expect(gateTarget({ notebook_path: 'n.ipynb' })).toBe('n.ipynb');
    expect(gateTarget({ path: 'b.ts' })).toBe('b.ts');
  });

  it('нет пути, пустой путь, не объект — нет файла', () => {
    expect(gateTarget({ command: 'ls' })).toBeUndefined();
    expect(gateTarget({ file_path: '  ' })).toBeUndefined();
    expect(gateTarget(undefined)).toBeUndefined();
    expect(gateTarget('a.ts')).toBeUndefined();
  });
});
