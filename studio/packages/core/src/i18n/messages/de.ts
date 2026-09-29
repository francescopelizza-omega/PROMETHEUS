/**
 * i18n/messages/de.ts — Deutsch.
 *
 * Übersetzt, nicht nachgebaut: wo die englische Satzstellung im Deutschen gestelzt klänge, ist
 * der Satz neu formuliert. Das betrifft besonders Platzhalter — im Deutschen steht die
 * Präpositionalphrase oft an anderer Stelle als im Englischen, und genau dafür sind benannte
 * Platzhalter da.
 *
 * Zwei Regeln beim Bearbeiten:
 *   - Platzhalter {name} werden nicht übersetzt und dürfen frei UMGESTELLT werden;
 *   - einzugebende Befehle (brew install ollama, ollama pull …) bleiben englisch:
 *     übersetzt wären sie unbrauchbar.
 *
 * Anrede: „du". Ein Terminalwerkzeug, kein Behördenschreiben.
 */

import type { MessageCatalog } from "../catalog.js";

export const de: MessageCatalog = {
  "firstrun.language.title": "Sprache wählen",
  "firstrun.language.intro":
    "PROMETHEUS spricht mehrere Sprachen. Diese Frage ist auf Englisch, weil sie vor deiner Wahl kommt; alles danach richtet sich nach deiner Antwort.",
  "firstrun.language.prompt": "Wähle eine Zahl oder drücke Enter für Englisch:",
  "firstrun.language.detected": "Dein System schlägt {language} vor — mit Enter bestätigen.",
  "firstrun.language.confirmed":
    "Sprache auf {language} gesetzt. Du kannst sie jederzeit mit /language ändern.",
  "firstrun.language.partial":
    "{language} ist zu {percent}% übersetzt; alles Übrige erscheint auf Englisch.",

  "firstrun.welcome.title": "Willkommen bei PROMETHEUS",
  "firstrun.welcome.body":
    "PROMETHEUS führt KI-Modelle auf deinem eigenen Rechner aus und lässt sie mit deinen Dateien arbeiten, von dir freigegebene Befehle ausführen und im Web suchen. Nichts verlässt diesen Rechner, solange du nicht selbst einen Cloud-Dienst verbindest.",
  "firstrun.welcome.next":
    "Sehen wir nach, was bereits installiert ist. Das dauert ein paar Sekunden und ändert nichts.",
  "firstrun.newhere":
    "Zum ersten Mal hier? Tippe /guide für eine Einführung, oder jederzeit /doctor, um zu sehen, was fehlt.",

  "doctor.title": "Installationsprüfung",
  "doctor.checking": "Prüfe, was installiert ist…",
  "doctor.ready.title": "Alles bereit",
  "doctor.ready.body":
    "Alles, was PROMETHEUS braucht, ist installiert. Stell eine Frage, um loszulegen.",
  "doctor.blocked.title": "PROMETHEUS kann noch kein Modell ausführen",
  "doctor.blocked.body":
    "Es fehlt {count} notwendiger Bestandteil. Die Befehle unten installieren ihn; du kannst sie einzeln kopieren.",
  "doctor.blocked.body.plural":
    "Es fehlen {count} notwendige Bestandteile. Die Befehle unten installieren sie; du kannst sie einzeln kopieren.",
  "doctor.optional.title": "Optionale Ergänzungen",
  "doctor.optional.body":
    "Diese sind nicht erforderlich. Jede schaltet etwas Bestimmtes frei — daneben steht was.",
  "doctor.recheck": "Führe /doctor nach der Installation erneut aus, um es zu bestätigen.",

  "doctor.status.installed": "installiert",
  "doctor.status.missing": "fehlt",
  "doctor.status.required": "erforderlich",
  "doctor.status.optional": "optional",
  "doctor.status.running": "läuft",
  "doctor.status.stopped": "installiert, läuft aber nicht",
  "doctor.label.why": "Warum",
  "doctor.label.install": "Installation",
  "doctor.label.then": "Danach",
  "doctor.label.unlocks": "Schaltet frei",
  "doctor.label.docs": "Mehr dazu",

  "need.ollama.what": "Ollama — führt KI-Modelle auf deinem Rechner aus",
  "need.ollama.why":
    "PROMETHEUS enthält selbst kein KI-Modell. Ollama ist das Programm, das eines lädt und Anfragen beantwortet — lokal und offline. Ohne Ollama gibt es niemanden, mit dem du sprechen könntest.",
  "need.ollama.after":
    "Nach der Installation starte es und lade ein Modell herunter — /doctor schlägt eines vor, das in deinen Speicher passt.",
  "need.model.what": "Ein KI-Modell",
  "need.model.why":
    "Ollama ist installiert, hat aber noch kein Modell. Das Modell ist die Datei, die denkt; die Größen reichen von etwa 2 GB bis über 40 GB.",
  "need.model.suggest": "Bei {memory} freiem Speicher ist {model} eine gute erste Wahl ({size}).",
  "need.model.none":
    "Kein Modell aus dem Katalog passt in den derzeit freien Speicher. Andere Programme zu schließen oder ein kleineres Modell zu wählen hilft.",
  "need.ripgrep.what": "ripgrep — schnelle Dateisuche",
  "need.ripgrep.why":
    "PROMETHEUS durchsucht deine Dateien mit ripgrep. Ohne es schlägt das Suchwerkzeug fehl, und das Modell verliert die Fähigkeit, Code selbst zu finden.",
  "need.git.what": "git — Versionsverwaltung",
  "need.git.why":
    "Nötig, um Repositories zu klonen und dem Modell zu zeigen, was sich im Projekt geändert hat. Auf den meisten Systemen bereits vorhanden.",
  "need.node.what": "Node.js 22 oder neuer",
  "need.node.why":
    "PROMETHEUS selbst läuft auf Node. Version 22 ist das Minimum, weil es TypeScript-Quellen direkt liest; ältere Versionen scheitern, bevor irgendetwas startet.",

  "runner.notinstalled":
    "Ollama ist auf diesem Rechner nicht installiert, also gibt es kein lokales Modell, das antworten könnte.",
  "runner.notrunning":
    "Ollama ist installiert, läuft aber gerade nicht. PROMETHEUS kann es starten, oder du startest es selbst mit: ollama serve",
  "runner.starting": "Ollama wird gestartet…",
  "runner.nomodels":
    "Ollama läuft, hat aber keine Modelle heruntergeladen. Lade eines mit: ollama pull {model}",
  "runner.unreachable":
    "Keine Antwort vom Modellserver unter {url}. Wenn er auf einem anderen Rechner läuft, prüfe, ob dieser eingeschaltet ist und ob /remote ihn auflistet.",

  "cloud.alternative.title": "Oder nimm einen Cloud-Anbieter",
  "cloud.alternative.body":
    "Wenn du kein Modell herunterladen möchtest, kann PROMETHEUS eine kostenpflichtige API nutzen. Setze den Schlüssel des Anbieters als Umgebungsvariable, dann erscheint er unter /model. Deine Anfragen verlassen damit diesen Rechner — das ist der Preis.",

  "guide.title": "Erste Schritte",
  "guide.step": "Schritt {n} von {total}",
  "guide.step1.title": "Installiere eine Modell-Laufzeit",
  "guide.step1.body":
    "Das ist das Programm, das die KI tatsächlich ausführt. /doctor zeigt den genauen Befehl für dein System.",
  "guide.step2.title": "Lade ein Modell herunter",
  "guide.step2.body":
    "Modelle unterscheiden sich in Größe und Können. Ein größeres kann mehr und braucht mehr Speicher; /ram zeigt, welche auf deinen Rechner passen.",
  "guide.step3.title": "Stell eine Frage",
  "guide.step3.body":
    "Schreib in normaler Sprache. Um mit Dateien zu arbeiten, öffne zuerst einen Ordner mit /cd und beschreibe dann, was geändert werden soll.",
  "guide.step4.title": "Aktionen freigeben",
  "guide.step4.body":
    "Bevor das Modell eine Datei schreibt, einen Befehl ausführt oder ins Netz geht, fragt PROMETHEUS dich. Mit /auth stellst du ein, wie oft gefragt wird: fang vorsichtig an und lockere es, wenn du dem Gesehenen traust.",
  "guide.step5.title": "Wie es weitergeht",
  "guide.step5.body":
    "/help listet alle Befehle. /doctor prüft die Installation erneut. /language wechselt die Sprache. /ram zeigt, welche Modelle passen.",
  "guide.done": "Das war die Tour. Frag einfach, wann immer du bereit bist.",

  "common.notinstalled": "nicht installiert",
  "common.copycommand": "Kopiere diesen Befehl in dein Terminal:",
  "common.needsadmin":
    "Dafür sind Administratorrechte nötig; du wirst nach deinem Passwort gefragt.",
  "common.nointernet":
    "Dieser Schritt lädt aus dem Internet. Offline schlägt er fehl, bis du wieder verbunden bist.",
  "common.safe":
    "PROMETHEUS führt nie eine Installation für dich aus, ohne dir vorher den Befehl zu zeigen und zu fragen.",
  "common.gated":
    "Alles, was PROMETHEUS herunterlädt, wird geprüft, bevor es ausgeführt werden darf. Schlägt die Prüfung fehl, wird die Installation blockiert.",
  "common.cancelled": "Abgebrochen. Es wurde nichts geändert.",
  "common.unknownos":
    "PROMETHEUS erkennt dieses Betriebssystem nicht und kann daher keinen Installationsbefehl vorschlagen. Auf der Projektseite steht einer.",

  "language.current": "Sprache: {language} ({source}).",
  "language.source.setting": "deine Wahl",
  "language.source.environment": "aus deinen Systemeinstellungen",
  "language.source.fallback": "Standard",
  "language.available": "Verfügbare Sprachen:",
  "language.usage": "Verwendung: /language <Kürzel>, oder /language für eine Auswahlliste.",
  "language.unknown": "{code} gehört nicht zu den verfügbaren Sprachen.",
  "language.help": "Zeigt oder ändert die Sprache von PROMETHEUS.",

  /* ── the help menu framing (the command NAMES stay English) ─────────────── */
  "help.title": "Prometheus-Sitzung — Hilfe",
  "help.intro":
    "Schreibe eine Nachricht zum Chatten · ein Befehl, der mit / beginnt, führt eine Aktion aus · ein einzelnes Verb (scan) führt es aus.",
  "help.total": "{count} Befehle insgesamt — /commands zeigt alle.",
  "commands.title": "Befehle",
  "commands.hint": "{count} Befehle — tippe / gefolgt von einem Namen",
};
