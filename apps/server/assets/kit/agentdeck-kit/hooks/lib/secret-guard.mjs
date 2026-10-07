// Secret guard (PreToolUse on Write/Edit/Bash/PowerShell): a real-looking secret in written
// content or in a command. Placeholders pass.
//
// Verdict is `deny`, never `ask` — see `consent.mjs`. A committed secret is the one mistake here
// that cannot be undone by editing the file afterwards, so the default is refuse. Door A is open
// when the user's own message is about tokens/keys/env: they are then doing this deliberately.
// Reasons are English: a deny reason is read by the model, not by the user.
import { consentGate, ASK_THE_USER } from './consent.mjs';

const SECRET_PATTERNS = [
  { id: 'private-key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, why: 'a private key' },
  { id: 'aws', re: /\bAKIA[0-9A-Z]{16}\b/, why: 'an AWS access key' },
  {
    id: 'github',
    re: /\bghp_[A-Za-z0-9]{36}\b|\bgithub_pat_[A-Za-z0-9_]{22,}\b/,
    why: 'a GitHub token',
  },
  { id: 'gitlab', re: /\bglpat-[A-Za-z0-9_-]{20,}\b/, why: 'a GitLab token' },
  { id: 'figma', re: /\bfigd_[A-Za-z0-9_-]{20,}\b/, why: 'a Figma token' },
  { id: 'api-key', re: /\bsk-(ant-)?[A-Za-z0-9_-]{20,}\b/, why: 'an API key (sk-…)' },
  { id: 'slack', re: /\bxox[bapors]-[A-Za-z0-9-]{10,}\b/, why: 'a Slack token' },
  {
    id: 'jwt',
    re: /\beyJ[A-Za-z0-9_-]{40,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/,
    why: 'a JWT',
  },
  {
    id: 'assignment',
    re: /(api[_-]?key|secret|password|token)["']?\s*[:=]\s*["'][A-Za-z0-9+/_-]{20,}["']/i,
    why: 'a secret-shaped assignment (key/secret/password/token = a long literal)',
  },
];

const PLACEHOLDER = /(xxx|your[-_]|<[^>]+>|example|placeholder|changeme|\*\*\*|dummy|тест|test)/i;

// The user is knowingly working with credentials — writing one is then the point of the task.
const SECRET_INTENT =
  /(?<![а-яё])(?:токен|ключ|секрет|пароль|кред|переменн)[а-яё]*|\b(?:token|key|secret|password|credential|env)s?\b/i;

export default function secretGuard(input) {
  const ti = input?.tool_input ?? {};
  const filePath = String(ti.file_path ?? '');
  const payload = [ti.content, ti.new_string, ti.command].filter(Boolean).join('\n');
  if (!payload) return null;
  // .env.example and template docs are the legitimate home of placeholder keys. So are tests and
  // fixtures: a secret-shaped literal there is a sample by construction — including the samples
  // this very guard is tested against, which it otherwise refuses to let anyone write.
  if (/\.env\.example|\.sample|template/i.test(filePath)) return null;
  if (
    /(^|[\\/])(tests?|__tests__|fixtures?|__mocks__)[\\/]|\.(test|spec)\.[jt]sx?$|\.test\.mjs$/i.test(
      filePath,
    )
  )
    return null;

  for (const { id, re, why } of SECRET_PATTERNS) {
    const m = payload.match(re);
    if (m && !PLACEHOLDER.test(m[0])) {
      return consentGate(input, {
        marker: `secret-guard(${id})`,
        intent: SECRET_INTENT,
        reason: `the payload contains ${why}. A real secret must never reach a file or a command line — an integration credential lives in the panel's encrypted store (Settings → Integrations), anything else in the project's own secret store, referenced by name. ${ASK_THE_USER}`,
      });
    }
  }
  return null;
}
