import { describe, expect, it } from 'vitest';
import { checkReadOnlySql, stripSql } from './sql-guard.ts';

const reasonOf = (sql: string): string => {
  const verdict = checkReadOnlySql(sql);
  return verdict.ok ? 'ok' : verdict.reason;
};

describe('checkReadOnlySql', () => {
  it.each([
    'select 1',
    'SELECT * FROM users WHERE id = $1',
    'with recent as (select * from orders) select count(*) from recent',
    'explain select * from users',
    'EXPLAIN (ANALYZE, BUFFERS) select 1',
    'show search_path',
    'table users',
    'values (1), (2)',
    '(select 1) union (select 2)',
    'select 1;',
    'select 1;  -- последний комментарий',
    "select 'delete from users; drop table x' as text",
    'select "update" from t',
    'select created_at, updated_at, deleted from t',
    'select $$ insert into t $$, $body$ ; $body$',
    'select a$b$ from t',
    "select E'it\\'s; delete' as s",
    '/* /* вложенный */ drop */ select 1',
  ])('пропускает чтение: %s', (sql) => {
    expect(reasonOf(sql)).toBe('ok');
  });

  it.each([
    ['', 'empty'],
    ['  ;  ', 'empty'],
    ['-- только комментарий', 'empty'],
    ['select 1; select 2', 'multiple'],
    ['select 1; delete from users', 'multiple'],
    ['delete from users', 'not-read'],
    ['insert into t values (1)', 'not-read'],
    ['set statement_timeout = 0', 'not-read'],
    ['begin', 'not-read'],
    ['do $$ begin perform 1; end $$', 'not-read'],
    ['copy users to stdout', 'not-read'],
    ['with gone as (delete from users returning *) select * from gone', 'denied-word'],
    ['select * into backup_users from users', 'denied-word'],
    ['explain analyze delete from users', 'denied-word'],
    ['select pg_terminate_backend(123)', 'denied-function'],
    ['select pg_catalog.pg_cancel_backend (123)', 'denied-function'],
    ['select "pg_terminate_backend"(123)', 'denied-function'],
    ["select set_config('statement_timeout', '0', false)", 'denied-function'],
    ["select dblink_exec('host=x', 'drop table t')", 'denied-function'],
    ["select pg_read_file('/etc/passwd')", 'denied-function'],
    ["select pg_ls_dir('.')", 'denied-function'],
    ["select lo_import('/etc/passwd')", 'denied-function'],
    ['select pg_sleep(600)', 'denied-function'],
    ["select nextval('users_id_seq')", 'denied-function'],
    ['select pg_advisory_lock(1)', 'denied-function'],
    ['select U&"\\0070g_sleep"(1)', 'unicode-escape'],
    ["select 'не закрыта", 'unterminated'],
    ['select 1 /* не закрыт', 'unterminated'],
    ['select $$ без конца', 'unterminated'],
  ])('отказывает: %s → %s', (sql, reason) => {
    expect(reasonOf(sql)).toBe(reason);
  });

  it('отдаёт текст без завершающей точки с запятой и называет первое слово', () => {
    expect(checkReadOnlySql('  WITH x AS (select 1) select * from x ;  ')).toEqual({
      ok: true,
      sql: 'WITH x AS (select 1) select * from x',
      firstWord: 'with',
    });
  });

  it('называет слово и функцию, по которым отказал', () => {
    expect(checkReadOnlySql('drop table users')).toEqual({
      ok: false,
      reason: 'not-read',
      word: 'drop',
    });
    expect(checkReadOnlySql('select pg_reload_conf()')).toEqual({
      ok: false,
      reason: 'denied-function',
      name: 'pg_reload_conf',
    });
  });
});

describe('stripSql', () => {
  it('прячет содержимое строк, но оставляет имена в кавычках словами', () => {
    expect(stripSql(`select 'a;b', "My Col" -- x\nfrom t`).text).toBe(
      `select '', "My_Col"  \nfrom t`,
    );
  });
});
