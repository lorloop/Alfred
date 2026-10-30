import { randomUUID } from 'node:crypto';
import type OpenAI from 'openai';
import type { LocalAISettings, LocalAIService } from '../../shared/local-ai.js';
import { apiBase, localClient, NO_THINKING, stripReasoning } from './local-client.js';
import type { VoiceConfiguration, VoiceEvent, VoiceProviderAdapter } from './provider.js';

/** PCM au bord de Cornelius : mono PCM16, 16 kHz. */
export const LOCAL_SAMPLE_RATE = 16_000;
const BYTES_PER_MS = (LOCAL_SAMPLE_RATE * 2) / 1000;
/** Trame d’analyse de la détection de parole : 20 ms. */
const FRAME_BYTES = 20 * BYTES_PER_MS;
const PRE_ROLL_MS = 300;
const MIN_SPEECH_MS = 250;
const MAX_UTTERANCE_MS = 30_000;
/** Parole continue nécessaire pour couper Cornelius pendant qu’il parle (écho du haut-parleur). */
const BARGE_IN_MS = 400;
/** Avance maximale du son envoyé sur la lecture réelle : coupure rapide en cas d’interruption. */
const PLAYBACK_LEAD_MS = 400;
const PLAYBACK_FRAME_MS = 100;
const TOOL_TIMEOUT_MS = 60_000;
const MAX_TOOL_ROUNDS = 8;
const MAX_PENDING_TOOLS = 32;
const HISTORY_LIMIT = 40;
const GREETING_TIMEOUT_MS = 4_000;
/** Délai pour le premier morceau de réponse du LLM : chargement du modèle, file d’attente… */
const LLM_FIRST_CHUNK_MS = 45_000;
const SESSION_MAX_MS = 15 * 60_000;

/** Phrases que Whisper invente sur du bruit ou du silence, surtout en français. */
const HALLUCINATIONS = [
  /sous-titr/i,
  /amara\.org/i,
  /merci d['’]avoir regard/i,
  /abonnez-vous/i,
  /^\W*(merci|bonsoir|au revoir)\W*$/i,
];
export function isLikelyHallucination(text: string): boolean {
  const value = text.trim();
  return !value || value.length < 2 || HALLUCINATIONS.some((pattern) => pattern.test(value));
}

export function encodeWav(pcm: Buffer, sampleRate = LOCAL_SAMPLE_RATE): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** WAV PCM16 (ou flottant 32 bits) quelconque → mono PCM16 16 kHz. */
export function decodeWav(wav: Buffer): Buffer {
  if (
    wav.length < 12 ||
    wav.toString('ascii', 0, 4) !== 'RIFF' ||
    wav.toString('ascii', 8, 12) !== 'WAVE'
  )
    throw new Error('Réponse audio inattendue : WAV attendu.');
  let offset = 12;
  let format = 0;
  let channels = 0;
  let sampleRate = 0;
  let bits = 0;
  let data: Buffer | null = null;
  while (offset + 8 <= wav.length) {
    const id = wav.toString('ascii', offset, offset + 4);
    let size = wav.readUInt32LE(offset + 4);
    const start = offset + 8;
    // Les serveurs qui diffusent le WAV en continu annoncent une taille nulle ou maximale.
    if (id === 'data' && (size === 0 || start + size > wav.length)) size = wav.length - start;
    if (id === 'fmt ') {
      format = wav.readUInt16LE(start);
      channels = wav.readUInt16LE(start + 2);
      sampleRate = wav.readUInt32LE(start + 4);
      bits = wav.readUInt16LE(start + 14);
    } else if (id === 'data') {
      data = wav.subarray(start, start + size);
      break;
    }
    offset = start + size + (size % 2);
  }
  if (!data || !channels || !sampleRate) throw new Error('WAV incomplet.');
  const float = format === 3 && bits === 32;
  if (!float && !(format === 1 && bits === 16) && !(format === 0xfffe && bits === 16))
    throw new Error(`Format WAV non pris en charge (${format}, ${bits} bits).`);
  const width = bits / 8;
  const frames = Math.floor(data.length / (width * channels));
  const mono = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) {
      const at = (i * channels + c) * width;
      sum += float ? data.readFloatLE(at) : data.readInt16LE(at) / 32768;
    }
    mono[i] = sum / channels;
  }
  return resampleToPcm16(mono, sampleRate);
}

/** Interpolation linéaire vers 16 kHz : suffisant pour une voix de synthèse. */
export function resampleToPcm16(samples: Float32Array, sampleRate: number): Buffer {
  const ratio = sampleRate / LOCAL_SAMPLE_RATE;
  const length = Math.floor(samples.length / ratio);
  const output = Buffer.alloc(length * 2);
  for (let i = 0; i < length; i++) {
    const position = i * ratio;
    const index = Math.floor(position);
    const a = samples[index] ?? 0;
    const b = samples[index + 1] ?? a;
    const value = a + (b - a) * (position - index);
    output.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(value * 32767))), i * 2);
  }
  return output;
}

export function rms(pcm: Buffer): number {
  const samples = Math.floor(pcm.length / 2);
  if (!samples) return 0;
  let sum = 0;
  for (let i = 0; i < samples; i++) {
    const value = pcm.readInt16LE(i * 2) / 32768;
    sum += value * value;
  }
  return Math.sqrt(sum / samples);
}

const authorization = (apiKey?: string): Record<string, string> =>
  apiKey ? { Authorization: 'Bearer ' + apiKey } : {};

async function failure(response: Response, label: string): Promise<Error> {
  const body = (await response.text().catch(() => '')).slice(0, 200);
  return new Error(`${label} : HTTP ${response.status}${body ? ' — ' + body : ''}`);
}

export async function transcribe(
  service: LocalAIService & { language: string },
  pcm: Buffer,
  options: { apiKey?: string; signal?: AbortSignal; fetch?: typeof globalThis.fetch } = {},
): Promise<string> {
  const form = new FormData();
  form.append(
    'file',
    new Blob([new Uint8Array(encodeWav(pcm))], { type: 'audio/wav' }),
    'parole.wav',
  );
  form.append('model', service.model);
  form.append('language', service.language);
  form.append('response_format', 'json');
  const response = await (options.fetch ?? fetch)(
    apiBase(service.baseUrl) + '/audio/transcriptions',
    {
      method: 'POST',
      body: form,
      headers: authorization(options.apiKey),
      signal: options.signal ?? AbortSignal.timeout(30_000),
    },
  );
  if (!response.ok) throw await failure(response, 'Transcription');
  const body = (await response.json()) as { text?: unknown };
  return typeof body.text === 'string' ? body.text.trim() : '';
}

export async function synthesize(
  service: LocalAIService & { voice: string },
  text: string,
  options: { apiKey?: string; signal?: AbortSignal; fetch?: typeof globalThis.fetch } = {},
): Promise<Buffer> {
  const response = await (options.fetch ?? fetch)(apiBase(service.baseUrl) + '/audio/speech', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authorization(options.apiKey) },
    body: JSON.stringify({
      model: service.model,
      input: text,
      ...(service.voice ? { voice: service.voice } : {}),
      response_format: 'wav',
    }),
    signal: options.signal ?? AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw await failure(response, 'Synthèse vocale');
  return decodeWav(Buffer.from(await response.arrayBuffer()));
}

/** Découpe un texte qui arrive au fil de l’eau en phrases à dire dès qu’elles sont complètes. */
export function sentenceSplitter() {
  let buffer = '';
  return {
    push(text: string): string[] {
      buffer += text;
      const sentences: string[] = [];
      // Une ponctuation compte seulement suivie d’un espace : « 3.5 » ou une fin de tampon
      // attendent la suite.
      let consumed = 0;
      for (const match of buffer.matchAll(/[.!?…]+["»”)]?\s+|\n+/g)) {
        const end = match.index + match[0].length;
        const sentence = buffer.slice(consumed, end).trim();
        if (sentence) sentences.push(sentence);
        consumed = end;
      }
      buffer = buffer.slice(consumed);
      return sentences;
    },
    flush(): string[] {
      const rest = buffer.trim();
      buffer = '';
      return rest ? [rest] : [];
    },
  };
}

/** Texte prêt à dire : sans Markdown ni liens bruts, que la synthèse lirait mot à mot. */
export function speakable(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[*_#`>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface LocalVoiceOptions {
  apiKey?: string;
  fetch?: typeof globalThis.fetch;
  /** Journal de diagnostic : durées et niveaux seulement, jamais le son ni le texte. */
  log?: (level: 'info' | 'warn', message: string, details?: Record<string, unknown>) => void;
  now?: () => number;
  /** Délai du premier morceau de réponse du LLM ; 45 s par défaut. */
  firstChunkTimeoutMs?: number;
  /** Horloge de lecture, remplaçable dans les tests. */
  setInterval?: typeof globalThis.setInterval;
}

type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;
type ToolCall = { id: string; name: string; arguments: string };

/**
 * Conversation vocale avec des services compatibles OpenAI : détection de parole ici,
 * transcription, réponse du LLM avec les outils de Cornelius, puis synthèse phrase par phrase.
 */
export function createLocalVoiceAdapter(
  settings: LocalAISettings,
  options: LocalVoiceOptions = {},
): VoiceProviderAdapter {
  const now = options.now ?? Date.now;
  const log = options.log ?? (() => {});
  const firstChunkTimeout = options.firstChunkTimeoutMs ?? LLM_FIRST_CHUNK_MS;
  const http = { apiKey: options.apiKey, fetch: options.fetch };
  return {
    async connect(configuration, emit) {
      const client = localClient(settings.llm, options.apiKey, 60_000, options.fetch);
      // Erreur claire dès l’ouverture plutôt qu’au premier tour : serveur éteint, mauvaise adresse.
      try {
        await client.models.list({ timeout: 4_000 });
      } catch (error) {
        throw Object.assign(new Error('LLM local injoignable.'), {
          cause: error,
          status: (error as { status?: unknown }).status,
        });
      }
      let config: VoiceConfiguration = configuration;
      let closed = false;
      const started = now();
      const history: ChatMessage[] = [];
      const pending = new Map<string, { resolve(value: string): void; timer: NodeJS.Timeout }>();
      let turn: AbortController | null = null;
      let state: 'listening' | 'thinking' | 'speaking' = 'listening';
      const notify = (event: VoiceEvent) => {
        if (!closed) emit(event);
      };
      const setState = (next: typeof state) => {
        if (state === next) return;
        state = next;
        notify({ type: 'state', state: next });
      };

      // --- Lecture : son envoyé au rythme réel, avec une petite avance. ---
      const playback: Buffer[] = [];
      let playbackAhead = 0;
      let lastTick = now();
      let drained: (() => void) | null = null;
      const tick = () => {
        const current = now();
        playbackAhead = Math.max(0, playbackAhead - (current - lastTick));
        lastTick = current;
        while (playback.length && playbackAhead < PLAYBACK_LEAD_MS) {
          const chunk = playback.shift()!;
          playbackAhead += chunk.length / BYTES_PER_MS;
          setState('speaking');
          notify({ type: 'assistant_speech', pcm: chunk });
        }
        if (!playback.length && playbackAhead === 0 && drained) {
          const done = drained;
          drained = null;
          done();
        }
      };
      const clock = (options.setInterval ?? setInterval)(tick, 20);
      clock.unref?.();
      const play = (pcm: Buffer) => {
        const frame = PLAYBACK_FRAME_MS * BYTES_PER_MS;
        for (let at = 0; at < pcm.length; at += frame) playback.push(pcm.subarray(at, at + frame));
      };
      const playbackDone = () =>
        new Promise<void>((resolve) => {
          drained = resolve;
          tick();
        });
      const stopPlayback = () => {
        playback.length = 0;
        playbackAhead = 0;
        const done = drained;
        drained = null;
        done?.();
      };

      const resolvePending = (message: string) => {
        for (const call of pending.values()) {
          clearTimeout(call.timer);
          call.resolve(JSON.stringify({ error: message }));
        }
        pending.clear();
      };
      const interrupt = () => {
        if (!turn) return;
        turn.abort();
        turn = null;
        stopPlayback();
        resolvePending('Interrompu par la personne.');
        notify({ type: 'interrupted' });
        setState('listening');
      };

      const toolDefinitions = () =>
        config.tools.map((tool) => ({
          type: 'function' as const,
          function: { name: tool.name, description: tool.description, parameters: tool.parameters },
        }));
      const callTool = (call: ToolCall, signal: AbortSignal) =>
        new Promise<string>((resolve) => {
          if (closed || signal.aborted || pending.size >= MAX_PENDING_TOOLS) {
            resolve(JSON.stringify({ error: 'Session ou limite d’outils atteinte.' }));
            return;
          }
          const timer = setTimeout(() => {
            pending.delete(call.id);
            resolve(JSON.stringify({ error: 'Délai de l’outil dépassé.' }));
          }, TOOL_TIMEOUT_MS);
          timer.unref();
          pending.set(call.id, { resolve, timer });
          notify({
            type: 'tool_call',
            id: call.id,
            name: call.name,
            arguments: call.arguments || '{}',
          });
        });

      /** Synthèse dans l’ordre des phrases, la suivante calculée pendant que la précédente joue. */
      const speaker = (signal: AbortSignal) => {
        let chain = Promise.resolve();
        return {
          say(text: string) {
            const clean = speakable(text);
            if (!clean) return;
            const audio = synthesize(settings.tts, clean, { ...http, signal });
            audio.catch(() => {});
            chain = chain.then(async () => {
              const pcm = await audio;
              if (!signal.aborted) play(pcm);
            });
          },
          done: () => chain,
        };
      };

      const trimHistory = () => {
        while (history.length > HISTORY_LIMIT) {
          history.shift();
          // Ne jamais commencer par une réponse d’outil orpheline.
          while (history.length && history[0]!.role === 'tool') history.shift();
        }
      };

      async function respond(signal: AbortSignal, voice: ReturnType<typeof speaker>) {
        let spoken = '';
        for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
          const tools = config.tools.length && round < MAX_TOOL_ROUNDS ? toolDefinitions() : [];
          log('info', 'Appel au LLM', {
            etape: round + 1,
            messages: history.length + 1,
            outils: tools.length,
            // Taille de la demande en caractères : un contexte trop petit la tronque ou la refuse.
            taille:
              config.instructions.length +
              JSON.stringify(history).length +
              JSON.stringify(tools).length,
          });
          // Un LLM muet (modèle en chargement, file d’attente pleine) ne doit pas bloquer la session.
          const request = new AbortController();
          const relay = () => request.abort();
          signal.addEventListener('abort', relay, { once: true });
          let stalled = false;
          const watchdog = setTimeout(() => {
            stalled = true;
            request.abort();
          }, firstChunkTimeout);
          watchdog.unref?.();
          const requested = now();
          const splitter = sentenceSplitter();
          const calls = new Map<number, ToolCall>();
          let content = '';
          let thinking = false;
          let first = true;
          try {
            const stream = await client.chat.completions.create(
              {
                model: settings.llm.model,
                messages: [{ role: 'system', content: config.instructions }, ...history],
                ...(tools.length ? { tools, tool_choice: 'auto' as const } : {}),
                stream: true,
                ...NO_THINKING,
              },
              { signal: request.signal },
            );
            for await (const chunk of stream) {
              if (first) {
                first = false;
                clearTimeout(watchdog);
                log('info', 'Premier morceau du LLM', { delaiMs: now() - requested });
              }
              const delta = chunk.choices[0]?.delta;
              if (!delta) continue;
              for (const call of delta.tool_calls ?? []) {
                const current = calls.get(call.index) ?? { id: '', name: '', arguments: '' };
                if (call.id) current.id = call.id;
                if (call.function?.name) current.name += call.function.name;
                if (call.function?.arguments) current.arguments += call.function.arguments;
                calls.set(call.index, current);
              }
              let text = delta.content ?? '';
              if (!text) continue;
              content += text;
              // Raisonnement éventuel : jamais prononcé.
              if (thinking || text.includes('<think>')) {
                const end = text.indexOf('</think>');
                thinking = end < 0;
                if (thinking) continue;
                text = text.slice(end + '</think>'.length);
              }
              for (const sentence of splitter.push(text)) voice.say(sentence);
            }
          } catch (error) {
            if (stalled)
              throw new Error(
                `LLM sans réponse après ${firstChunkTimeout / 1000} s : modèle en chargement, file d’attente (Hermes ?) ou contexte trop long.`,
              );
            throw error;
          } finally {
            clearTimeout(watchdog);
            signal.removeEventListener('abort', relay);
          }
          const said = stripReasoning(content);
          if (!calls.size) {
            for (const sentence of splitter.flush()) voice.say(sentence);
            if (said) history.push({ role: 'assistant', content: said });
            return (spoken + ' ' + said).trim();
          }
          // Une phrase d’attente (« Je regarde… ») reste prononcée avant les outils.
          for (const sentence of splitter.flush()) voice.say(sentence);
          spoken = (spoken + ' ' + said).trim();
          const toolCalls = [...calls.values()].map((call) => ({
            ...call,
            id: call.id || randomUUID(),
          }));
          history.push({
            role: 'assistant',
            content: said || null,
            tool_calls: toolCalls.map((call) => ({
              id: call.id,
              type: 'function' as const,
              function: { name: call.name, arguments: call.arguments || '{}' },
            })),
          });
          for (const call of toolCalls) {
            const output = await callTool(call, signal);
            if (signal.aborted) return spoken;
            history.push({ role: 'tool', tool_call_id: call.id, content: output });
          }
        }
        return spoken;
      }

      async function runTurn(pcm: Buffer, startMs: number, endMs: number) {
        const controller = new AbortController();
        turn = controller;
        const { signal } = controller;
        setState('thinking');
        const turnStarted = now();
        try {
          const text = await transcribe(settings.stt, pcm, { ...http, signal });
          if (signal.aborted) return;
          log('info', 'Phrase transcrite', {
            dureeParoleMs: Math.round(pcm.length / BYTES_PER_MS),
            ecouteMs: now() - turnStarted,
            caracteres: text.length,
            ignoree: isLikelyHallucination(text),
          });
          if (isLikelyHallucination(text)) {
            if (turn === controller) turn = null;
            setState('listening');
            return;
          }
          notify({ type: 'user_transcript', id: randomUUID(), text, startMs, endMs });
          history.push({ role: 'user', content: text });
          trimHistory();
          const voice = speaker(signal);
          const answer = await respond(signal, voice);
          await voice.done();
          if (signal.aborted) return;
          log('info', 'Réponse prête', { totalMs: now() - turnStarted });
          await playbackDone();
          if (signal.aborted) return;
          if (answer) {
            const at = now() - started;
            notify({
              type: 'assistant_transcript',
              id: randomUUID(),
              text: answer,
              startMs: at,
              endMs: at,
            });
          }
        } catch (error) {
          if (signal.aborted) return;
          log('warn', 'Tour de conversation local en échec', {
            error: error instanceof Error ? error.message : String(error),
          });
          // Rien à dire : la personne peut reformuler, la session reste ouverte.
        } finally {
          if (turn === controller) {
            turn = null;
            setState('listening');
            notify({ type: 'turn_completed' });
          }
        }
      }

      // --- Détection de parole : énergie au-dessus du bruit de fond, fin après un silence. ---
      let pendingAudio: Buffer = Buffer.alloc(0);
      const preRoll: Buffer[] = [];
      let utterance: Buffer[] | null = null;
      let utteranceStart = 0;
      let voicedMs = 0;
      let silenceMs = 0;
      let loudMs = 0;
      let noise = 0.005;
      let peak = 0;
      let framesSeen = 0;
      let lastLevelLog = now();
      const analyse = (frame: Buffer) => {
        const level = rms(frame);
        // Bruit de fond : suit vite une baisse, lentement une hausse (une phrase ne le relève pas).
        // La première seconde calibre vite : le gain automatique du navigateur relève souvent le
        // bruit au-dessus d’un seuil fixe, et la phrase ne finirait jamais.
        const calibrating = ++framesSeen <= 1000 / 20;
        noise =
          calibrating || level < noise ? noise * 0.8 + level * 0.2 : noise * 0.998 + level * 0.002;
        const threshold = Math.max(0.01, noise * 2.5);
        const voiced = level > threshold;
        peak = Math.max(peak, level);
        if (now() - lastLevelLog >= 10_000) {
          log('info', 'Niveau du micro', {
            bruit: Number(noise.toFixed(4)),
            seuil: Number(threshold.toFixed(4)),
            crete: Number(peak.toFixed(4)),
            phraseEnCours: !!utterance,
          });
          lastLevelLog = now();
          peak = 0;
        }
        if (calibrating) return;
        // Pendant la réponse, seule une parole assez longue coupe Cornelius (son propre écho) ;
        // avant qu’il parle, reprendre la parole remplace simplement la question en cours.
        if (turn) {
          loudMs = voiced ? loudMs + 20 : 0;
          const needed =
            state !== 'speaking' ? MIN_SPEECH_MS : settings.bargeIn ? BARGE_IN_MS : Infinity;
          if (loudMs < needed) {
            preRoll.push(frame);
            while (preRoll.length > PRE_ROLL_MS / 20) preRoll.shift();
            return;
          }
          interrupt();
          loudMs = 0;
        }
        if (!utterance) {
          preRoll.push(frame);
          while (preRoll.length > PRE_ROLL_MS / 20) preRoll.shift();
          if (!voiced) return;
          utterance = [...preRoll];
          preRoll.length = 0;
          utteranceStart = now() - started - PRE_ROLL_MS;
          voicedMs = 0;
          silenceMs = 0;
          return;
        }
        utterance.push(frame);
        if (voiced) {
          voicedMs += 20;
          silenceMs = 0;
        } else silenceMs += 20;
        const length = utterance.length * 20;
        if (silenceMs < settings.silenceMs && length < MAX_UTTERANCE_MS) return;
        const audio = Buffer.concat(utterance);
        utterance = null;
        log('info', 'Fin de phrase détectée', {
          dureeMs: length,
          paroleMs: voicedMs,
          coupee: length >= MAX_UTTERANCE_MS,
        });
        if (voicedMs < MIN_SPEECH_MS) return;
        void runTurn(audio, Math.max(0, utteranceStart), now() - started);
      };

      const close = async () => {
        if (closed) return;
        turn?.abort();
        turn = null;
        stopPlayback();
        resolvePending('Session clôturée.');
        clearInterval(clock);
        clearTimeout(maximum);
        emit({ type: 'closed' });
        closed = true;
      };
      const maximum = setTimeout(() => void close(), SESSION_MAX_MS);
      maximum.unref();

      notify({ type: 'connected', id: randomUUID() });
      log('info', 'Session locale ouverte', {
        llm: settings.llm.model,
        ecoute: settings.stt.model,
        voix: settings.tts.model,
      });

      // Accueil : phrase imposée, ou générée par le LLM selon les consignes d’ouverture.
      void (async () => {
        let welcome = config.welcomeMessage?.trim() ?? '';
        if (config.welcomeInstructions) {
          try {
            const greeting = await client.chat.completions.create(
              {
                model: settings.llm.model,
                messages: [
                  { role: 'system', content: config.instructions },
                  { role: 'user', content: config.welcomeInstructions },
                ],
                max_tokens: 100,
                ...NO_THINKING,
              },
              { timeout: GREETING_TIMEOUT_MS },
            );
            const content = greeting.choices[0]?.message?.content;
            if (typeof content === 'string')
              welcome = stripReasoning(content).slice(0, 500) || welcome;
          } catch {
            // L’accueil est facultatif : phrase prévue, sinon silence.
          }
        }
        if (!welcome || closed || turn) return;
        const controller = new AbortController();
        turn = controller;
        try {
          const voice = speaker(controller.signal);
          voice.say(welcome);
          await voice.done();
          await playbackDone();
          if (controller.signal.aborted) return;
          history.push({ role: 'assistant', content: welcome });
          const at = now() - started;
          notify({
            type: 'assistant_transcript',
            id: randomUUID(),
            text: welcome,
            startMs: at,
            endMs: at,
          });
        } catch (error) {
          log('warn', 'Accueil local en échec', {
            error: error instanceof Error ? error.message : String(error),
          });
        } finally {
          if (turn === controller) {
            turn = null;
            setState('listening');
            notify({ type: 'turn_completed' });
          }
        }
      })();

      return {
        audio(pcm) {
          if (closed) return;
          pendingAudio = pendingAudio.length ? Buffer.concat([pendingAudio, pcm]) : pcm;
          let offset = 0;
          while (pendingAudio.length - offset >= FRAME_BYTES) {
            analyse(pendingAudio.subarray(offset, offset + FRAME_BYTES));
            offset += FRAME_BYTES;
          }
          pendingAudio = Buffer.from(pendingAudio.subarray(offset));
        },
        result(id, output) {
          const call = pending.get(id);
          if (!call) return;
          clearTimeout(call.timer);
          pending.delete(id);
          call.resolve(output);
        },
        async update(next) {
          // Consignes et outils comptent dès le prochain appel au LLM.
          config = next;
        },
        close,
      };
    },
  };
}
