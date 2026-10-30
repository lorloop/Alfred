import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  LOCAL_AI_SERVICES,
  localAIReady,
  localAISettingsError,
  type LocalAIServiceName,
  type LocalAISettings,
  type LocalAITestResult,
  type LocalAIView,
} from '../shared/local-ai.js';
import type { LocalAIStore } from './local-ai-store.js';
import { localClient, NO_THINKING, stripReasoning } from './voice/local-client.js';
import { LOCAL_SAMPLE_RATE, synthesize, transcribe } from './voice/local.js';

const message = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).slice(0, 300);

/** Une seconde de la-440 Hz : vérifie que la transcription accepte un WAV, sans juger le texte. */
function tone(): Buffer {
  const pcm = Buffer.alloc(LOCAL_SAMPLE_RATE * 2);
  for (let i = 0; i < LOCAL_SAMPLE_RATE; i++)
    pcm.writeInt16LE(
      Math.round(Math.sin((2 * Math.PI * 440 * i) / LOCAL_SAMPLE_RATE) * 6000),
      i * 2,
    );
  return pcm;
}

/** Essaie chaque service avec les réglages donnés, sans rien enregistrer. */
export async function testLocalAI(
  settings: LocalAISettings,
  services: readonly LocalAIServiceName[],
  apiKey?: string,
  fetch?: typeof globalThis.fetch,
): Promise<LocalAITestResult[]> {
  const http = { apiKey, fetch, signal: AbortSignal.timeout(30_000) };
  const chat = async (baseUrl: string, model: string) => {
    if (!baseUrl || !model) throw new Error('Adresse ou modèle manquant.');
    const client = localClient({ baseUrl, model }, apiKey, 30_000, fetch);
    const response = await client.chat.completions.create({
      model,
      messages: [{ role: 'user', content: 'Réponds seulement : prêt.' }],
      max_tokens: 20,
      ...NO_THINKING,
    });
    const text = stripReasoning(response.choices[0]?.message?.content ?? '');
    return `Réponse : « ${text.slice(0, 60) || '(vide)'} »`;
  };
  const run = async (service: LocalAIServiceName): Promise<LocalAITestResult> => {
    const started = Date.now();
    try {
      let detail: string;
      if (service === 'llm') detail = await chat(settings.llm.baseUrl, settings.llm.model);
      else if (service === 'memory')
        detail = await chat(
          settings.memory.baseUrl || settings.llm.baseUrl,
          settings.memory.model || settings.llm.model,
        );
      else if (service === 'stt') {
        if (!settings.stt.baseUrl || !settings.stt.model)
          throw new Error('Adresse ou modèle manquant.');
        await transcribe(settings.stt, tone(), http);
        detail = 'Transcription acceptée.';
      } else {
        if (!settings.tts.baseUrl || !settings.tts.model)
          throw new Error('Adresse ou modèle manquant.');
        const pcm = await synthesize(settings.tts, 'Bonjour, je suis prêt.', http);
        detail = `Voix reçue : ${(pcm.length / (LOCAL_SAMPLE_RATE * 2)).toFixed(1)} s.`;
      }
      return { service, ok: true, detail, ms: Date.now() - started };
    } catch (error) {
      return { service, ok: false, detail: message(error), ms: Date.now() - started };
    }
  };
  // Un service à la fois : la machine IA charge parfois chaque modèle au premier appel.
  const results: LocalAITestResult[] = [];
  for (const service of services) results.push(await run(service));
  return results;
}

export function registerLocalAI(
  app: FastifyInstance,
  options: {
    store: LocalAIStore;
    requireAdmin: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    onChange: () => void;
    fetch?: typeof globalThis.fetch;
  },
) {
  const { store, requireAdmin } = options;
  const view = (): LocalAIView => {
    const settings = store.get();
    return { settings, ready: localAIReady(settings) };
  };
  app.get('/api/admin/local-ai', { preHandler: requireAdmin }, async () => view());
  app.put<{ Body: unknown }>(
    '/api/admin/local-ai',
    { preHandler: requireAdmin },
    async (request, reply) => {
      const error = localAISettingsError(request.body);
      if (error) return reply.code(400).send({ error });
      store.set(request.body as LocalAISettings);
      options.onChange();
      return view();
    },
  );
  app.post<{ Body: { settings?: unknown; service?: unknown } }>(
    '/api/admin/local-ai/test',
    { preHandler: requireAdmin },
    async (request, reply) => {
      const draft = request.body?.settings ?? store.get();
      const error = localAISettingsError(draft);
      if (error) return reply.code(400).send({ error });
      const service = request.body?.service;
      if (service !== undefined && !LOCAL_AI_SERVICES.includes(service as LocalAIServiceName))
        return reply.code(400).send({ error: 'Service inconnu.' });
      return testLocalAI(
        draft as LocalAISettings,
        service ? [service as LocalAIServiceName] : LOCAL_AI_SERVICES,
        store.apiKey(),
        options.fetch,
      );
    },
  );
}
