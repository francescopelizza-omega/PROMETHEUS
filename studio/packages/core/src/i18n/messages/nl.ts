/**
 * i18n/messages/nl.ts — Nederlands.
 *
 * Vertaald, niet nagebouwd: waar de Engelse zinsbouw in het Nederlands houterig zou klinken, is
 * de zin herschreven. Dat speelt vooral bij plaatsaanduidingen — de bijzin staat in het
 * Nederlands vaak elders dan in het Engels, en daarvoor bestaan benoemde plaatshouders.
 *
 * Twee regels bij het bewerken:
 *   - plaatshouders {naam} worden niet vertaald en mogen vrij worden HERSCHIKT;
 *   - in te typen commando's (brew install ollama, ollama pull …) blijven Engels:
 *     vertaald werken ze niet meer.
 *
 * Aanspreekvorm: "je". Een terminalprogramma, geen officiële brief.
 */

import type { MessageCatalog } from "../catalog.js";

export const nl: MessageCatalog = {
  "firstrun.language.title": "Kies je taal",
  "firstrun.language.intro":
    "PROMETHEUS spreekt meerdere talen. Deze vraag staat in het Engels omdat hij vóór je keuze komt; alles daarna volgt je antwoord.",
  "firstrun.language.prompt": "Kies een nummer, of druk op Enter voor Engels:",
  "firstrun.language.detected":
    "Je systeem suggereert {language} — druk op Enter om te bevestigen.",
  "firstrun.language.confirmed":
    "Taal ingesteld op {language}. Je kunt dit altijd wijzigen met /language.",
  "firstrun.language.partial":
    "{language} is voor {percent}% vertaald; wat ontbreekt verschijnt in het Engels.",

  "firstrun.welcome.title": "Welkom bij PROMETHEUS",
  "firstrun.welcome.body":
    "PROMETHEUS draait AI-modellen op je eigen computer en laat ze werken met je bestanden, commando's uitvoeren die jij goedkeurt en op het web zoeken. Er verlaat niets deze computer, tenzij je zelf een clouddienst koppelt.",
  "firstrun.welcome.next":
    "Laten we kijken wat er al geïnstalleerd is. Dat duurt een paar seconden en verandert niets.",
  "firstrun.newhere":
    "Voor het eerst hier? Typ /guide voor een rondleiding, of /doctor wanneer je wilt om te zien wat ontbreekt.",

  "doctor.title": "Installatiecontrole",
  "doctor.checking": "Bezig met controleren wat er geïnstalleerd is…",
  "doctor.ready.title": "Alles is klaar",
  "doctor.ready.body":
    "Alles wat PROMETHEUS nodig heeft is geïnstalleerd. Stel een vraag om te beginnen.",
  "doctor.blocked.title": "PROMETHEUS kan nog geen model draaien",
  "doctor.blocked.body":
    "Er ontbreekt {count} noodzakelijk onderdeel. De commando's hieronder installeren het; je kunt ze één voor één kopiëren.",
  "doctor.blocked.body.plural":
    "Er ontbreken {count} noodzakelijke onderdelen. De commando's hieronder installeren ze; je kunt ze één voor één kopiëren.",
  "doctor.optional.title": "Optionele extra's",
  "doctor.optional.body":
    "Deze zijn niet verplicht. Elk onderdeel schakelt iets specifieks in, dat ernaast staat.",
  "doctor.recheck": "Voer /doctor opnieuw uit na het installeren om het te bevestigen.",

  "doctor.status.installed": "geïnstalleerd",
  "doctor.status.missing": "ontbreekt",
  "doctor.status.required": "vereist",
  "doctor.status.optional": "optioneel",
  "doctor.status.running": "actief",
  "doctor.status.stopped": "geïnstalleerd maar niet actief",
  "doctor.label.why": "Waarom",
  "doctor.label.install": "Installeren",
  "doctor.label.then": "Daarna",
  "doctor.label.unlocks": "Schakelt in",
  "doctor.label.docs": "Meer",

  "need.ollama.what": "Ollama — draait AI-modellen op je computer",
  "need.ollama.why":
    "PROMETHEUS bevat zelf geen AI-model. Ollama is het programma dat er een laadt en vragen beantwoordt, lokaal en offline. Zonder Ollama is er niemand om mee te praten.",
  "need.ollama.after":
    "Start het na het installeren en haal een model op — /doctor stelt er een voor dat in je geheugen past.",
  "need.model.what": "Een AI-model",
  "need.model.why":
    "Ollama is geïnstalleerd maar heeft nog geen model. Het model is het bestand dat denkt; de omvang loopt van ongeveer 2 GB tot ruim 40 GB.",
  "need.model.suggest": "Met {memory} vrij geheugen is {model} een goede eerste keuze ({size}).",
  "need.model.none":
    "Geen enkel model uit de catalogus past in het geheugen dat nu vrij is. Andere programma's sluiten, of een kleiner model kiezen, helpt.",
  "need.ripgrep.what": "ripgrep — snel zoeken in bestanden",
  "need.ripgrep.why":
    "PROMETHEUS gebruikt ripgrep om in je bestanden te zoeken. Zonder ripgrep faalt het zoekgereedschap en verliest het model het vermogen om zelf code te vinden.",
  "need.git.what": "git — versiebeheer",
  "need.git.why":
    "Nodig om repositories te klonen en om het model te laten zien wat er in je project veranderd is. De meeste systemen hebben het al.",
  "need.node.what": "Node.js 22 of nieuwer",
  "need.node.why":
    "PROMETHEUS draait zelf op Node. Versie 22 is het minimum omdat het TypeScript-bronbestanden rechtstreeks leest; oudere versies stoppen voordat er iets start.",

  "runner.notinstalled":
    "Ollama is niet op deze computer geïnstalleerd, dus er is geen lokaal model dat kan antwoorden.",
  "runner.notrunning":
    "Ollama is geïnstalleerd maar draait nu niet. PROMETHEUS kan het starten, of je doet het zelf met: ollama serve",
  "runner.starting": "Ollama wordt gestart…",
  "runner.nomodels":
    "Ollama draait maar er zijn geen modellen opgehaald. Haal er een op met: ollama pull {model}",
  "runner.unreachable":
    "Geen antwoord van de modelserver op {url}. Staat die op een andere machine, controleer dan of die aanstaat en of /remote hem toont.",

  "cloud.alternative.title": "Of gebruik een clouddienst",
  "cloud.alternative.body":
    "Wil je liever geen model downloaden, dan kan PROMETHEUS een betaalde API gebruiken. Zet de sleutel van de aanbieder als omgevingsvariabele, dan verschijnt hij in /model. Je vragen verlaten dan wel deze computer — dat is de afweging.",

  "guide.title": "Aan de slag",
  "guide.step": "Stap {n} van {total}",
  "guide.step1.title": "Installeer een modelrunner",
  "guide.step1.body":
    "Dat is het programma dat de AI daadwerkelijk draait. /doctor toont het exacte commando voor jouw systeem.",
  "guide.step2.title": "Haal een model op",
  "guide.step2.body":
    "Modellen verschillen in omvang en kunnen. Een groter model kan meer en vraagt meer geheugen; /ram laat zien welke op jouw machine passen.",
  "guide.step3.title": "Stel een vraag",
  "guide.step3.body":
    "Schrijf in gewone taal. Om met bestanden te werken, open je eerst een map met /cd en beschrijf je daarna wat er moet veranderen.",
  "guide.step4.title": "Acties goedkeuren",
  "guide.step4.body":
    "Voordat het model een bestand schrijft, een commando uitvoert of het netwerk op gaat, vraagt PROMETHEUS het je. Met /auth stel je in hoe vaak er gevraagd wordt: begin voorzichtig en versoepel het zodra je vertrouwt wat je ziet.",
  "guide.step5.title": "Waar je daarna kijkt",
  "guide.step5.body":
    "/help toont alle commando's. /doctor controleert je installatie opnieuw. /language wijzigt de taal. /ram laat zien welke modellen passen.",
  "guide.done": "Dat was de rondleiding. Stel gerust een vraag wanneer je zover bent.",

  "common.notinstalled": "niet geïnstalleerd",
  "common.copycommand": "Kopieer dit commando naar je terminal:",
  "common.needsadmin": "Hiervoor zijn beheerdersrechten nodig; er wordt om je wachtwoord gevraagd.",
  "common.nointernet":
    "Deze stap downloadt van internet. Offline mislukt hij totdat je weer verbinding hebt.",
  "common.safe":
    "PROMETHEUS voert nooit een installatie voor je uit zonder eerst het commando te tonen en het te vragen.",
  "common.gated":
    "Alles wat PROMETHEUS downloadt wordt gescand voordat het mag draaien. Mislukt de scan, dan wordt de installatie geblokkeerd.",
  "common.cancelled": "Geannuleerd. Er is niets gewijzigd.",
  "common.unknownos":
    "PROMETHEUS herkent dit besturingssysteem niet en kan daarom geen installatiecommando voorstellen. Op de projectpagina staat er een.",

  "language.current": "Taal: {language} ({source}).",
  "language.source.setting": "jouw keuze",
  "language.source.environment": "uit je systeeminstellingen",
  "language.source.fallback": "standaard",
  "language.available": "Beschikbare talen:",
  "language.usage": "Gebruik: /language <code>, of /language om uit een lijst te kiezen.",
  "language.unknown": "{code} hoort niet bij de beschikbare talen.",
  "language.help": "Toont of wijzigt de taal van PROMETHEUS.",

  /* ── the help menu framing (the command NAMES stay English) ─────────────── */
  "help.title": "Prometheus-sessie — hulp",
  "help.intro":
    "Typ een bericht om te chatten · een commando dat met / begint voert een actie uit · een los werkwoord (scan) voert het uit.",
  "help.total": "{count} commando's in totaal — /commands toont ze allemaal.",
  "commands.title": "Commando's",
  "commands.hint": "{count} commando's — typ / gevolgd door een naam",
};
