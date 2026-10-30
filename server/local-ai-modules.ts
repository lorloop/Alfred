/**
 * Modules réservés au cerveau local (fork Alfred). Leur service double la recherche web
 * intégrée d'OpenAI et de Mistral : ils ne s'activent qu'avec « Local · LocalAI », et leurs
 * outils sont retirés de la conversation avec un autre fournisseur.
 */
import type { AddonRuntime } from './addons/runtime.js';

export const LOCAL_ONLY_ADDONS: ReadonlySet<string> = new Set(['searxng']);

export const LOCAL_ONLY_REFUSAL =
  'Ce module ne s’active qu’avec le cerveau local : choisissez d’abord « Local · LocalAI » dans Voix de Cornelius.';

/** Message de refus quand on active un module réservé hors du cerveau local, sinon null. */
export function localOnlyRefusal(addonId: string, local: boolean): string | null {
  return !local && LOCAL_ONLY_ADDONS.has(addonId) ? LOCAL_ONLY_REFUSAL : null;
}

/** Retire les outils des modules réservés tant que le cerveau local n'est pas choisi. */
export function restrictLocalOnlyTools(runtime: AddonRuntime, local: () => boolean): void {
  const tools = runtime.tools.bind(runtime);
  runtime.tools = (profileId = null) =>
    local()
      ? tools(profileId)
      : tools(profileId).filter(
          (tool) => !LOCAL_ONLY_ADDONS.has(runtime.parseTool(tool.name)?.addonId ?? ''),
        );
}
