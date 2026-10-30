import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createLocalVoiceAdapter,
  decodeWav,
  encodeWav,
  isLikelyHallucination,
  sentenceSplitter,
  speakable,
} from '../server/voice/local.js';
import { apiBase, stripReasoning } from '../server/voice/local-client.js';
import { createLocalMemoryExtractor } from '../server/voice/local-memory-extractor.js';
import { testLocalAI } from '../server/local-ai-api.js';
import { defaultLocalAISettings, LocalAIStore } from '../server/local-ai-store.js';
import { openDatabase, SessionPreferences } from '../server/storage.js';
import { localAIReady, localAISettingsError, type LocalAISettings } from '../shared/local-ai.js';
import type { VoiceEvent } from '../server/voice/provider.js';

const settings: LocalAISettings = {
  llm: { baseUrl: 'http://ia:8080', model: 'qwen3.6-35b' },
  stt: { baseUrl: 'http://127.0.0.1:8000/v1', model: 'whisper', language: 'fr' },
  tts: { baseUrl: 'http://127.0.0.1:8000', model: 'piper', voice: 'fr_FR-siwis-medium' },
  memory: { baseUrl: '', model: '' },
  silenceMs: 300,
  bargeIn: true,
};

/** Son de 16 kHz : silence ou la-440 Hz, en millisecondes. */
const pcm = (ms: number, loud: boolean, hiss = 0) => {
  const samples = (16_000 * ms) / 1000;
  const buffer = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    const tone = loud ? Math.sin((2 * Math.PI * 440 * i) / 16_000) * 12_000 : 0;
    buffer.writeInt16LE(Math.round(tone + (Math.random() * 2 - 1) * hiss), i * 2);
  }
  return buffer;
};

const sse = (chunks: unknown[]) =>
  new Response(
    chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n',
    { headers: { 'content-type': 'text/event-stream' } },
  );
const delta = (value: Record<string, unknown>, finish: string | null = null) => ({
  id: 'c',
  object: 'chat.completion.chunk',
  created: 0,
  model: 'm',
  choices: [{ index: 0, delta: value, finish_reason: finish }],
});

/** Faux LocalAI : transcription fixe, un appel d’outil puis une réponse, voix de 200 ms. */
function fakeLocalAI() {
  const calls: { url: string; body: unknown }[] = [];
  let round = 0;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    const raw = init?.body ?? (input instanceof Request ? await input.text() : undefined);
    const body = typeof raw === 'string' ? (JSON.parse(raw) as unknown) : raw;
    calls.push({ url, body });
    if (url.endsWith('/models')) return Response.json({ object: 'list', data: [] });
    if (url.endsWith('/audio/transcriptions'))
      return Response.json({ text: 'Quelle heure est-il ?' });
    if (url.endsWith('/audio/speech'))
      return new Response(new Uint8Array(encodeWav(pcm(200, true), 22_050)));
    if (url.endsWith('/chat/completions')) {
      round++;
      if (round === 1)
        return sse([
          delta({ role: 'assistant', content: '<think>hmm</think>' }),
          delta({
            tool_calls: [
              {
                index: 0,
                id: 'call-1',
                type: 'function',
                function: { name: 'clock__now', arguments: '' },
              },
            ],
          }),
          delta({ tool_calls: [{ index: 0, function: { arguments: '{}' } }] }, 'tool_calls'),
        ]);
      return sse([
        delta({ role: 'assistant', content: 'Il est **dix** heures. ' }),
        delta({ content: 'Bonne journée !' }, 'stop'),
      ]);
    }
    return new Response('introuvable', { status: 404 });
  };
  return { fetch, calls };
}

const waitFor = async (check: () => boolean, ms = 3000) => {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > ms) throw new Error('Délai dépassé');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

test('adresse avec ou sans /v1 et raisonnement retiré', () => {
  assert.equal(apiBase('http://ia:8080'), 'http://ia:8080/v1');
  assert.equal(apiBase('http://ia:8080/v1/'), 'http://ia:8080/v1');
  assert.equal(stripReasoning('<think>non</think>\n```json\n{"a":1}\n```'), '{"a":1}');
});

test('les phrases partent dès qu’elles sont complètes, sans couper les nombres', () => {
  const splitter = sentenceSplitter();
  assert.deepEqual(splitter.push('Il fait 3.5 degrés'), []);
  assert.deepEqual(splitter.push(' dehors. Prends'), ['Il fait 3.5 degrés dehors.']);
  assert.deepEqual(splitter.push(' un manteau !'), []);
  assert.deepEqual(splitter.flush(), ['Prends un manteau !']);
  assert.equal(speakable('Voir **[la météo](https://x.fr)** ici'), 'Voir la météo ici');
});

test('Whisper : les sous-titres inventés sur du silence sont écartés', () => {
  assert.equal(isLikelyHallucination('Sous-titres réalisés par la communauté d’Amara.org'), true);
  assert.equal(isLikelyHallucination('Merci.'), true);
  assert.equal(isLikelyHallucination('Allume la lumière du salon'), false);
});

test('WAV stéréo 22 kHz ramené en mono 16 kHz de même durée', () => {
  const stereo = Buffer.alloc(22_050 * 4);
  const header = encodeWav(Buffer.alloc(0), 22_050);
  header.writeUInt16LE(2, 22);
  header.writeUInt32LE(stereo.length, 40);
  const decoded = decodeWav(Buffer.concat([header, stereo]));
  assert.equal(decoded.length, 16_000 * 2);
  assert.throws(() => decodeWav(Buffer.from('pas un wav')));
});

test('réglages : validation, valeurs de .env, choix « local » persistant', () => {
  assert.equal(localAISettingsError(settings), null);
  assert.match(String(localAISettingsError({ ...settings, silenceMs: 50 })), /Silence/);
  assert.match(
    String(localAISettingsError({ ...settings, llm: { baseUrl: 'ftp://x', model: 'm' } })),
    /http/,
  );
  const defaults = defaultLocalAISettings({
    LOCALAI_BASE_URL: 'http://ia:8080',
    LOCALAI_LLM_MODEL: 'qwen',
    LOCALAI_STT_BASE_URL: 'http://127.0.0.1:8000',
  });
  assert.equal(defaults.stt.baseUrl, 'http://127.0.0.1:8000');
  assert.equal(defaults.tts.baseUrl, 'http://ia:8080');
  assert.equal(localAIReady(defaults), true);
  assert.equal(localAIReady(defaultLocalAISettings({})), false);

  const db = openDatabase(':memory:');
  const store = new LocalAIStore(db, {});
  assert.equal(store.ready(), false);
  store.set(settings);
  assert.equal(new LocalAIStore(db, {}).get().llm.model, 'qwen3.6-35b');
  const preferences = new SessionPreferences(db);
  preferences.setVoiceProvider('mistral');
  preferences.setVoiceProvider('local');
  assert.equal(new SessionPreferences(db).getVoiceProvider(), 'local');
  // Revenir à OpenAI ou Mistral retrouve le choix d’origine.
  preferences.setVoiceProvider('mistral');
  assert.equal(preferences.getVoiceProvider(), 'mistral');
  db.close();
});

test('un tour complet : parole, transcription, outil, réponse parlée', async () => {
  const ai = fakeLocalAI();
  const events: VoiceEvent[] = [];
  const connection = await createLocalVoiceAdapter(settings, { fetch: ai.fetch }).connect(
    {
      instructions: 'Tu es Cornelius.',
      tools: [{ name: 'clock__now', description: 'Heure', parameters: { type: 'object' } }],
      webSearch: false,
    },
    (event) => events.push(event),
  );
  assert.equal(events[0]?.type, 'connected');
  // Première seconde : calibrage du bruit de fond.
  connection.audio(pcm(1000, false));
  connection.audio(pcm(600, true));
  connection.audio(pcm(400, false));

  await waitFor(() => events.some((event) => event.type === 'tool_call'));
  const call = events.find((event) => event.type === 'tool_call')!;
  assert.deepEqual(
    {
      name: call.type === 'tool_call' && call.name,
      args: call.type === 'tool_call' && call.arguments,
    },
    { name: 'clock__now', args: '{}' },
  );
  assert.equal(
    events.find((event) => event.type === 'user_transcript')?.type === 'user_transcript' &&
      (events.find((event) => event.type === 'user_transcript') as { text: string }).text,
    'Quelle heure est-il ?',
  );
  connection.result(call.type === 'tool_call' ? call.id : '', '{"heure":"10:00"}');

  await waitFor(() => events.some((event) => event.type === 'turn_completed'));
  const answer = events.find((event) => event.type === 'assistant_transcript');
  assert.equal(
    answer?.type === 'assistant_transcript' && answer.text,
    'Il est **dix** heures. Bonne journée !',
  );
  assert.ok(events.some((event) => event.type === 'assistant_speech'));
  assert.ok(events.some((event) => event.type === 'state' && event.state === 'speaking'));

  // Le second appel au LLM porte le résultat de l’outil ; la synthèse ne lit pas le Markdown.
  const chats = ai.calls.filter((item) => item.url.endsWith('/chat/completions'));
  const second = chats[1]!.body as { messages: { role: string; content: unknown }[] };
  assert.deepEqual(second.messages.at(-1), {
    role: 'tool',
    tool_call_id: 'call-1',
    content: '{"heure":"10:00"}',
  });
  assert.equal(
    (chats[0]!.body as Record<string, unknown>).chat_template_kwargs !== undefined,
    true,
  );
  const spoken = ai.calls
    .filter((item) => item.url.endsWith('/audio/speech'))
    .map((item) => (item.body as { input: string }).input);
  assert.deepEqual(spoken, ['Il est dix heures.', 'Bonne journée !']);

  await connection.close();
  assert.equal(events.at(-1)?.type, 'closed');
});

test('un serveur éteint fait échouer l’ouverture avec un message clair', async () => {
  const fetch: typeof globalThis.fetch = async () => {
    throw new TypeError('fetch failed');
  };
  await assert.rejects(
    createLocalVoiceAdapter(settings, { fetch }).connect(
      { instructions: '', tools: [], webSearch: false },
      () => {},
    ),
    /LLM local injoignable/,
  );
});

test('mémoire : modèle du LLM par défaut et JSON imposé', async () => {
  const bodies: Record<string, unknown>[] = [];
  const fetch: typeof globalThis.fetch = async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return Response.json({
      id: 'c',
      object: 'chat.completion',
      created: 0,
      model: 'm',
      choices: [
        {
          index: 0,
          finish_reason: 'stop',
          message: {
            role: 'assistant',
            content: '<think></think>{"schemaVersion":1,"changes":[]}',
          },
        },
      ],
    });
  };
  const extract = createLocalMemoryExtractor(() => settings, undefined, fetch);
  assert.deepEqual(await extract({} as never, new AbortController().signal), {
    schemaVersion: 1,
    changes: [],
  });
  assert.equal(bodies[0]!.model, 'qwen3.6-35b');
  assert.equal((bodies[0]!.response_format as { type: string }).type, 'json_schema');
});

test('l’essai de l’administration signale chaque service', async () => {
  const ai = fakeLocalAI();
  const results = await testLocalAI(settings, ['stt', 'tts'], undefined, ai.fetch);
  assert.deepEqual(
    results.map((result) => [result.service, result.ok]),
    [
      ['stt', true],
      ['tts', true],
    ],
  );
  const failing = await testLocalAI(
    { ...settings, tts: { ...settings.tts, baseUrl: 'http://ailleurs' } },
    ['tts'],
    undefined,
    async () => new Response('non', { status: 500 }),
  );
  assert.equal(failing[0]!.ok, false);
  assert.match(failing[0]!.detail, /HTTP 500/);
});

test('administration : réglages enregistrés puis choix du fournisseur local', async (t) => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { createApp } = await import('../server/app.js');
  const directory = mkdtempSync(join(tmpdir(), 'cornelius-local-ai-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const services = await createApp(
    {
      databasePath: join(directory, 'cornelius.sqlite'),
      adminPassword: 'mot-de-passe-local',
      origins: ['http://localhost'],
      secureCookies: false,
    },
    { timers: false, imageGenerationRoot: directory },
  );
  t.after(() => services.app.close());
  await services.app.ready();
  const login = await services.app.inject({
    method: 'POST',
    url: '/api/login',
    headers: { origin: 'http://localhost' },
    payload: { password: 'mot-de-passe-local' },
  });
  const entry = login.cookies.find((cookie) => cookie.name === 'cornelius_admin')!;
  const headers = { origin: 'http://localhost', cookie: `${entry.name}=${entry.value}` };
  const choose = () =>
    services.app.inject({
      method: 'PATCH',
      url: '/api/admin/voice-provider',
      headers,
      payload: { provider: 'local' },
    });
  // Sans LLM renseigné, le choix est refusé avec une consigne.
  const refused = await choose();
  assert.equal(refused.statusCode, 400);
  assert.match(refused.json().error, /cerveau local/);
  assert.equal(
    (
      await services.app.inject({
        method: 'PUT',
        url: '/api/admin/local-ai',
        headers,
        payload: { ...settings, silenceMs: 10 },
      })
    ).statusCode,
    400,
  );
  const saved = await services.app.inject({
    method: 'PUT',
    url: '/api/admin/local-ai',
    headers,
    payload: settings,
  });
  assert.equal(saved.statusCode, 200);
  assert.equal(saved.json().ready, true);
  const chosen = await choose();
  assert.equal(chosen.statusCode, 200);
  assert.equal(chosen.json().state.voiceProvider, 'local');
  assert.equal(services.controller.snapshot().state.setup?.voiceKey, true);
  assert.equal(
    (await services.app.inject({ method: 'GET', url: '/api/admin/local-ai' })).statusCode,
    401,
  );
});

test('un bruit de fond amplifié par le navigateur n’empêche pas la fin de phrase', async () => {
  const ai = fakeLocalAI();
  const events: VoiceEvent[] = [];
  const logs: string[] = [];
  const connection = await createLocalVoiceAdapter(settings, {
    fetch: ai.fetch,
    log: (_level, message) => logs.push(message),
  }).connect({ instructions: '', tools: [], webSearch: false }, (event) => events.push(event));
  // Souffle constant d’environ 0,03 de niveau : au-dessus de l’ancien seuil fixe.
  const hiss = 1_800;
  connection.audio(pcm(1500, false, hiss));
  connection.audio(pcm(700, true, hiss));
  connection.audio(pcm(600, false, hiss));
  await waitFor(() => events.some((event) => event.type === 'user_transcript'));
  assert.ok(logs.includes('Fin de phrase détectée'));
  await connection.close();
});

test('un LLM muet ne bloque pas la session : délai, message clair, retour à l’écoute', async () => {
  const ai = fakeLocalAI();
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.endsWith('/chat/completions')) return ai.fetch(input, init);
    // Ne répond jamais, sauf abandon.
    return new Promise<Response>((_, reject) =>
      init?.signal?.addEventListener('abort', () =>
        reject(new DOMException('abandon', 'AbortError')),
      ),
    );
  };
  const events: VoiceEvent[] = [];
  const logs: { message: string; details?: Record<string, unknown> }[] = [];
  const connection = await createLocalVoiceAdapter(settings, {
    fetch,
    firstChunkTimeoutMs: 100,
    log: (_level, message, details) => logs.push({ message, details }),
  }).connect({ instructions: '', tools: [], webSearch: false }, (event) => events.push(event));
  connection.audio(pcm(1000, false));
  connection.audio(pcm(600, true));
  connection.audio(pcm(400, false));
  await waitFor(() => events.some((event) => event.type === 'turn_completed'));
  const failure = logs.find((entry) => entry.message === 'Tour de conversation local en échec');
  assert.match(String(failure?.details?.error), /LLM sans réponse/);
  assert.ok(logs.some((entry) => entry.message === 'Appel au LLM'));
  await connection.close();
});

test('miroir : le cerveau local configuré suffit, sans clé OpenAI', async () => {
  const { mirrorBlocker } = await import('../shared/readiness.js');
  const base = {
    session: { phase: 'idle' },
    wakeWord: { enabled: false, ready: false },
    openaiBlocked: false,
    // S’arrête au motif suivant, « Activer la voix », sans exiger un état complet.
    browserAudioReady: false,
  } as never as Parameters<typeof mirrorBlocker>[0];
  const blocked = (setup: Record<string, boolean>) =>
    mirrorBlocker({ ...base, setup } as never, { fresh: true })?.id === 'openai-key';
  assert.equal(blocked({ openaiKey: false, voiceKey: true }), false);
  assert.equal(blocked({ openaiKey: true, voiceKey: false }), true);
  assert.equal(blocked({ openaiKey: false }), true);
});

test('des pics de bruit isolés n’empêchent pas la fin de phrase (micro sensible)', async () => {
  const ai = fakeLocalAI();
  const events: VoiceEvent[] = [];
  const connection = await createLocalVoiceAdapter(settings, { fetch: ai.fetch }).connect(
    { instructions: '', tools: [], webSearch: false },
    (event) => events.push(event),
  );
  // Silence ponctué d’un clic de 20 ms toutes les 200 ms, comme le micro du TP401 au repos.
  const spiky = (ms: number) => {
    const audio = pcm(ms, false);
    for (let at = 0; at < ms; at += 200) audio.set(pcm(20, true), at * 32);
    return audio;
  };
  connection.audio(spiky(1000));
  connection.audio(pcm(600, true));
  connection.audio(spiky(1000));
  await waitFor(() => events.some((event) => event.type === 'user_transcript'));
  await connection.close();
});

test('un bruit pendant que le LLM réfléchit n’annule pas la réponse', async () => {
  const ai = fakeLocalAI();
  // Le LLM met 400 ms à répondre, le temps pour la pièce de faire du bruit.
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith('/chat/completions')) await new Promise((resolve) => setTimeout(resolve, 400));
    return ai.fetch(input, init);
  };
  const events: VoiceEvent[] = [];
  const connection = await createLocalVoiceAdapter(settings, { fetch }).connect(
    { instructions: '', tools: [], webSearch: false },
    (event) => events.push(event),
  );
  connection.audio(pcm(1000, false));
  connection.audio(pcm(600, true));
  connection.audio(pcm(400, false));
  await waitFor(() => events.some((event) => event.type === 'state' && event.state === 'thinking'));
  connection.audio(pcm(500, true));
  // Le faux LocalAI demande d’abord l’outil de l’heure.
  await waitFor(() => events.some((event) => event.type === 'tool_call'));
  const call = events.find((event) => event.type === 'tool_call');
  connection.result(call?.type === 'tool_call' ? call.id : '', '{"heure":"10:00"}');
  await waitFor(() => events.some((event) => event.type === 'assistant_transcript'));
  assert.equal(
    events.some((event) => event.type === 'interrupted'),
    false,
  );
  await connection.close();
});

test('des pics de bruit seuls ne partent pas à la transcription', async () => {
  const ai = fakeLocalAI();
  const logs: string[] = [];
  const connection = await createLocalVoiceAdapter(settings, {
    fetch: ai.fetch,
    log: (_level, message) => logs.push(message),
  }).connect({ instructions: '', tools: [], webSearch: false }, () => {});
  connection.audio(pcm(1000, false));
  // Dix clics de 40 ms : 400 ms au-dessus du seuil, mais jamais 60 ms d’affilée.
  for (let i = 0; i < 10; i++) {
    connection.audio(pcm(40, true));
    connection.audio(pcm(60, false));
  }
  connection.audio(pcm(1000, false));
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok(logs.includes('Fin de phrase détectée'));
  assert.equal(
    ai.calls.some((call) => call.url.endsWith('/audio/transcriptions')),
    false,
  );
  await connection.close();
});
