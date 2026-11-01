import { readFileSync, statSync } from 'node:fs';
import { mkdir, writeFile, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
export const NEVER_HIDE = ['deepseek-v4.1-flash', 'claude-haiku-4.5', 'glm-5.3-flash', 'gpt-6-luna'];
export const MAX_PROVIDERS = 50;
const MAX_BYTES = 2_000_000;
export const validId = id => typeof id === 'string' && /^[A-Za-z0-9._:/-]{1,80}$/.test(id);
export function readSuspensions(file) {
  try {
    if (!file || statSync(file).size > MAX_BYTES) return [];
    const data = JSON.parse(readFileSync(file, 'utf8'));
    if (!data || Array.isArray(data) || typeof data !== 'object' || Object.keys(data).length > 300) return [];
    return Object.entries(data).filter(([id, r]) => validId(id) && r && typeof r === 'object'
      && Object.keys(r).every(k => ['count', 'lastAt', 'providers', 'truncated', 'gone', 'until'].includes(k))
      && Number.isSafeInteger(r.count) && r.count > 0 && r.count <= 1000000
      && Number.isFinite(r.lastAt) && r.lastAt >= 0 && r.lastAt <= 8.64e15 && Number.isFinite(r.until) && r.until >= 0 && r.until <= 8.64e15
      && typeof r.gone === 'boolean' && (r.truncated === undefined || typeof r.truncated === 'boolean') && Array.isArray(r.providers) && r.providers.length <= MAX_PROVIDERS
      && r.providers.every(validId));
  } catch { return []; }
}
export async function writeSuspensions(file, data) {
  if (!file) return;
  const text = JSON.stringify(data);
  if (text.length > MAX_BYTES) return;
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(tmp, text, { mode: 0o600, flag: 'wx' });
    await rename(tmp, file);
  } catch { await unlink(tmp).catch(() => {}); }
}
