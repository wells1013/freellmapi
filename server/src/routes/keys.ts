import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import { resolveProvider } from '../providers/index.js';
import { encrypt, decrypt, maskKey } from '../lib/crypto.js';

export const keysRouter = Router();

// Active providers — must match providers/index.ts registrations + shared/types.ts Platform.
// Moonshot and MiniMax direct integrations were dropped in V4. HuggingFace
// was dropped in V4 and re-added in V13 via the router.huggingface.co route.
const PLATFORMS = [
  'google', 'groq', 'cerebras', 'sambanova', 'nvidia', 'mistral',
  'openrouter', 'github', 'cohere', 'cloudflare', 'zhipu', 'ollama',
  'kilo', 'pollinations', 'llm7', 'huggingface', 'opencode', 'custom',
] as const;

// `key` is optional so keyless providers (Kilo's anonymous gateway) can be added
// without one; the handler enforces a non-empty key for everyone else.
const addKeySchema = z.object({
  platform: z.enum(PLATFORMS),
  key: z.string().optional(),
  label: z.string().optional(),
});

const updateKeySchema = z.object({
  enabled: z.boolean().optional(),
  label: z.string().optional(),
}).refine(data => data.enabled !== undefined || data.label !== undefined, {
  message: 'At least one of enabled or label must be provided',
});

// List all keys (masked)
keysRouter.get('/', (_req: Request, res: Response) => {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM api_keys ORDER BY created_at DESC').all() as any[];

  const keys = rows.map(row => {
    let maskedKey = '****';
    try {
      const realKey = decrypt(row.encrypted_key, row.iv, row.auth_tag);
      maskedKey = maskKey(realKey);
    } catch {
      maskedKey = '[decrypt failed]';
    }
    return {
      id: row.id,
      platform: row.platform,
      label: row.label,
      maskedKey,
      baseUrl: row.base_url ?? null,
      status: row.status,
      enabled: row.enabled === 1,
      createdAt: row.created_at,
      lastCheckedAt: row.last_checked_at,
    };
  });

  res.json(keys);
});

// Add a key
keysRouter.post('/', (req: Request, res: Response) => {
  const parsed = addKeySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }

  const { platform, label } = parsed.data;
  const isKeyless = resolveProvider(platform)?.keyless === true;
  const rawKey = parsed.data.key?.trim() ?? '';

  if (!isKeyless && !rawKey) {
    res.status(400).json({ error: { message: 'key is required' } });
    return;
  }

  // Keyless providers (Kilo anon) store a sentinel so routing sees the platform
  // as configured; the provider omits the auth header on outgoing calls.
  const keyToStore = isKeyless ? (rawKey || 'no-key') : rawKey;

  const db = getDb();

  // A keyless provider needs only one sentinel row — re-enable an existing one
  // instead of piling up duplicates each time the user clicks "Add".
  if (isKeyless) {
    const existing = db.prepare('SELECT id FROM api_keys WHERE platform = ? LIMIT 1').get(platform) as { id: number } | undefined;
    if (existing) {
      db.prepare("UPDATE api_keys SET enabled = 1, status = 'unknown' WHERE id = ?").run(existing.id);
      res.status(200).json({
        id: existing.id,
        platform,
        label: label ?? '',
        maskedKey: maskKey(keyToStore),
        status: 'unknown',
        enabled: true,
      });
      return;
    }
  }

  const { encrypted, iv, authTag } = encrypt(keyToStore);
  const result = db.prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
    VALUES (?, ?, ?, ?, ?, 'unknown', 1)
  `).run(platform, label ?? '', encrypted, iv, authTag);

  res.status(201).json({
    id: result.lastInsertRowid,
    platform,
    label: label ?? '',
    maskedKey: maskKey(keyToStore),
    status: 'unknown',
    enabled: true,
  });
});

// ── Custom OpenAI-compatible provider (#117) ──────────────────────────────
// A user-configured endpoint (llama.cpp / LM Studio / vLLM / Ollama / any
// OpenAI-compatible base_url). Each unique base_url gets its own api_keys row;
// each call registers another model that routes through that endpoint.
const customProviderSchema = z.object({
  baseUrl: z.string().url('baseUrl must be a valid URL'),
  model: z.string().optional(),
  displayName: z.string().optional(),
  apiKey: z.string().optional(),
  label: z.string().optional(),
});

async function discoverModels(baseUrl: string, apiKey?: string): Promise<string[]> {
  const url = `${baseUrl.replace(/\/+$/, '')}/models`;
  const headers: Record<string, string> = {};
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }
  const body = await response.json() as { data?: Array<{ id: string }> };
  if (!body.data || !Array.isArray(body.data)) {
    throw new Error('Unexpected response format');
  }
  return body.data.map(m => m.id);
}

function registerCustomModel(db: ReturnType<typeof getDb>, modelId: string, displayName: string, label: string): number {
  const modelPlatform = `custom-${label}`;
  db.prepare(`
    INSERT OR IGNORE INTO models
      (platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
       rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window, enabled)
    VALUES (?, ?, ?, 50, 50, 'Custom', NULL, NULL, NULL, NULL, '', NULL, 1)
  `).run(modelPlatform, modelId, displayName);

  const row = db.prepare("SELECT id FROM models WHERE platform = ? AND model_id = ?").get(modelPlatform, modelId) as { id: number };

  const inChain = db.prepare('SELECT 1 FROM fallback_config WHERE model_db_id = ?').get(row.id);
  if (!inChain) {
    const max = db.prepare('SELECT COALESCE(MAX(priority), 0) AS m FROM fallback_config').get() as { m: number };
    db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)').run(row.id, max.m + 1);
  }

  return row.id;
}

keysRouter.post('/custom/discover', async (req: Request, res: Response) => {
  const schema = z.object({ baseUrl: z.string().min(1), apiKey: z.string().optional() });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }
  try {
    const models = await discoverModels(parsed.data.baseUrl, parsed.data.apiKey);
    res.json({ models });
  } catch (err) {
    res.status(502).json({ error: { message: (err as Error).message }, models: [] });
  }
});

keysRouter.post('/custom', async (req: Request, res: Response) => {
  const parsed = customProviderSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }

  const baseUrl = parsed.data.baseUrl.trim().replace(/\/+$/, '');
  const rawKey = parsed.data.apiKey?.trim() || 'no-key';
  const label = parsed.data.label ?? 'Custom';

  const modelSpec = parsed.data.model?.trim();
  const autoDiscover = !modelSpec || modelSpec === 'auto';

  let modelIds: string[];

  if (autoDiscover) {
    try {
      modelIds = await discoverModels(baseUrl, parsed.data.apiKey?.trim() || undefined);
    } catch (err) {
      const message = (err as Error).message;
      const db = getDb();
      const existing = db.prepare("SELECT id FROM api_keys WHERE platform = 'custom' AND base_url = ? LIMIT 1").get(baseUrl) as { id: number } | undefined;
      let keyId: number;
      if (existing) {
        const { encrypted, iv, authTag } = encrypt(rawKey);
        db.prepare("UPDATE api_keys SET label = ?, base_url = ?, encrypted_key = ?, iv = ?, auth_tag = ?, status = 'unknown', enabled = 1 WHERE id = ?")
          .run(label, baseUrl, encrypted, iv, authTag, existing.id);
        keyId = existing.id;
      } else {
        const { encrypted, iv, authTag } = encrypt(rawKey);
        const r = db.prepare(`
          INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled, base_url)
          VALUES ('custom', ?, ?, ?, ?, 'unknown', 1, ?)
        `).run(label, encrypted, iv, authTag, baseUrl);
        keyId = Number(r.lastInsertRowid);
      }
      res.status(201).json({
        success: true,
        autoDiscovered: false,
        warning: `Failed to discover models: ${message}. Add models manually.`,
        keyId,
        platform: 'custom',
        baseUrl,
        maskedKey: maskKey(rawKey),
        models: [],
      });
      return;
    }
  } else {
    modelIds = [modelSpec];
  }

  const db = getDb();
  const upsert = db.transaction(() => {
    const existing = db.prepare("SELECT id FROM api_keys WHERE platform = 'custom' AND base_url = ? LIMIT 1").get(baseUrl) as { id: number } | undefined;
    let keyId: number;
    if (existing) {
      const { encrypted, iv, authTag } = encrypt(rawKey);
      db.prepare("UPDATE api_keys SET label = ?, base_url = ?, encrypted_key = ?, iv = ?, auth_tag = ?, status = 'unknown', enabled = 1 WHERE id = ?")
        .run(label, baseUrl, encrypted, iv, authTag, existing.id);
      keyId = existing.id;
    } else {
      const { encrypted, iv, authTag } = encrypt(rawKey);
      const r = db.prepare(`
        INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled, base_url)
        VALUES ('custom', ?, ?, ?, ?, 'unknown', 1, ?)
      `).run(label, encrypted, iv, authTag, baseUrl);
      keyId = Number(r.lastInsertRowid);
    }

    const firstModelId = modelIds[0];
    const modelDbIds = modelIds.map(mid => registerCustomModel(db, mid, mid, label));

    return { keyId, firstModelDbId: modelDbIds[0], modelCount: modelIds.length };
  });

  const { keyId, firstModelDbId, modelCount } = upsert();
  res.status(201).json({
    success: true,
    autoDiscovered: autoDiscover,
    keyId,
    modelDbId: firstModelDbId,
    modelCount,
    platform: 'custom',
    baseUrl,
    model: modelIds[0],
    displayName: modelIds[0],
    maskedKey: maskKey(rawKey),
    models: modelIds,
  });
});

// Delete a key
keysRouter.delete('/:id', (req: Request, res: Response) => {
  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: { message: 'Invalid key ID' } });
    return;
  }

  const db = getDb();
  const row = db.prepare('SELECT platform FROM api_keys WHERE id = ?').get(id) as { platform: string } | undefined;
  if (!row) {
    res.status(404).json({ error: { message: 'Key not found' } });
    return;
  }

  const remove = db.transaction(() => {
    db.prepare('DELETE FROM api_keys WHERE id = ?').run(id);
    // Custom models exist only because POST /custom registered them alongside
    // this endpoint key (#117) — they can't route without it. Built-in
    // platforms keep their seeded catalog rows, but once the last custom key
    // is gone, orphaned custom models would linger in the fallback chain
    // forever (#189), so cascade them away.
    if (row.platform === 'custom') {
      const remaining = db.prepare("SELECT COUNT(*) AS n FROM api_keys WHERE platform = 'custom'").get() as { n: number };
      if (remaining.n === 0) {
        db.prepare("DELETE FROM fallback_config WHERE model_db_id IN (SELECT id FROM models WHERE platform = 'custom')").run();
        db.prepare("DELETE FROM models WHERE platform = 'custom'").run();
      }
    }
  });
  remove();

  res.json({ success: true });
});

// Toggle all keys for a platform
keysRouter.patch('/platform/:platform', (req: Request, res: Response) => {
  const platform = req.params.platform as string;
  if (!(PLATFORMS as readonly string[]).includes(platform)) {
    res.status(400).json({ error: { message: `Invalid platform '${platform}'` } });
    return;
  }

  const { enabled } = req.body;
  if (typeof enabled !== 'boolean') {
    res.status(400).json({ error: { message: 'enabled must be a boolean' } });
    return;
  }

  const db = getDb();
  const result = db.prepare('UPDATE api_keys SET enabled = ? WHERE platform = ?').run(enabled ? 1 : 0, platform);

  res.json({ success: true, enabled, updatedKeys: result.changes });
});

// Update key (toggle enable/disable or edit label)
keysRouter.patch('/:id', (req: Request, res: Response) => {
  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: { message: 'Invalid key ID' } });
    return;
  }

  const parsed = updateKeySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }

  const { enabled, label } = parsed.data;
  const updates: string[] = [];
  const values: (string | number)[] = [];

  if (enabled !== undefined) {
    updates.push('enabled = ?');
    values.push(enabled ? 1 : 0);
  }
  if (label !== undefined) {
    updates.push('label = ?');
    values.push(label);
  }

  values.push(id);

  const db = getDb();
  const result = db.prepare(`UPDATE api_keys SET ${updates.join(', ')} WHERE id = ?`).run(...values);

  if (result.changes === 0) {
    res.status(404).json({ error: { message: 'Key not found' } });
    return;
  }

  const response: Record<string, unknown> = { success: true };
  if (enabled !== undefined) response.enabled = enabled;
  if (label !== undefined) response.label = label;
  res.json(response);
});
