import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ClaudePaths, Group } from '@agentdeck/contracts';
import type { PathStepDraftRequest } from '@agentdeck/contracts/group-path';
import { PATH_STEP_BLOCK_KIND } from '@agentdeck/contracts/group-path';
import { blockLang } from '@agentdeck/contracts/brand';
import { AppStore } from '../../lib/app-store.ts';
import { draftPathStep } from './step-assistant.ts';
import type { GroupAsk } from './model.ts';

/**
 * Черновики ассистента шага (`group-path-drafts.json`) — ревью 28.09:
 * F-262 — файл читался ДО долгого вызова модели и писался целиком после:
 * два круга подряд (две вкладки, два шага) — поздний стирал разговор раннего;
 * F-263 — запись без `at` роняла сортировку, и каждый круг отвечал 500.
 */
describe('черновики ассистента шага', () => {
  let dir: string;
  let appData: string;
  let deps: { paths: ClaudePaths; store: AppStore };

  const group = { id: 'g1', name: 'Группа', members: [], path: { steps: [] } } as unknown as Group;
  const request = (text: string): PathStepDraftRequest =>
    ({ mode: 'author', anchor: 'work', lang: 'ru', text }) as PathStepDraftRequest;
  const reply = `\`\`\`${blockLang(PATH_STEP_BLOCK_KIND)}\n${JSON.stringify({
    title: { ru: 'Шаг', en: 'Step' },
    prompt: { ru: 'Сделай', en: 'Do it' },
  })}\n\`\`\``;
  const drafts = (): Record<string, unknown> =>
    JSON.parse(readFileSync(join(appData, 'group-path-drafts.json'), 'utf8'));

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-step-drafts-'));
    appData = join(dir, 'agentdeck');
    mkdirSync(appData, { recursive: true });
    deps = {
      paths: {
        root: dir,
        settings: join(dir, 'settings.json'),
        claudeMd: join(dir, 'CLAUDE.md'),
        skills: join(dir, 'skills'),
        hooks: join(dir, 'hooks'),
        appData,
      } as ClaudePaths,
      store: new AppStore(appData),
    };
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('F-262: два круга с перекрытием — оба разговора остаются в файле', async () => {
    const pending: (() => void)[] = [];
    const ask: GroupAsk = () =>
      new Promise((resolve) => {
        pending.push(() => resolve(reply));
      });
    const ids = ['c1', 'c2'];
    const makeId = () => ids.shift()!;

    const first = draftPathStep(deps, ask, 'P', group, request('первый'), makeId);
    const second = draftPathStep(deps, ask, 'P', group, request('второй'), makeId);
    // Оба уже прочли файл и ждут модель; отвечает сначала первый, потом второй.
    pending[0]!();
    await first;
    pending[1]!();
    await second;

    expect(Object.keys(drafts()).sort()).toEqual(['c1', 'c2']);
  });

  it('F-263: запись без `at` не роняет круг и вытесняется первой', async () => {
    writeFileSync(
      join(appData, 'group-path-drafts.json'),
      JSON.stringify({ old: { groupId: 'g1', messages: [] } }),
    );
    const ask: GroupAsk = () => Promise.resolve(reply);

    const result = await draftPathStep(deps, ask, 'P', group, request('текст'), () => 'c3');

    expect(result.conversationId).toBe('c3');
    expect(Object.keys(drafts())).toEqual(['c3', 'old']);
  });
});
