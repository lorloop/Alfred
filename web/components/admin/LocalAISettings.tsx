import { useCallback, useEffect, useState } from 'react';
import {
  LOCAL_AI_REASONING,
  LOCAL_AI_SILENCE_MAX_MS,
  LOCAL_AI_SILENCE_MIN_MS,
  localAIReasoningLabel,
  localAIServiceLabel,
  type LocalAIReasoning,
  type LocalAIServiceName,
  type LocalAISettings,
  type LocalAITestResult,
} from '../../../shared/local-ai';
import { api, errorMessage } from '../../api';
import { Alert, AlertDescription } from '../ui/alert';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { NativeSelect, NativeSelectOption } from '../ui/native-select';
import { Switch } from '../ui/switch';
import { Field, LoadingCard } from './shared';
import type { RunAction } from './types';
import { useAdminResource } from './useAdminResource';

const HELP: Record<LocalAIServiceName, string> = {
  llm: 'Le modèle qui répond et appelle les outils, par exemple Qwen3.6 sur la machine IA.',
  stt: 'Whisper ou équivalent. Sur la machine IA (GPU) ou un serveur CPU dans cette VM.',
  tts: 'Piper, Kokoro… Sur la machine IA (GPU) ou un serveur CPU dans cette VM.',
  memory: 'Extraction des souvenirs après la conversation. Laissé vide : adresse et modèle du LLM.',
};

function ServiceFields({
  name,
  draft,
  change,
}: {
  name: LocalAIServiceName;
  draft: LocalAISettings;
  change: (next: LocalAISettings) => void;
}) {
  const service = draft[name];
  const set = (patch: Record<string, string>) =>
    change({ ...draft, [name]: { ...service, ...patch } });
  const optional = name === 'memory';
  return (
    <fieldset className="space-y-3 rounded-md border p-3">
      <legend className="px-1 text-sm font-medium">{localAIServiceLabel(name)}</legend>
      <p className="text-sm text-muted-foreground">{HELP[name]}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field id={`local-ai-${name}-url`} label="Adresse">
          <Input
            id={`local-ai-${name}-url`}
            value={service.baseUrl}
            placeholder={optional ? draft.llm.baseUrl : 'http://machine-ia:8080'}
            onChange={(event) => set({ baseUrl: event.target.value })}
          />
        </Field>
        <Field id={`local-ai-${name}-model`} label="Modèle">
          <Input
            id={`local-ai-${name}-model`}
            value={service.model}
            placeholder={optional ? draft.llm.model : undefined}
            onChange={(event) => set({ model: event.target.value })}
          />
        </Field>
        {name === 'stt' && (
          <Field id="local-ai-stt-language" label="Langue" help="Code ISO : fr, en…">
            <Input
              id="local-ai-stt-language"
              value={draft.stt.language}
              onChange={(event) => set({ language: event.target.value })}
            />
          </Field>
        )}
        {name === 'tts' && (
          <Field
            id="local-ai-tts-voice"
            label="Voix"
            help="Selon le serveur ; vide : voix du modèle."
          >
            <Input
              id="local-ai-tts-voice"
              value={draft.tts.voice}
              onChange={(event) => set({ voice: event.target.value })}
            />
          </Field>
        )}
      </div>
    </fieldset>
  );
}

/** Cerveau local : où écouter, réfléchir, parler et extraire les souvenirs, sans compte en ligne. */
export function LocalAISettings({ run }: { run: RunAction }) {
  const resource = useAdminResource(useCallback(() => api.localAI(), []));
  const [draft, setDraft] = useState<LocalAISettings | null>(null);
  const [results, setResults] = useState<LocalAITestResult[] | null>(null);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (resource.data) setDraft(resource.data.settings);
  }, [resource.data]);
  if (!draft) return <LoadingCard label="Lecture du cerveau local…" />;
  const changed = JSON.stringify(draft) !== JSON.stringify(resource.data?.settings);
  const test = async () => {
    setTesting(true);
    setError(null);
    setResults(null);
    try {
      setResults(await api.testLocalAI(draft));
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setTesting(false);
    }
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle>Cerveau local</CardTitle>
        <CardDescription>
          Serveurs compatibles OpenAI (LocalAI, Speaches…). Chaque service a sa propre adresse : la
          voix et l’écoute peuvent tourner sur la machine IA ou en CPU dans cette VM. Les
          changements comptent à la prochaine conversation.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {(['llm', 'stt', 'tts', 'memory'] as const).map((name) => (
          <ServiceFields key={name} name={name} draft={draft} change={setDraft} />
        ))}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            id="local-ai-silence"
            label="Fin de phrase après un silence de (ms)"
            help="Plus court : réponses plus rapides, mais risque de couper une hésitation."
          >
            <Input
              id="local-ai-silence"
              type="number"
              min={LOCAL_AI_SILENCE_MIN_MS}
              max={LOCAL_AI_SILENCE_MAX_MS}
              step={50}
              value={draft.silenceMs}
              onChange={(event) => setDraft({ ...draft, silenceMs: Number(event.target.value) })}
            />
          </Field>
          <Field
            id="local-ai-reasoning"
            label="Réflexion du LLM"
            help="Avec réflexion, le modèle choisit mieux ses outils et se trompe moins, mais répond plusieurs secondes plus tard. Selon le modèle, les niveaux peuvent se valoir."
          >
            <NativeSelect
              id="local-ai-reasoning"
              value={draft.reasoning}
              onChange={(event) =>
                setDraft({ ...draft, reasoning: event.target.value as LocalAIReasoning })
              }
            >
              {LOCAL_AI_REASONING.map((effort) => (
                <NativeSelectOption key={effort} value={effort}>
                  {localAIReasoningLabel(effort)}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </Field>
          <div className="flex items-center justify-between gap-4 rounded-md border p-3">
            <Label htmlFor="local-ai-barge-in">Couper Cornelius en lui parlant</Label>
            <Switch
              id="local-ai-barge-in"
              checked={draft.bargeIn}
              onCheckedChange={(bargeIn) => setDraft({ ...draft, bargeIn })}
            />
          </div>
          <div className="flex items-center justify-between gap-4 rounded-md border p-3">
            <Label htmlFor="local-ai-fillers">Phrases d’attente pendant les recherches</Label>
            <Switch
              id="local-ai-fillers"
              checked={draft.fillers}
              onCheckedChange={(fillers) => setDraft({ ...draft, fillers })}
            />
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            disabled={!changed}
            onClick={() =>
              void run('Cerveau local enregistré.', async () => {
                await api.saveLocalAI(draft);
                await resource.reload();
              })
            }
          >
            Enregistrer
          </Button>
          <Button variant="outline" disabled={testing} onClick={() => void test()}>
            {testing ? 'Essai en cours…' : 'Tester'}
          </Button>
          {changed && (
            <Button variant="ghost" onClick={() => setDraft(resource.data!.settings)}>
              Annuler
            </Button>
          )}
        </div>
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {results && (
          <ul className="space-y-2" aria-label="Résultat de l’essai">
            {results.map((result) => (
              <li key={result.service} className="flex flex-wrap items-center gap-2 text-sm">
                <Badge variant={result.ok ? 'secondary' : 'destructive'}>
                  {result.ok ? 'OK' : 'Échec'}
                </Badge>
                <span className="font-medium">{localAIServiceLabel(result.service)}</span>
                <span className="text-muted-foreground">
                  {result.detail} ({(result.ms / 1000).toFixed(1)} s)
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
