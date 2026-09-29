/**
 * i18n/messages/it.ts — Italiano.
 *
 * Tradotto, non ricalcato: dove l'inglese usa una costruzione che in italiano suonerebbe
 * artificiale, la frase è riscritta per dire la stessa cosa in modo naturale.
 *
 * Due regole da rispettare modificando questo file:
 *   - i segnaposto {nome} non si traducono e possono essere RIORDINATI liberamente;
 *   - i comandi da digitare (brew install ollama, ollama pull …) restano in inglese:
 *     tradurli li renderebbe inutilizzabili.
 *
 * Registro: "tu", non "Lei". È uno strumento da terminale, non una comunicazione formale.
 */

import type { MessageCatalog } from "../catalog.js";

export const it: MessageCatalog = {
  "firstrun.language.title": "Scegli la lingua",
  "firstrun.language.intro":
    "PROMETHEUS parla diverse lingue. Questa domanda è in inglese perché viene posta prima della tua scelta; da qui in poi si adegua alla risposta.",
  "firstrun.language.prompt": "Scegli un numero, oppure premi Invio per l'inglese:",
  "firstrun.language.detected": "Il sistema suggerisce {language} — premi Invio per accettare.",
  "firstrun.language.confirmed":
    "Lingua impostata su {language}. Puoi cambiarla quando vuoi con /language.",
  "firstrun.language.partial":
    "{language} è tradotto al {percent}%; ciò che manca viene mostrato in inglese.",

  "firstrun.welcome.title": "Benvenuto in PROMETHEUS",
  "firstrun.welcome.body":
    "PROMETHEUS esegue modelli di intelligenza artificiale sul tuo computer e permette loro di lavorare sui tuoi file, eseguire comandi che approvi e cercare sul web. Nulla esce da questo computer, a meno che non colleghi tu stesso un servizio cloud.",
  "firstrun.welcome.next":
    "Adesso controlliamo cosa è già installato. Richiede pochi secondi e non modifica nulla.",
  "firstrun.newhere":
    "È la prima volta? Scrivi /guide per una guida passo passo, oppure /doctor in qualsiasi momento per vedere cosa manca.",

  "doctor.title": "Verifica della configurazione",
  "doctor.checking": "Controllo di ciò che è installato…",
  "doctor.ready.title": "Tutto pronto",
  "doctor.ready.body":
    "Tutto ciò che serve a PROMETHEUS è installato. Scrivi una domanda per iniziare.",
  "doctor.blocked.title": "PROMETHEUS non può ancora eseguire un modello",
  "doctor.blocked.body":
    "Manca {count} elemento necessario. I comandi qui sotto lo installano; puoi copiarli uno alla volta.",
  "doctor.blocked.body.plural":
    "Mancano {count} elementi necessari. I comandi qui sotto li installano; puoi copiarli uno alla volta.",
  "doctor.optional.title": "Componenti facoltativi",
  "doctor.optional.body":
    "Non sono necessari. Ognuno abilita una funzione precisa, indicata accanto.",
  "doctor.recheck": "Esegui di nuovo /doctor dopo l'installazione per conferma.",

  "doctor.status.installed": "installato",
  "doctor.status.missing": "mancante",
  "doctor.status.required": "necessario",
  "doctor.status.optional": "facoltativo",
  "doctor.status.running": "in esecuzione",
  "doctor.status.stopped": "installato ma non in esecuzione",
  "doctor.label.why": "Perché",
  "doctor.label.install": "Installazione",
  "doctor.label.then": "Poi",
  "doctor.label.unlocks": "Abilita",
  "doctor.label.docs": "Altro",

  "need.ollama.what": "Ollama — esegue i modelli di IA sul tuo computer",
  "need.ollama.why":
    "PROMETHEUS non contiene un modello di IA. Ollama è il programma che ne carica uno e risponde alle richieste, in locale e senza connessione. Senza di lui non c'è nessuno con cui parlare.",
  "need.ollama.after":
    "Dopo l'installazione avvialo e scarica un modello — /doctor te ne suggerirà uno adatto alla tua memoria.",
  "need.model.what": "Un modello di IA",
  "need.model.why":
    "Ollama è installato ma non ha ancora nessun modello. Il modello è il file che ragiona: le dimensioni vanno da circa 2 GB a oltre 40 GB.",
  "need.model.suggest":
    "Con {memory} di memoria libera, {model} è una buona prima scelta ({size}).",
  "need.model.none":
    "Nessun modello del catalogo entra nella memoria attualmente libera. Chiudere altre applicazioni, o scegliere un modello più piccolo, può bastare.",
  "need.ripgrep.what": "ripgrep — ricerca veloce nei file",
  "need.ripgrep.why":
    "PROMETHEUS usa ripgrep per cercare nei tuoi file. Senza, lo strumento di ricerca non funziona e il modello perde la capacità di trovare il codice da solo.",
  "need.git.what": "git — controllo di versione",
  "need.git.why":
    "Serve per clonare i repository e per mostrare al modello che cosa è cambiato nel progetto. Sulla maggior parte dei sistemi è già presente.",
  "need.node.what": "Node.js 22 o successivo",
  "need.node.why":
    "PROMETHEUS stesso funziona su Node. La versione 22 è il minimo perché legge direttamente i sorgenti TypeScript; con versioni precedenti si ferma prima di partire.",

  "runner.notinstalled":
    "Ollama non è installato su questo computer, quindi non c'è nessun modello locale che possa rispondere.",
  "runner.notrunning":
    "Ollama è installato ma non è in esecuzione. PROMETHEUS può avviarlo, oppure puoi farlo tu con: ollama serve",
  "runner.starting": "Avvio di Ollama…",
  "runner.nomodels":
    "Ollama è in esecuzione ma non ha modelli scaricati. Scaricane uno con: ollama pull {model}",
  "runner.unreachable":
    "Nessuna risposta dal server dei modelli su {url}. Se si trova su un'altra macchina, verifica che sia accesa e che /remote la elenchi.",

  "cloud.alternative.title": "Oppure usa un servizio cloud",
  "cloud.alternative.body":
    "Se preferisci non scaricare un modello, PROMETHEUS può usare un'API a pagamento. Imposta la chiave del fornitore come variabile d'ambiente e comparirà in /model. In questo caso le tue richieste escono dal computer: è il compromesso.",

  "guide.title": "Primi passi",
  "guide.step": "Passo {n} di {total}",
  "guide.step1.title": "Installa un motore per i modelli",
  "guide.step1.body":
    "È il programma che esegue davvero l'IA. /doctor mostra il comando esatto per il tuo sistema.",
  "guide.step2.title": "Scarica un modello",
  "guide.step2.body":
    "I modelli differiscono per dimensione e capacità. Uno più grande è più bravo e richiede più memoria; /ram mostra quali entrano nella tua macchina.",
  "guide.step3.title": "Fai una domanda",
  "guide.step3.body":
    "Scrivi in linguaggio naturale. Per lavorare sui file, apri prima una cartella con /cd e poi descrivi che cosa vuoi modificare.",
  "guide.step4.title": "Approvare le azioni",
  "guide.step4.body":
    "Prima che il modello scriva un file, esegua un comando o acceda alla rete, PROMETHEUS te lo chiede. /auth regola quanto spesso lo chiede: parti prudente e allenta quando ti fidi di ciò che vedi.",
  "guide.step5.title": "Dove guardare dopo",
  "guide.step5.body":
    "/help elenca tutti i comandi. /doctor ricontrolla la configurazione. /language cambia la lingua. /ram mostra quali modelli entrano in memoria.",
  "guide.done": "Il giro è finito. Fai una domanda quando vuoi.",

  "common.notinstalled": "non installato",
  "common.copycommand": "Copia questo comando e incollalo nel terminale:",
  "common.needsadmin": "Richiede i permessi di amministratore e chiederà la tua password.",
  "common.nointernet":
    "Questo passaggio scarica da internet. Se sei offline fallirà finché non ti ricolleghi.",
  "common.safe":
    "PROMETHEUS non esegue mai un'installazione al posto tuo senza prima mostrarti il comando e chiedertelo.",
  "common.gated":
    "Tutto ciò che PROMETHEUS scarica viene analizzato prima di poter essere eseguito. Se l'analisi fallisce, l'installazione viene bloccata.",
  "common.cancelled": "Annullato. Non è stato modificato nulla.",
  "common.unknownos":
    "PROMETHEUS non riconosce questo sistema operativo e non può suggerire un comando di installazione. Lo troverai sul sito del progetto.",

  "language.current": "Lingua: {language} ({source}).",
  "language.source.setting": "scelta tua",
  "language.source.environment": "dalle impostazioni di sistema",
  "language.source.fallback": "predefinita",
  "language.available": "Lingue disponibili:",
  "language.usage": "Uso: /language <codice>, oppure /language per scegliere da un elenco.",
  "language.unknown": "{code} non è tra le lingue disponibili.",
  "language.help": "Mostra o cambia la lingua di PROMETHEUS.",

  /* ── the help menu framing (the command NAMES stay English) ─────────────── */
  "help.title": "Sessione Prometheus — guida",
  "help.intro":
    "Scrivi un messaggio per parlare · un comando che inizia con / esegue un'azione · un verbo da solo (scan) lo esegue.",
  "help.total": "{count} comandi in tutto — /commands per l'elenco completo.",
  "commands.title": "Comandi",
  "commands.hint": "{count} comandi — scrivi / seguito da un nome",
};
