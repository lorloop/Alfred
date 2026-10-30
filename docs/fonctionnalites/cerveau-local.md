# Le cerveau local (fork Alfred)

Ce fork ajoute un troisième fournisseur de conversation, **« Local · LocalAI »**, qui remplace OpenAI et Mistral par vos propres serveurs compatibles OpenAI : [LocalAI](https://localai.io), [Speaches](https://speaches.ai), ou tout autre serveur qui expose `/v1/chat/completions`, `/v1/audio/transcriptions` et `/v1/audio/speech`. Aucune clé en ligne n'est nécessaire.

## Comment ça marche

Comme avec Mistral, le son du micro passe par le serveur Cornelius (PCM 16 kHz). Pour chaque phrase :

1. **Écoute.** Cornelius détecte la parole au niveau sonore et considère la phrase finie après un silence réglable (700 ms par défaut).
2. **Transcription.** La phrase part en WAV vers le service d'écoute (Whisper…).
3. **Réponse.** Le LLM (Qwen3.6…) reçoit la conversation et les mêmes outils que GPT-Live : modules, Home Assistant, agents Hermes, cartes, mémoire, e-mail. Les outils restent exécutés par Cornelius, avec les mêmes autorisations. Le mode « réflexion » de Qwen3 est désactivé pour répondre vite.
4. **Voix.** Chaque phrase de la réponse est synthétisée dès qu'elle est complète : la suivante se calcule pendant que la première est jouée.

Après la conversation, les souvenirs sont extraits par le service « Mémoire » (le LLM par défaut).

## Régler

1. **Voix de Cornelius → Fournisseur de la conversation : « Local · LocalAI ».** Le choix est refusé tant que le LLM, l'écoute et la voix n'ont pas d'adresse et de modèle.
2. **Carte « Cerveau local »** : une adresse et un modèle par service. **Tester** essaie chaque service avec les valeurs saisies, sans les enregistrer ; **Enregistrer** compte à la conversation suivante.

Les valeurs de départ peuvent venir de `.env` (`LOCALAI_*`, voir `.env.example`).

### Écoute et voix : GPU ou CPU

Chaque service a sa propre adresse, on peut donc mélanger :

| Emplacement | Adresse | Remarques |
|---|---|---|
| Machine IA (GPU) | `http://machine-ia:8080` | Charger Whisper (`whisper-large-v3-turbo`) et une voix française dans LocalAI ; prévoir la mémoire vidéo. |
| Cette machine (CPU) | `http://127.0.0.1:8000` | Un LocalAI CPU ou Speaches local, avec Whisper turbo int8 et Piper `fr_FR-siwis-medium` : ~1 s de plus par tour. |

## Limites

- **L'écho.** Comme avec Mistral, le son joué n'est pas retiré par l'annulation d'écho du navigateur. Pour couper Cornelius, il faut parler au moins 0,4 s ; avec un haut-parleur bruyant, désactivez « Couper Cornelius en lui parlant » ou utilisez un micro avec annulation d'écho.
- **Recherche web.** Non disponible avec ce fournisseur.
- **Qualité des outils.** Elle dépend du modèle : il doit savoir appeler des fonctions (Qwen3 le fait). Vérifiez avec « Cornelius, quelle heure est-il ? ».
- **Whisper et le silence.** Les phrases inventées typiques (« Sous-titres réalisés par… ») sont ignorées.

## Fichiers du fork

Le fork modifie peu de fichiers de Cornelius pour rester facile à mettre à jour. Le code propre au cerveau local est dans `server/voice/local*.ts`, `server/local-ai-*.ts`, `shared/local-ai.ts`, `web/components/admin/LocalAISettings.tsx` et `tests/local-voice.test.ts`. Le choix « local » est gardé dans sa propre table SQLite (`local_ai_settings`), créée à la demande et non par une migration, pour ne pas décaler celles de Cornelius.
