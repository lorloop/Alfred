import OpenAI from 'openai';
import type { LocalAIReasoning, LocalAIService } from '../../shared/local-ai.js';

/** Adresse saisie avec ou sans /v1 : les clients compatibles OpenAI attendent …/v1. */
export function apiBase(baseUrl: string): string {
  const url = baseUrl.trim().replace(/\/+$/, '');
  return /\/v1$/.test(url) ? url : url + '/v1';
}

export function localClient(
  service: LocalAIService,
  apiKey: string | undefined,
  timeout: number,
  fetch?: typeof globalThis.fetch,
): OpenAI {
  return new OpenAI({
    apiKey: apiKey || 'local',
    baseURL: apiBase(service.baseUrl),
    timeout,
    maxRetries: 0,
    fetch,
  });
}

/**
 * Qwen3 et ses dérivés réfléchissent à voix haute par défaut : coûteux pour une conversation.
 * `reasoning_effort: 'none'` coupe la réflexion dans LocalAI ; `chat_template_kwargs` sert aux
 * serveurs qui passent les options au gabarit (vLLM, llama.cpp). Les autres les ignorent.
 */
export const NO_THINKING = {
  reasoning_effort: 'none',
  chat_template_kwargs: { enable_thinking: false },
} as const;

/** Options d’une requête selon l’effort de réflexion choisi dans la carte « Cerveau local ». */
export function reasoningOptions(effort: LocalAIReasoning) {
  return effort === 'none'
    ? NO_THINKING
    : ({ reasoning_effort: effort, chat_template_kwargs: { enable_thinking: true } } as const);
}

/** Retire un raisonnement <think>…</think> resté dans la réponse et les clôtures Markdown. */
export function stripReasoning(text: string): string {
  return text
    .replace(/<think>[\s\S]*?(<\/think>|$)/g, '')
    .replace(/^\s*```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim();
}
