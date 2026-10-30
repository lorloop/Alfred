/** Cerveau local : services compatibles OpenAI (LocalAI, Speaches…) pour parler sans compte en ligne. */
export const LOCAL_AI_SERVICES = ['llm', 'stt', 'tts', 'memory'] as const;
export type LocalAIServiceName = (typeof LOCAL_AI_SERVICES)[number];

/** Effort de réflexion demandé au LLM (`reasoning_effort`) ; `none` la coupe. */
export const LOCAL_AI_REASONING = ['none', 'low', 'medium', 'high'] as const;
export type LocalAIReasoning = (typeof LOCAL_AI_REASONING)[number];

export const localAIReasoningLabel = (effort: LocalAIReasoning) =>
  effort === 'none'
    ? 'Désactivée (le plus rapide)'
    : effort === 'low'
      ? 'Légère'
      : effort === 'medium'
        ? 'Moyenne'
        : 'Approfondie (le plus lent)';

export interface LocalAIService {
  /** Adresse du serveur, avec ou sans /v1 (http://machine-ia:8080). */
  baseUrl: string;
  model: string;
}
export interface LocalAISettings {
  llm: LocalAIService;
  stt: LocalAIService & { language: string };
  tts: LocalAIService & { voice: string };
  /** Modèle vide : celui du LLM. */
  memory: LocalAIService;
  /** Silence qui termine une phrase, en millisecondes. */
  silenceMs: number;
  /** Couper Cornelius en lui parlant pendant qu’il répond. */
  bargeIn: boolean;
  /** Phrases d’attente (« Je regarde ça. ») pendant que les outils travaillent. */
  fillers: boolean;
  /** Réflexion du LLM pendant la conversation : plus juste, mais plus lente. */
  reasoning: LocalAIReasoning;
}
export interface LocalAITestResult {
  service: LocalAIServiceName;
  ok: boolean;
  detail: string;
  ms: number;
}
export interface LocalAIView {
  settings: LocalAISettings;
  ready: boolean;
}

export const LOCAL_AI_SILENCE_MIN_MS = 300;
export const LOCAL_AI_SILENCE_MAX_MS = 3000;

export const localAIServiceLabel = (service: LocalAIServiceName) =>
  service === 'llm'
    ? 'Réponses (LLM)'
    : service === 'stt'
      ? 'Écoute (transcription)'
      : service === 'tts'
        ? 'Voix (synthèse)'
        : 'Mémoire';

/** Le LLM, l’écoute et la voix suffisent pour parler ; la mémoire reprend le LLM par défaut. */
export const localAIReady = (settings: LocalAISettings) =>
  (['llm', 'stt', 'tts'] as const).every(
    (name) => !!settings[name].baseUrl && !!settings[name].model,
  );

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};

function urlError(value: unknown, label: string): string | null {
  if (typeof value !== 'string' || value.length > 300) return `${label} : adresse invalide.`;
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:')
      return `${label} : l’adresse doit commencer par http:// ou https://.`;
    if (url.username || url.password) return `${label} : pas d’identifiants dans l’adresse.`;
  } catch {
    return `${label} : adresse invalide.`;
  }
  return null;
}
const textError = (value: unknown, label: string, max: number) =>
  typeof value !== 'string' || value.length > max || /[\u0000-\u001f]/.test(value)
    ? `${label} invalide.`
    : null;

/** Valide un objet reçu de l’administration ; renvoie le premier problème, ou null. */
export function localAISettingsError(value: unknown): string | null {
  const input = record(value);
  for (const name of LOCAL_AI_SERVICES) {
    const service = record(input[name]);
    const label = localAIServiceLabel(name);
    const error =
      urlError(service.baseUrl, label) ?? textError(service.model, `${label} : modèle`, 200);
    if (error) return error;
  }
  const language = record(input.stt).language;
  if (typeof language !== 'string' || !/^[a-z]{2,3}(-[A-Za-z]{2})?$/.test(language))
    return 'Langue de transcription invalide (fr, en…).';
  const voice = textError(record(input.tts).voice, 'Voix', 100);
  if (voice) return voice;
  const silence = input.silenceMs;
  if (
    typeof silence !== 'number' ||
    !Number.isInteger(silence) ||
    silence < LOCAL_AI_SILENCE_MIN_MS ||
    silence > LOCAL_AI_SILENCE_MAX_MS
  )
    return `Silence de fin de phrase entre ${LOCAL_AI_SILENCE_MIN_MS} et ${LOCAL_AI_SILENCE_MAX_MS} ms.`;
  if (typeof input.bargeIn !== 'boolean') return 'Réglage d’interruption invalide.';
  // Absent des réglages enregistrés avant son ajout : activé par défaut.
  if (input.fillers !== undefined && typeof input.fillers !== 'boolean')
    return 'Réglage des phrases d’attente invalide.';
  // Absent des réglages enregistrés avant son ajout : réflexion coupée.
  if (
    input.reasoning !== undefined &&
    !(LOCAL_AI_REASONING as readonly unknown[]).includes(input.reasoning)
  )
    return 'Effort de réflexion invalide.';
  return null;
}

/** Ne garde que les champs connus, sans espaces superflus. */
export function normalizeLocalAISettings(value: LocalAISettings): LocalAISettings {
  const service = <T extends LocalAIService>(item: T): T => ({
    ...item,
    baseUrl: item.baseUrl.trim(),
    model: item.model.trim(),
  });
  return {
    llm: service({ baseUrl: value.llm.baseUrl, model: value.llm.model }),
    stt: service({
      baseUrl: value.stt.baseUrl,
      model: value.stt.model,
      language: value.stt.language,
    }),
    tts: service({
      baseUrl: value.tts.baseUrl,
      model: value.tts.model,
      voice: value.tts.voice.trim(),
    }),
    memory: service({ baseUrl: value.memory.baseUrl, model: value.memory.model }),
    silenceMs: value.silenceMs,
    bargeIn: value.bargeIn,
    fillers: value.fillers ?? true,
    reasoning: value.reasoning ?? 'none',
  };
}
