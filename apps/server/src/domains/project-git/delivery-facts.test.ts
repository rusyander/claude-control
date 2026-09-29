import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  mrDescriptionGap,
  missingDelivery,
  readDeliveryFacts,
  webBaseOf,
} from './delivery-facts.ts';

/**
 * Доставка по фактам на настоящем git: удалённый — голый репозиторий на диске,
 * MR — служебная ссылка `refs/merge-requests/<iid>/head` в нём, как её пишет
 * GitLab. Подменена только сеть (адрес `https://…` уводится на диск через
 * `insteadOf`); чтение состояния — те самые команды, что пойдут в копии группы.
 */

const WEB = 'https://git.example.com/team/app';

function gitIn(dir: string, args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
    cwd: dir,
    encoding: 'utf8',
    windowsHide: true,
  }).trim();
}

function dropTemp(target: string): void {
  try {
    rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    // Каталог остаётся в temp — на результат теста это не влияет.
  }
}

describe('доставка по фактам git', () => {
  let root: string;
  let bare: string;
  let work: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-delivery-facts-'));
    bare = join(root, 'remote.git');
    work = join(root, 'work');
    mkdirSync(work);
    gitIn(root, ['init', '-q', '--bare', '-b', 'main', bare]);
    gitIn(work, ['init', '-q', '-b', 'main']);
    gitIn(work, ['commit', '-q', '--allow-empty', '-m', 'init']);
    gitIn(work, ['remote', 'add', 'origin', `${WEB}.git`]);
    gitIn(work, ['config', `url.${bare.replace(/\\/g, '/')}.insteadOf`, `${WEB}.git`]);
    gitIn(work, ['push', '-q', 'origin', 'main']);
    gitIn(work, ['switch', '-q', '-c', 'fix/PROJ-1']);
    writeFileSync(join(work, 'a.ts'), 'export const a = 1;\n');
    gitIn(work, ['add', 'a.ts']);
    gitIn(work, ['commit', '-q', '-m', 'fix']);
  });
  afterEach(() => dropTemp(root));

  const head = (): string => gitIn(work, ['rev-parse', 'HEAD']);
  const mrRef = (iid: number, sha: string): void => {
    gitIn(bare, ['update-ref', `refs/merge-requests/${iid}/head`, sha]);
  };

  it('не отправлено и без MR — не хватает обоих, названы по ветке', async () => {
    const facts = await readDeliveryFacts({ cwd: work, branch: 'fix/PROJ-1' });

    expect(facts).toMatchObject({ dirty: [], pushed: false });
    expect(facts.mr).toBeUndefined();
    const missing = missingDelivery(facts, 'fix/PROJ-1');
    expect(missing).toHaveLength(2);
    expect(missing.join('\n')).toContain('fix/PROJ-1');
  });

  it('отправлено и MR с той же головой — доставлено, адрес MR построен сам', async () => {
    gitIn(work, ['push', '-q', 'origin', 'fix/PROJ-1']);
    mrRef(7, head());

    const facts = await readDeliveryFacts({ cwd: work, branch: 'fix/PROJ-1' });

    expect(facts).toMatchObject({ pushed: true, mr: `${WEB}/-/merge_requests/7` });
    expect(missingDelivery(facts, 'fix/PROJ-1')).toEqual([]);
  });

  it('ссылка агента на чужой MR не засчитывается — находится свой', async () => {
    gitIn(work, ['push', '-q', 'origin', 'fix/PROJ-1']);
    const main = gitIn(work, ['rev-parse', 'main']);
    mrRef(5, main);
    mrRef(9, head());

    const facts = await readDeliveryFacts({
      cwd: work,
      branch: 'fix/PROJ-1',
      mr: `${WEB}/-/merge_requests/5`,
    });

    expect(facts.mr).toBe(`${WEB}/-/merge_requests/9`);
  });

  it('коммит после push — ветка на удалённом отстаёт, MR старой головы не в счёт', async () => {
    gitIn(work, ['push', '-q', 'origin', 'fix/PROJ-1']);
    mrRef(7, head());
    gitIn(work, ['commit', '-q', '--allow-empty', '-m', 'later']);

    const facts = await readDeliveryFacts({ cwd: work, branch: 'fix/PROJ-1' });

    expect(facts.pushed).toBe(false);
    expect(facts.mr).toBeUndefined();
  });

  it('незакоммиченное в счёт, зеркало панели — нет', async () => {
    writeFileSync(join(work, 'b.ts'), 'x');
    writeFileSync(join(work, 'a.ts'), 'export const a = 2;\n');
    writeFileSync(join(work, '.mcp.json'), '{}');

    const facts = await readDeliveryFacts({ cwd: work, branch: 'fix/PROJ-1' });

    expect(facts.dirty.sort()).toEqual(['a.ts', 'b.ts']);
    expect(missingDelivery(facts, 'fix/PROJ-1')[0]).toContain('a.ts');
  });

  /**
   * Живой прогон 29.09: панель назвала ветку `fix-GOR-1485-…-2`, а группа по
   * правилу проекта (ключи через запятую) завела и отправила свою. Проверка
   * искала панельное имя на удалённом и не нашла бы никогда.
   */
  describe('ветка, которую группа завела сама', () => {
    const own = 'fix-PROJ-1,PROJ-2/policies';

    it('отправлена с головой копии — принимается, доставка по ней', async () => {
      gitIn(work, ['switch', '-q', '-c', own]);
      gitIn(work, ['push', '-q', 'origin', own]);
      mrRef(4, head());

      const facts = await readDeliveryFacts({ cwd: work, branch: 'fix-PROJ-1-PROJ-2/policies-2' });

      expect(facts).toMatchObject({ pushed: true, branch: own, mr: `${WEB}/-/merge_requests/4` });
      expect(missingDelivery(facts, facts.branch ?? '')).toEqual([]);
    });

    it('не отправлена — не принимается: имя панели остаётся, «не отправлено»', async () => {
      gitIn(work, ['switch', '-q', '-c', own]);

      const facts = await readDeliveryFacts({ cwd: work, branch: 'fix/PROJ-1' });

      expect(facts.pushed).toBe(false);
      expect(facts.branch).toBeUndefined();
    });

    // Ревью 29.09 (A6): копия на чужой отправленной ветке при отправленной своей.
    it('ветка панели уже отправлена — чужая ветка копии не принимается', async () => {
      gitIn(work, ['push', '-q', 'origin', 'fix/PROJ-1']);
      gitIn(work, ['switch', '-q', '-c', 'develop']);
      gitIn(work, ['push', '-q', 'origin', 'develop']);

      const facts = await readDeliveryFacts({ cwd: work, branch: 'fix/PROJ-1' });

      expect(facts.branch).toBeUndefined();
      expect(facts.pushed).toBe(true);
    });

    it('в своей ветке нет ни одного ключа задачи из имени панели — не принимается', async () => {
      gitIn(work, ['switch', '-q', '-c', 'feature/other-work']);
      gitIn(work, ['push', '-q', 'origin', 'feature/other-work']);

      const facts = await readDeliveryFacts({ cwd: work, branch: 'fix-PROJ-1-PROJ-2/policies' });

      expect(facts.branch).toBeUndefined();
      expect(facts.pushed).toBe(false);
    });

    // Холодная проверка 29.09 (N1): имя панели без ключа сверять не с чем.
    it('в имени панели нет ключа — отправленный develop с MR не принимается', async () => {
      gitIn(work, ['switch', '-q', '-c', 'develop']);
      gitIn(work, ['push', '-q', 'origin', 'develop']);
      mrRef(7, head());

      const facts = await readDeliveryFacts({ cwd: work, branch: 'feature/login' });

      expect(facts.branch).toBeUndefined();
      expect(facts.pushed).toBe(false);
    });

    // N2: ветка предшественника с тем же ключом — чужая, как и его MR.
    it('ветка другой группы плана с тем же ключом не принимается', async () => {
      gitIn(work, ['push', '-q', 'origin', 'fix/PROJ-1']);
      mrRef(7, head());

      const facts = await readDeliveryFacts({
        cwd: work,
        branch: 'fix/PROJ-1-tests',
        claimed: ['fix/PROJ-1'],
      });

      expect(facts.branch).toBeUndefined();
      expect(facts.pushed).toBe(false);
    });

    // N3: ключ сверяется целиком, а не как начало большего номера.
    it('PROJ-12 в имени панели не совпадает с PROJ-123 в своей ветке', async () => {
      gitIn(work, ['switch', '-q', '-c', 'fix/PROJ-123-other']);
      gitIn(work, ['push', '-q', 'origin', 'fix/PROJ-123-other']);

      const facts = await readDeliveryFacts({ cwd: work, branch: 'fix/PROJ-12' });

      expect(facts.branch).toBeUndefined();
    });

    it('копия стоит на основной ветке удалённого — это не доставка группы', async () => {
      gitIn(work, ['switch', '-q', 'main']);

      const facts = await readDeliveryFacts({ cwd: work, branch: 'fix/PROJ-1' });

      expect(facts.pushed).toBe(false);
      expect(facts.branch).toBeUndefined();
    });
  });

  it('удалённый не отвечает — факт неизвестен, а не отрицателен', async () => {
    gitIn(work, ['config', '--unset', `url.${bare.replace(/\\/g, '/')}.insteadOf`]);
    gitIn(work, [
      'config',
      `url.${join(root, 'nowhere.git').replace(/\\/g, '/')}.insteadOf`,
      `${WEB}.git`,
    ]);

    const facts = await readDeliveryFacts({ cwd: work, branch: 'fix/PROJ-1' });

    expect(facts.unreachable).toBeTruthy();
    expect(missingDelivery(facts, 'fix/PROJ-1')).toEqual([]);
  });
});

describe('webBaseOf', () => {
  it('ssh, scp-вид и https с логином — один веб-адрес', () => {
    expect(webBaseOf('git@gitlab.example.com:team/app.git')).toBe(
      'https://gitlab.example.com/team/app',
    );
    expect(webBaseOf('ssh://git@gitlab.example.com:2222/team/app.git')).toBe(
      'https://gitlab.example.com/team/app',
    );
    expect(webBaseOf('https://oauth2:tok@gitlab.example.com/team/app.git/')).toBe(
      'https://gitlab.example.com/team/app',
    );
    expect(webBaseOf('C:/repos/app.git')).toBeUndefined();
  });
});

// Аудит 25.09, L110: пустое описание MR — пробел готовности; непрочитанное — не повод держать группу.
describe('mrDescriptionGap', () => {
  const MR = 'https://tracker.example.com/app/-/merge_requests/7';

  it('пустое описание — пробел с адресом MR, заполненное — нет', async () => {
    expect(await mrDescriptionGap(MR, async () => ({ description: '  \n' }))).toEqual({
      missing: expect.stringContaining(MR),
    });
    expect(await mrDescriptionGap(MR, async () => ({ description: 'Что и зачем.' }))).toEqual({});
  });

  it('фордж не ответил, выключен или без поля — «не проверено», а не пробел', async () => {
    expect(await mrDescriptionGap(MR, async () => undefined)).toEqual({ unchecked: true });
    expect(await mrDescriptionGap(MR, async () => ({}))).toEqual({ unchecked: true });
    expect(
      await mrDescriptionGap(MR, async () => {
        throw new Error('502');
      }),
    ).toEqual({ unchecked: true });
  });
});
