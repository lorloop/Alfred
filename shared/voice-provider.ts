export const VOICE_PROVIDERS = ['openai', 'mistral', 'local'] as const;
export type VoiceProvider = (typeof VOICE_PROVIDERS)[number];
export const voiceProviderLabel = (provider: VoiceProvider) =>
  provider === 'mistral'
    ? 'Mistral · Voxtral 3'
    : provider === 'local'
      ? 'Local · LocalAI'
      : 'OpenAI · GPT Live';
export function isVoiceProvider(value: unknown): value is VoiceProvider {
  return value === 'openai' || value === 'mistral' || value === 'local';
}
/** Fournisseurs dont le son passe par le serveur Cornelius (PCM 16 kHz), sans WebRTC client. */
export const usesServerAudio = (provider: VoiceProvider | undefined) =>
  provider === 'mistral' || provider === 'local';
