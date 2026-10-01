// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * i18n/messages/fr.ts — Français.
 *
 * Traduit, non calqué : là où l'anglais emploie une tournure qui sonnerait artificielle en
 * français, la phrase est réécrite pour dire la même chose naturellement.
 *
 * Deux règles à respecter en modifiant ce fichier :
 *   - les marqueurs {nom} ne se traduisent pas et peuvent être RÉORDONNÉS librement ;
 *   - les commandes à saisir (brew install ollama, ollama pull …) restent en anglais :
 *     les traduire les rendrait inutilisables.
 *
 * Registre : tutoiement. C'est un outil en ligne de commande, pas un courrier officiel.
 */

import type { MessageCatalog } from "../catalog.js";

export const fr: MessageCatalog = {
  "firstrun.language.title": "Choisis ta langue",
  "firstrun.language.intro":
    "PROMETHEUS parle plusieurs langues. Cette question est en anglais parce qu'elle est posée avant ton choix ; tout ce qui suit s'adapte à ta réponse.",
  "firstrun.language.prompt": "Choisis un numéro, ou appuie sur Entrée pour l'anglais :",
  "firstrun.language.detected": "Ton système suggère {language} — appuie sur Entrée pour accepter.",
  "firstrun.language.confirmed":
    "Langue réglée sur {language}. Tu peux en changer à tout moment avec /language.",
  "firstrun.language.partial":
    "{language} est traduit à {percent}% ; ce qui manque s'affiche en anglais.",

  "firstrun.welcome.title": "Bienvenue dans PROMETHEUS",
  "firstrun.welcome.body":
    "PROMETHEUS exécute des modèles d'IA sur ta propre machine et leur permet de travailler sur tes fichiers, d'exécuter des commandes que tu approuves et de chercher sur le web. Rien ne quitte cet ordinateur, sauf si tu connectes toi-même un service en ligne.",
  "firstrun.welcome.next":
    "Vérifions ce qui est déjà installé. Cela prend quelques secondes et ne modifie rien.",
  "firstrun.newhere":
    "C'est ta première fois ? Tape /guide pour une visite guidée, ou /doctor à tout moment pour voir ce qui manque.",

  "doctor.title": "Vérification de l'installation",
  "doctor.checking": "Vérification de ce qui est installé…",
  "doctor.ready.title": "Tout est prêt",
  "doctor.ready.body":
    "Tout ce dont PROMETHEUS a besoin est installé. Pose une question pour commencer.",
  "doctor.blocked.title": "PROMETHEUS ne peut pas encore exécuter de modèle",
  "doctor.blocked.body":
    "Il manque {count} élément indispensable. Les commandes ci-dessous l'installent ; tu peux les copier une par une.",
  "doctor.blocked.body.plural":
    "Il manque {count} éléments indispensables. Les commandes ci-dessous les installent ; tu peux les copier une par une.",
  "doctor.optional.title": "Compléments facultatifs",
  "doctor.optional.body":
    "Ils ne sont pas indispensables. Chacun débloque une fonction précise, indiquée à côté.",
  "doctor.recheck": "Relance /doctor après l'installation pour confirmer.",

  "doctor.status.installed": "installé",
  "doctor.status.missing": "manquant",
  "doctor.status.required": "indispensable",
  "doctor.status.optional": "facultatif",
  "doctor.status.running": "en cours d'exécution",
  "doctor.status.stopped": "installé mais arrêté",
  "doctor.label.why": "Pourquoi",
  "doctor.label.install": "Installation",
  "doctor.label.then": "Ensuite",
  "doctor.label.unlocks": "Débloque",
  "doctor.label.docs": "En savoir plus",

  "need.ollama.what": "Ollama — exécute les modèles d'IA sur ton ordinateur",
  "need.ollama.why":
    "PROMETHEUS ne contient pas de modèle d'IA. Ollama est le programme qui en charge un et répond aux requêtes, localement et hors ligne. Sans lui, il n'y a personne à qui parler.",
  "need.ollama.after":
    "Une fois installé, lance-le et télécharge un modèle — /doctor t'en proposera un adapté à ta mémoire.",
  "need.model.what": "Un modèle d'IA",
  "need.model.why":
    "Ollama est installé mais n'a encore aucun modèle. Le modèle est le fichier qui réfléchit ; leur taille va d'environ 2 Go à plus de 40 Go.",
  "need.model.suggest":
    "Avec {memory} de mémoire libre, {model} est un bon premier choix ({size}).",
  "need.model.none":
    "Aucun modèle du catalogue ne tient dans la mémoire actuellement libre. Fermer d'autres applications, ou choisir un modèle plus petit, devrait suffire.",
  "need.ripgrep.what": "ripgrep — recherche rapide dans les fichiers",
  "need.ripgrep.why":
    "PROMETHEUS utilise ripgrep pour chercher dans tes fichiers. Sans lui, l'outil de recherche échoue et le modèle perd la capacité de trouver du code par lui-même.",
  "need.git.what": "git — gestion de versions",
  "need.git.why":
    "Nécessaire pour cloner des dépôts et montrer au modèle ce qui a changé dans ton projet. La plupart des systèmes l'ont déjà.",
  "need.node.what": "Node.js 22 ou plus récent",
  "need.node.why":
    "PROMETHEUS lui-même fonctionne sur Node. La version 22 est le minimum car il lit directement les sources TypeScript ; avec une version antérieure, rien ne démarre.",

  "runner.notinstalled":
    "Ollama n'est pas installé sur cet ordinateur : aucun modèle local ne peut donc répondre.",
  "runner.notrunning":
    "Ollama est installé mais n'est pas en cours d'exécution. PROMETHEUS peut le lancer, ou tu peux le faire avec : ollama serve",
  "runner.starting": "Démarrage d'Ollama…",
  "runner.nomodels":
    "Ollama fonctionne mais aucun modèle n'est téléchargé. Télécharges-en un avec : ollama pull {model}",
  "runner.unreachable":
    "Aucune réponse du serveur de modèles sur {url}. S'il est sur une autre machine, vérifie qu'elle est allumée et que /remote la répertorie.",

  "cloud.alternative.title": "Ou bien utilise un service en ligne",
  "cloud.alternative.body":
    "Si tu préfères ne pas télécharger de modèle, PROMETHEUS peut utiliser une API payante. Définis la clé du fournisseur comme variable d'environnement et elle apparaîtra dans /model. Tes requêtes quittent alors cet ordinateur : c'est le compromis.",

  "guide.title": "Premiers pas",
  "guide.step": "Étape {n} sur {total}",
  "guide.step1.title": "Installe un moteur de modèles",
  "guide.step1.body":
    "C'est le programme qui exécute réellement l'IA. /doctor affiche la commande exacte pour ton système.",
  "guide.step2.title": "Télécharge un modèle",
  "guide.step2.body":
    "Les modèles diffèrent par la taille et les compétences. Un modèle plus grand est plus capable et demande plus de mémoire ; /ram montre lesquels tiennent sur ta machine.",
  "guide.step3.title": "Pose une question",
  "guide.step3.body":
    "Écris en langage courant. Pour travailler sur des fichiers, ouvre d'abord un dossier avec /cd, puis décris ce que tu veux modifier.",
  "guide.step4.title": "Approuver les actions",
  "guide.step4.body":
    "Avant que le modèle n'écrive un fichier, n'exécute une commande ou n'accède au réseau, PROMETHEUS te demande. /auth règle la fréquence des demandes : commence prudent, puis assouplis quand tu as confiance.",
  "guide.step5.title": "Où regarder ensuite",
  "guide.step5.body":
    "/help liste toutes les commandes. /doctor revérifie l'installation. /language change la langue. /ram montre quels modèles tiennent en mémoire.",
  "guide.done": "La visite est terminée. Pose une question quand tu veux.",

  "common.notinstalled": "non installé",
  "common.copycommand": "Copie cette commande et colle-la dans ton terminal :",
  "common.needsadmin": "Cela requiert les droits administrateur et demandera ton mot de passe.",
  "common.nointernet":
    "Cette étape télécharge depuis internet. Hors ligne, elle échouera jusqu'à la reconnexion.",
  "common.safe":
    "PROMETHEUS ne lance jamais une installation à ta place sans t'avoir montré la commande et te l'avoir demandée.",
  "common.gated":
    "Tout ce que PROMETHEUS télécharge est analysé avant de pouvoir s'exécuter. Si l'analyse échoue, l'installation est bloquée.",
  "common.cancelled": "Annulé. Rien n'a été modifié.",
  "common.unknownos":
    "PROMETHEUS ne reconnaît pas ce système d'exploitation et ne peut donc pas proposer de commande d'installation. Le site du projet en donnera une.",

  "language.current": "Langue : {language} ({source}).",
  "language.source.setting": "ton choix",
  "language.source.environment": "d'après ton système",
  "language.source.fallback": "par défaut",
  "language.available": "Langues disponibles :",
  "language.usage": "Utilisation : /language <code>, ou /language pour choisir dans une liste.",
  "language.unknown": "{code} ne fait pas partie des langues disponibles.",
  "language.help": "Affiche ou change la langue de PROMETHEUS.",

  /* ── the help menu framing (the command NAMES stay English) ─────────────── */
  "help.title": "Session Prometheus — aide",
  "help.intro":
    "Tapez un message pour discuter · une commande commençant par / exécute une action · un verbe seul (scan) l'exécute.",
  "help.total": "{count} commandes au total — /commands pour toutes les voir.",
  "commands.title": "Commandes",
  "commands.hint": "{count} commandes — tapez / suivi d'un nom",
};
