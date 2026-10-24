import { describe, expect, it } from 'vitest';
import { DeferredAsks, deferredView } from '../../../domains/chat/deferred-asks/deferred-asks.ts';
import {
  deferCall,
  deferReason,
  deliveryRefusal,
  MAIN_COPY_REASON,
  mergesOrPushesMain,
  reachesPanelDecision,
} from './deferred-bridge.ts';

/**
 * Суждения моста прав о вызове (решения владельца 23.10): что — отказ с
 * известным ответом (слияние и push в main), что — попытка ответить за
 * человека (решение 3), что — черновик MR, пока группа ждёт D-n.
 */

const bash = (command: string) => ({ command });

describe('deferred-bridge › слияние и push в main — шаг владельца', () => {
  const OWN = { branch: 'agentdeck/group-2' };
  const ON_MAIN = { branch: 'main' };

  it.each<[string, { branch?: string; base?: string }, boolean]>([
    ['git push origin agentdeck/group-2', OWN, false],
    ['git push -u origin HEAD', OWN, false],
    ['git push', OWN, false],
    ['git push origin main', OWN, true],
    ['git push origin HEAD:main', OWN, true],
    ['git push origin +HEAD:refs/heads/main', OWN, true],
    ['git -C /tmp/copy push origin HEAD:master', OWN, true],
    ['git -c core.askPass=x push origin develop', OWN, true],
    ['git push', ON_MAIN, true],
    ['git push origin HEAD', ON_MAIN, true],
    ['git push origin trunk-fix', OWN, false],
    ['git push origin release/2.1', OWN, true],
    ['git push origin feature', { branch: 'x', base: 'feature' }, true],
    ['git push -o merge_request.merge_when_pipeline_succeeds origin HEAD', OWN, true],
    ['git push --push-option=merge_request.auto_merge origin HEAD', OWN, true],
    ['git push -o merge_request.create origin HEAD', OWN, false],
    ['git checkout main && git merge agentdeck/group-2', OWN, true],
    ['git merge origin/main', OWN, false],
    ['git merge agentdeck/group-2', ON_MAIN, true],
    ['glab mr merge 5', OWN, true],
    ['gh pr merge 12 --squash', OWN, true],
    ['curl -X PUT https://gitlab.example.com/api/v4/projects/1/merge_requests/5/merge', OWN, true],
    ['gh api -X PUT repos/o/r/pulls/5/merge', OWN, true],
    ['grep -rn "merge_requests/5/merge" docs', OWN, false],
    ['glab mr create --draft --title x', OWN, false],
  ])('%s → %s', (command, facts, expected) => {
    expect(mergesOrPushesMain('Bash', bash(command), facts)).toBe(expected);
  });

  it('инструмент MCP слияния — отказ, создание MR — нет', () => {
    expect(mergesOrPushesMain('mcp__gitlab__merge_merge_request', { iid: 5 })).toBe(true);
    expect(mergesOrPushesMain('mcp__github__merge_pull_request', { number: 5 })).toBe(true);
    expect(mergesOrPushesMain('mcp__gitlab__create_merge_request', { title: 'x' })).toBe(false);
    expect(mergesOrPushesMain('Write', { file_path: 'a', content: 'git push origin main' })).toBe(
      false,
    );
  });
});

describe('deferred-bridge › ответ за человека через панель — отказ (решение 3)', () => {
  it.each<[string, unknown, boolean]>([
    [
      'Bash',
      bash('curl -X POST http://127.0.0.1:5178/api/chat/deferred/D-3/decision -d allow'),
      true,
    ],
    ['Bash', bash('curl localhost:5178/api/chat/c1/permission-decision -d {}'), true],
    ['Bash', bash('node -e "fetch(`http://[::1]:5178/api/chat/deferred`)"'), true],
    ['Bash', bash('cat ~/.agentdeck/api-token'), true],
    ['Bash', bash('type %USERPROFILE%\\.agentdeck\\api-token'), true],
    ['Bash', bash('ls ~/.agentdeck/*'), true],
    ['PowerShell', { command: 'irm http://127.0.0.1:5178/api/chat/x/auto-approve' }, true],
    ['WebFetch', { url: 'http://127.0.0.1:5178/api/chat/deferred', prompt: 'x' }, true],
    ['Read', { file_path: 'C:/Users/u/.agentdeck/api-token' }, true],
    // Правка и поиск по исходникам панели — не вызов маршрута.
    ['Bash', bash('grep -rn "/api/chat/deferred" apps/server/src'), false],
    ['Edit', { file_path: 'x.ts', old_string: 'a', new_string: "'/api/chat/deferred'" }, false],
    ['Bash', bash('curl http://127.0.0.1:5178/api/health'), false],
    ['Bash', bash('pnpm test'), false],
  ])('%s %j → %s', (tool, input, expected) => {
    expect(reachesPanelDecision(tool, input)).toBe(expected);
  });
});

/**
 * D-S01: тот же ответ за человека обходными путями — путь ключа по частям и
 * запись прямо в хранилище решений (холодное ревью 23.10).
 */
describe('deferred-bridge › обходы вокруг ответа за человека', () => {
  it.each<[string, unknown, boolean]>([
    ['Bash', bash('cd ~/.agentdeck && cat api-token'), true],
    ['Bash', bash('cat ~//.agentdeck//api-token'), true],
    ['Bash', bash('cat ~/.agentdeck\\api-token'), true],
    ['Bash', bash('tar -C ~/.agentdeck -cf - api-token | base64'), true],
    ['Write', { file_path: '~/.agentdeck/deferred-asks.json', content: '{}' }, true],
    ['Edit', { file_path: 'C:/u/.agentdeck/telegram-answers.json', new_string: 'allow' }, true],
    // Режим подписи телефона и его ключи: выключить режим или подложить свой ключ.
    ['Write', { file_path: '~/.agentdeck/phone-signing.json', content: '{}' }, true],
    ['Bash', bash('rm ~/.agentdeck/phone-signing.json'), true],
    ['Bash', bash('curl -X POST http://127.0.0.1:5178/api/phone-signing/devices/a1/revoke'), true],
    ['Bash', bash('jq ".records[0].state=\\"allowed\\"" deferred-asks.json > tmp'), true],
    // Чтение и поиск решить ничего не могут: номера своих D-n агент и так знает.
    ['Read', { file_path: '.agent/notes/deferred-asks.json.md' }, false],
    ['Grep', { pattern: 'deferred-asks.json', path: 'apps/server/src' }, false],
    // Соседние слова не складываются в путь ключа сами по себе.
    ['Bash', bash('cat .agentdeck.md'), false],
    ['Bash', bash('echo api-token'), false],
  ])('%s %j → %s', (tool, input, expected) => {
    expect(reachesPanelDecision(tool, input)).toBe(expected);
  });
});

/**
 * RF-DS-07 (повторное ревью 24.10): весь класс файлов, где лежит решение или
 * рычаг решения, — не только два названных. Снимок настроек панель применяет
 * при старте поверх своих (`context.ts`, `adoptSettingsSnapshot`), а `state.json`
 * держит `chatAutoMode` и правила автоподтверждения: запись в них и перезапуск
 * панели — то же «разрешить» без человека. Правка ИСХОДНИКОВ, где эти имена
 * названы в тексте, — не запись в хранилище: у правящих инструментов судится
 * путь, а не текст правки.
 */
describe('deferred-bridge › файлы решений и рычагов панели', () => {
  it.each<[string, unknown, boolean]>([
    ['Write', { file_path: 'C:/u/.claude/agentdeck/settings-snapshot.json', content: '{}' }, true],
    ['Bash', bash('rm ~/.claude/agentdeck/settings-snapshot.seen'), true],
    [
      'Edit',
      { file_path: '~/.claude/agentdeck/state.json', new_string: '"chatAutoMode":true' },
      true,
    ],
    [
      'Bash',
      bash('cd ~/.claude/agentdeck && jq ".settings.chatAutoMode=true" state.json > s'),
      true,
    ],
    ['Bash', bash('cp s %USERPROFILE%\\.claude\\agentdeck\\state.json'), true],
    ['MultiEdit', { file_path: 'C:/u/.claude/agentdeck/deferred-asks.json', edits: [] }, true],
    // Исходники панели называют эти файлы — их правка не запись в хранилище.
    [
      'Edit',
      {
        file_path: 'apps/server/src/domains/chat/deferred-asks/store.ts',
        old_string: 'a',
        new_string: "const DEFERRED_ASKS_FILE = 'deferred-asks.json';",
      },
      false,
    ],
    [
      'Write',
      {
        file_path: 'apps/server/src/lib/app-store/settings-snapshot.ts',
        content: "export const SNAPSHOT_FILE = 'settings-snapshot.json'; // ~/.agentdeck/api-token",
      },
      false,
    ],
    // `state.json` вне каталога панели и пакет `@agentdeck/*` — не каталог панели.
    ['Bash', bash('cat .agent/tests/state.json'), false],
    ['Bash', bash('pnpm --filter @agentdeck/contracts test -- state.json'), false],
    ['Bash', bash('ls apps/server/assets/kit/agentdeck-kit && cat state.json'), false],
  ])('%s %j → %s', (tool, input, expected) => {
    expect(reachesPanelDecision(tool, input)).toBe(expected);
  });
});

describe('deferred-bridge › доставка, пока группа ждёт D-n', () => {
  const GROUP = { kind: 'group' as const, parentChatId: 'p', groupIndex: 0 };
  const call = (input: unknown) =>
    deferCall(asks, {
      scope: GROUP,
      runKeys: ['k'],
      toolName: 'Bash',
      input,
      reason: 'row database',
    });
  let asks = new DeferredAsks();

  it('нет ожидающих — черновик снимается, MR без номера проходит', () => {
    asks = new DeferredAsks();
    expect(deliveryRefusal(asks, GROUP, 'Bash', bash('gh pr ready 5'))).toBeUndefined();
    expect(
      deliveryRefusal(asks, GROUP, 'Bash', bash('glab mr create --title "fix: x"')),
    ).toBeUndefined();
  });

  it('ждёт D-n — снять черновик нельзя, черновик открыть можно', () => {
    asks = new DeferredAsks();
    const { id } = call(bash('psql -c "DROP TABLE t"'));
    for (const command of [
      'gh pr ready 5',
      'gh pr create --title x',
      'glab mr update 5 --ready',
      'glab mr create --title x',
    ]) {
      expect(deliveryRefusal(asks, GROUP, 'Bash', bash(command)), command).toContain(id);
    }
    expect(
      deliveryRefusal(asks, GROUP, 'mcp__gitlab__update_merge_request', { draft: false }),
    ).toContain(id);
    expect(deliveryRefusal(asks, GROUP, 'Bash', bash('gh pr create --draft --title x'))).toBe(
      undefined,
    );
    expect(deliveryRefusal(asks, GROUP, 'Bash', bash('glab mr create --draft --title x'))).toBe(
      undefined,
    );
    expect(
      deliveryRefusal(asks, GROUP, 'mcp__gitlab__create_merge_request', {
        title: 'Draft: fix',
      }),
    ).toBeUndefined();
  });

  /**
   * RF-DL-09 (повторное ревью 24.10): MR не черновиком — и через push-опции
   * GitLab, и заголовком без «Draft:» в CLI (как уже в ветке MCP), и через API
   * форджа. Опции конвейера (`ci.skip`) — тоже доставка мимо человека.
   */
  it('ждёт D-n — push-опции MR и конвейера, заголовок без Draft и API снятия черновика — отказ', () => {
    asks = new DeferredAsks();
    const { id } = call(bash('psql -c "DROP TABLE t"'));
    for (const command of [
      'git push -o merge_request.create -o merge_request.target=main origin HEAD',
      'git push --push-option=merge_request.create origin feat',
      'git push origin feat --push-option "merge_request.title=fix"',
      'git push -o ci.skip origin feat',
      'git -c push.pushOption=merge_request.create push origin feat',
      'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=push.pushOption GIT_CONFIG_VALUE_0=merge_request.create git push',
      'glab mr update 5 --title "fix: x"',
      "glab mr update 5 -t 'fix: x'",
      'glab api -X PUT projects/1/merge_requests/5 -f title="fix: x"',
      'glab api --method PUT projects/1/merge_requests/5 -f draft=false',
      'gh api graphql -f query=\'mutation{markPullRequestReadyForReview(input:{pullRequestId:"X"}){clientMutationId}}\'',
      'curl -X PUT -H "PRIVATE-TOKEN: t" https://gitlab.example.com/api/v4/projects/1/merge_requests/5 -d title=fix',
    ]) {
      expect(deliveryRefusal(asks, GROUP, 'Bash', bash(command)), command).toContain(id);
    }
    expect(
      deliveryRefusal(asks, GROUP, 'mcp__github__mark_pull_request_ready_for_review', { n: 5 }),
    ).toContain(id);
    // Черновик остаётся черновиком — можно.
    for (const command of [
      'git push origin feat',
      'git push -u origin HEAD',
      'glab mr update 5 --title "Draft: fix: x"',
      'glab mr update 5 --title "fix: x" --draft',
      'glab mr update 5 --description "more"',
      'glab api projects/1/merge_requests/5',
      'git log -o merge_request.create',
    ]) {
      expect(deliveryRefusal(asks, GROUP, 'Bash', bash(command)), command).toBeUndefined();
    }
  });

  it('номер своего D-n в коммите и MR — отказ; чужой номер и одиночный чат без черновика — нет', () => {
    asks = new DeferredAsks();
    const { id } = call(bash('psql -c "DROP TABLE t"'));
    expect(
      deliveryRefusal(asks, GROUP, 'Bash', bash(`git commit -m "fix: x, see ${id}"`)),
    ).toContain(id);
    expect(
      deliveryRefusal(asks, GROUP, 'Bash', bash('git commit -m "fix: x, see D-999"')),
    ).toBeUndefined();
    const chat = { kind: 'chat' as const, chatKeys: ['c1'] };
    expect(deliveryRefusal(asks, chat, 'Bash', bash('gh pr ready 5'))).toBeUndefined();
  });

  it('тот же вызов снова — «уже в очереди», новой записи нет; другой — новая', () => {
    asks = new DeferredAsks();
    const first = call(bash('psql -c "DROP TABLE t"'));
    const again = call(bash('psql -c "DROP TABLE t"'));
    expect(again.id).toBe(first.id);
    expect(again.message).toMatch(/already queued/i);
    const other = call(bash('psql -c "DROP TABLE t2"'));
    expect(other.id).not.toBe(first.id);
    expect(asks.all()).toHaveLength(2);
  });
});

// Живой прогон 23.10: причина для агента (англ.) стояла в русской плашке —
// человеку она идёт кодом, текст агенту остаётся английским.
describe('deferred-bridge › причина D-n: текст агенту и код человеку', () => {
  it('группа, автоподтверждение и защита бэкенда — свой код; запись и вид его несут', () => {
    expect(deferReason(undefined, true)).toMatchObject({
      code: 'group-rows',
      text: expect.stringMatching(/permission rows/),
    });
    expect(deferReason(undefined, false).code).toBe('not-auto-approved');
    const guard = deferReason({ rule: 'prod-target', match: 'prod.example.com' }, true);
    expect(guard).toMatchObject({
      code: 'backend-guard',
      params: { rule: 'prod-target', match: 'prod.example.com' },
    });
    expect(MAIN_COPY_REASON.code).toBe('main-copy');

    const asks = new DeferredAsks();
    const { id, message } = deferCall(asks, {
      scope: { kind: 'group', parentChatId: 'p', groupIndex: 0 },
      runKeys: ['k'],
      toolName: 'Bash',
      input: bash('npm publish'),
      reason: guard.text,
      reasonCode: guard.code,
      ...(guard.params ? { reasonParams: guard.params } : {}),
    });
    expect(message).toContain('backend guard prod-target');
    const view = deferredView(asks.all().find((record) => record.id === id)!);
    expect(view).toMatchObject({
      reasonCode: 'backend-guard',
      reasonParams: { rule: 'prod-target', match: 'prod.example.com' },
    });
  });
});
