import assert from 'node:assert/strict';
import test from 'node:test';
import type { AddonDefinition } from '../shared/addons.js';
import { AddonRepository, AddonRuntime, openDatabase } from '../server/addons/testing.js';
import { liveConfiguration } from '../server/live/configuration.js';
import { localOnlyRefusal, restrictLocalOnlyTools } from '../server/local-ai-modules.js';
import { localInstructions } from '../server/voice/local.js';

/** Module minimal : seul son identifiant et son outil comptent ici. */
const module = (id: string): AddonDefinition => ({
  id,
  apiVersion: 1,
  version: '1.0.0',
  sourceLabel: id,
  configVersion: 1,
  configSchema: { type: 'object' },
  configDefaults: {},
  dataVersion: 1,
  dataSchema: { type: 'object' },
  freshMs: 60_000,
  tools: [
    {
      name: 'read',
      description: 'Lire.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['instanceRef'],
        properties: { instanceRef: { type: ['string', 'null'] } },
      },
    },
  ],
  async collect() {
    return { data: {} };
  },
  present() {
    return {
      title: 'T',
      primaryValue: null,
      subtitle: null,
      description: null,
      items: [],
      summary: 'S',
    };
  },
});

test('les outils réservés au cerveau local suivent le fournisseur choisi', (t) => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const runtime = new AddonRuntime({
    addons: [module('searxng'), module('meteo')],
    instances: new AddonRepository(db),
    http: { fetch: async () => ({ status: 500, headers: {}, text: () => '', json: () => null }) },
  });
  let local = false;
  restrictLocalOnlyTools(runtime, () => local);
  assert.deepEqual(
    runtime.tools().map((tool) => tool.name),
    ['meteo__read'],
  );
  local = true;
  assert.deepEqual(
    runtime.tools().map((tool) => tool.name),
    ['searxng__read', 'meteo__read'],
  );
});

test('activer un module réservé est refusé hors du cerveau local', () => {
  assert.match(localOnlyRefusal('searxng', false) ?? '', /cerveau local/u);
  assert.equal(localOnlyRefusal('searxng', true), null);
  assert.equal(localOnlyRefusal('weather', false), null);
});

test('les consignes locales désignent SearXNG à la place de web_search', () => {
  const searxng = {
    name: 'searxng__ask',
    description: 'Chercher sur le web.',
    parameters: { type: 'object' },
  };
  const withSearch = liveConfiguration([searxng]).instructions ?? '';
  assert.match(withSearch, /web_search/u);
  const adapted = localInstructions(withSearch, [searxng]);
  assert.doesNotMatch(adapted, /web_search/u);
  assert.match(adapted, /sur le web avec searxng__ask/u);
  const without = localInstructions(liveConfiguration([]).instructions ?? '', []);
  assert.doesNotMatch(without, /web_search/u);
});
