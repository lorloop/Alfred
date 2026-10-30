# Le cerveau local (fork Alfred)

Ce fork ajoute un troisième fournisseur de conversation, **« Local · LocalAI »**, qui remplace OpenAI et Mistral par vos propres serveurs compatibles OpenAI : [LocalAI](https://localai.io), [Speaches](https://speaches.ai), ou tout autre serveur qui expose `/v1/chat/completions`, `/v1/audio/transcriptions` et `/v1/audio/speech`. Aucune clé en ligne n'est nécessaire.

## Comment ça marche

Comme avec Mistral, le son du micro passe par le serveur Cornelius (PCM 16 kHz). Pour chaque phrase :

1. **Écoute.** Cornelius détecte la parole au niveau sonore et considère la phrase finie après un silence réglable (700 ms par défaut).
2. **Transcription.** La phrase part en WAV vers le service d'écoute (Whisper…).
3. **Réponse.** Le LLM (Qwen3.6…) reçoit la conversation et les mêmes outils que GPT-Live : modules, Home Assistant, agents Hermes, cartes, mémoire, e-mail. Les outils restent exécutés par Cornelius, avec les mêmes autorisations. Par défaut, la réflexion du modèle est coupée pour répondre vite (voir « Réflexion du LLM » plus bas).
4. **Voix.** Chaque phrase de la réponse est synthétisée dès qu'elle est complète : la suivante se calcule pendant que la première est jouée.

Après la conversation, les souvenirs sont extraits par le service « Mémoire » (le LLM par défaut).

## Régler

1. **Voix de Cornelius → Fournisseur de la conversation : « Local · LocalAI ».** Le choix est refusé tant que le LLM, l'écoute et la voix n'ont pas d'adresse et de modèle.
2. **Carte « Cerveau local »** : une adresse et un modèle par service. **Tester** essaie chaque service avec les valeurs saisies, sans les enregistrer ; **Enregistrer** compte à la conversation suivante.

### Réflexion du LLM

Le réglage **Réflexion du LLM** de la carte « Cerveau local » choisit l’effort demandé au modèle (`reasoning_effort`) :

| Choix | Effet |
|---|---|
| Désactivée (par défaut) | Réponse en 1 à 3 s. Le modèle peut répondre de mémoire au lieu d’appeler un outil, ou dire à tort qu’il ne peut pas vérifier (« l’état de la lumière »). |
| Légère, Moyenne, Approfondie | Le modèle réfléchit avant de répondre : il choisit mieux ses outils et se trompe moins en calcul, mais répond plusieurs secondes plus tard. Selon le modèle, les trois niveaux peuvent se valoir (Qwen3 réfléchit ou non). |

Pour garder une conversation fluide, la réflexion ne sert qu’à la première étape d’une réponse, celle où le modèle choisit ses outils : une fois leurs résultats reçus, il les reformule sans réfléchir. Si la réflexion dure plus d’une seconde sans rien à dire, Cornelius prononce une courte phrase (« Voyons voir. ») qui tient lieu de phrase d’attente avant l’outil ; elle se coupe avec « Phrases d’attente ».

L’accueil et l’extraction des souvenirs restent toujours sans réflexion. Si une réponse dépasse 40 s, le journal l’indique : baissez alors la réflexion.

Les valeurs de départ peuvent venir de `.env` (`LOCALAI_*`, voir `.env.example`).

### Écoute et voix : GPU ou CPU

Chaque service a sa propre adresse, on peut donc mélanger :

| Emplacement | Adresse | Remarques |
|---|---|---|
| Machine IA (GPU) | `http://machine-ia:8080` | Charger Whisper (`whisper-large-v3-turbo`) et une voix française dans LocalAI ; prévoir la mémoire vidéo. |
| Cette machine (CPU) | `http://127.0.0.1:8000` | Un LocalAI CPU ou Speaches local, avec Whisper turbo int8 et Piper `fr_FR-siwis-medium` : ~1 s de plus par tour. |

## Limites

- **L'interruption et l'écho.** Comme avec Mistral, le son joué n'est pas retiré par l'annulation d'écho du navigateur. Avec « Couper Cornelius en lui parlant », une parole d'au moins 0,4 s pendant qu'il parle (seulement quand sa voix joue : pas pendant qu'il réfléchit ou qu'un outil travaille ; même faible ou hachée : l'annulation d'écho du navigateur atténue aussi votre voix) est vérifiée avant de le couper : il continue de parler pendant que le début de la phrase (1,2 s) part au service d'écoute. Une hésitation (« euh… », « hmm »), un acquiescement (« oui », « d'accord », « je vois »), un bruit ou l'écho de ce qu'il vient de dire ne le coupent pas ; sinon il se tait et la phrase devient la question suivante. Il se coupe donc environ une seconde et demie après le début de la parole. Le journal indique chaque verdict (« Interruption vérifiée », avec sa raison) ; « Niveau du micro » donne, pendant une réponse, la parole entendue (`interruptionMs`, 400 pour déclencher). Avec un haut-parleur très bruyant, un micro avec annulation d'écho reste préférable.
- **Recherche web.** La recherche intégrée d’OpenAI et de Mistral n’existe pas ici. Installez le module externe **Recherche web** (`searxng`, dans [cornelius-modules](https://github.com/lorloop/cornelius-modules/tree/searxng/searxng)) relié à votre instance SearXNG. Ce module ne s’active qu’avec « Local · LocalAI » ; avec un autre fournisseur, son outil est retiré de la conversation, même si une source reste activée.
- **Qualité des outils.** Elle dépend du modèle : il doit savoir appeler des fonctions (Qwen3 le fait). Vérifiez avec « Cornelius, quelle heure est-il ? ».
- **Whisper et le silence.** Les phrases inventées typiques (« Sous-titres réalisés par… ») sont ignorées.

## Fichiers du fork

Le fork modifie peu de fichiers de Cornelius pour rester facile à mettre à jour. Le code propre au cerveau local est dans `server/voice/local*.ts`, `server/local-ai-*.ts` (dont `local-ai-modules.ts`, la liste des modules réservés au local), `shared/local-ai.ts`, `web/components/admin/LocalAISettings.tsx`, `tests/local-voice.test.ts` et `tests/local-ai-modules.test.ts`. Hors de ces fichiers, le fork touche `server/app.ts` et `server/addons-api.ts` (refus d’activer un module réservé). Le choix « local » est gardé dans sa propre table SQLite (`local_ai_settings`), créée à la demande et non par une migration, pour ne pas décaler celles de Cornelius.
