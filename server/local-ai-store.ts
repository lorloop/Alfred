import type { DatabaseSync } from 'node:sqlite';
import {
  localAIReady,
  localAISettingsError,
  normalizeLocalAISettings,
  type LocalAISettings,
} from '../shared/local-ai.js';

/**
 * Table propre au cerveau local, créée à la demande plutôt que dans la liste des migrations :
 * une migration ajoutée ici décalerait celles que Cornelius ajoutera ensuite.
 */
const ready = new WeakSet<DatabaseSync>();
function ensureTable(db: DatabaseSync) {
  if (ready.has(db)) return;
  db.exec(`CREATE TABLE IF NOT EXISTS local_ai_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    active INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0, 1)),
    settings TEXT
  ) STRICT;
  INSERT OR IGNORE INTO local_ai_settings (id) VALUES (1);`);
  ready.add(db);
}

/** Vrai quand « Local · LocalAI » est le fournisseur de la conversation. */
export function localAIActive(db: DatabaseSync): boolean {
  ensureTable(db);
  return db.prepare('SELECT active FROM local_ai_settings WHERE id = 1').get()?.active === 1;
}
export function setLocalAIActive(db: DatabaseSync, active: boolean): void {
  ensureTable(db);
  db.prepare('UPDATE local_ai_settings SET active = ? WHERE id = 1').run(Number(active));
}

/** Valeurs de départ lues dans .env ; l’administration les remplace dès le premier enregistrement. */
export function defaultLocalAISettings(env: NodeJS.ProcessEnv = process.env): LocalAISettings {
  const base = env.LOCALAI_BASE_URL || 'http://127.0.0.1:8080';
  return {
    llm: { baseUrl: env.LOCALAI_LLM_BASE_URL || base, model: env.LOCALAI_LLM_MODEL || '' },
    stt: {
      baseUrl: env.LOCALAI_STT_BASE_URL || base,
      model: env.LOCALAI_STT_MODEL || 'whisper-1',
      language: env.LOCALAI_STT_LANGUAGE || 'fr',
    },
    tts: {
      baseUrl: env.LOCALAI_TTS_BASE_URL || base,
      model: env.LOCALAI_TTS_MODEL || 'tts-1',
      voice: env.LOCALAI_TTS_VOICE || '',
    },
    memory: { baseUrl: env.LOCALAI_MEMORY_BASE_URL || base, model: env.LOCALAI_MEMORY_MODEL || '' },
    silenceMs: 700,
    bargeIn: true,
  };
}

export class LocalAIStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {
    ensureTable(db);
  }
  get(): LocalAISettings {
    const defaults = defaultLocalAISettings(this.env);
    const raw = this.db
      .prepare('SELECT settings FROM local_ai_settings WHERE id = 1')
      .get()?.settings;
    if (typeof raw !== 'string') return defaults;
    try {
      const stored: unknown = JSON.parse(raw);
      return localAISettingsError(stored) ? defaults : (stored as LocalAISettings);
    } catch {
      return defaults;
    }
  }
  set(settings: LocalAISettings): LocalAISettings {
    const value = normalizeLocalAISettings(settings);
    this.db
      .prepare('UPDATE local_ai_settings SET settings = ? WHERE id = 1')
      .run(JSON.stringify(value));
    return value;
  }
  ready(): boolean {
    return localAIReady(this.get());
  }
  /** Clé facultative, commune à tous les services (LocalAI démarré avec --api-keys). */
  apiKey(): string | undefined {
    return this.env.LOCALAI_API_KEY || undefined;
  }
}
