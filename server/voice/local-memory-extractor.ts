import schema from '../../schemas/memory-changes.schema.json' with { type: 'json' };
import type { LocalAISettings } from '../../shared/local-ai.js';
import { strictSchema } from '../live/configuration.js';
import type { MemoryExtractor } from '../memory.js';
import { memoryExtractionInstructions } from '../memory-extractor.js';
import { localClient, NO_THINKING, stripReasoning } from './local-client.js';

/** Réglages relus à chaque extraction : un changement dans l’administration compte tout de suite. */
export function createLocalMemoryExtractor(
  settings: () => LocalAISettings,
  apiKey?: string,
  fetch?: typeof globalThis.fetch,
): MemoryExtractor {
  return async (input, signal) => {
    const current = settings();
    const service = {
      baseUrl: current.memory.baseUrl || current.llm.baseUrl,
      model: current.memory.model || current.llm.model,
    };
    const client = localClient(service, apiKey, 55_000, fetch);
    const response = await client.chat.completions.create(
      {
        model: service.model,
        messages: [
          { role: 'system', content: memoryExtractionInstructions },
          { role: 'user', content: JSON.stringify(input) },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'memory_changes',
            strict: true,
            schema: strictSchema(schema) as Record<string, unknown>,
          },
        },
        max_tokens: 6000,
        temperature: 0,
        ...NO_THINKING,
      },
      { signal },
    );
    const choice = response.choices[0];
    const content = choice?.message?.content;
    if (choice?.finish_reason !== 'stop' || typeof content !== 'string')
      throw new Error('Extraction mémoire locale incomplète.');
    return JSON.parse(stripReasoning(content)) as unknown;
  };
}
