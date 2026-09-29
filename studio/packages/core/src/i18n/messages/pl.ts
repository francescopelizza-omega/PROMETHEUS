/**
 * i18n/messages/pl.ts — Polski.
 *
 * Tłumaczenie, nie kalka: tam gdzie angielska składnia brzmiałaby po polsku sztucznie, zdanie
 * jest napisane od nowa. Dotyczy to zwłaszcza miejsc z placeholderami — polski wymaga innego
 * przypadka i innego szyku niż angielski, i właśnie po to placeholdery są nazwane, a nie
 * pozycyjne.
 *
 * UWAGA O ODMIANIE. Nazwy w {model}, {language}, {tool} wstawiane są w mianowniku, bo pochodzą
 * z katalogu i nie są odmieniane. Zdania są tak ułożone, żeby mianownik był poprawny —
 * np. „Pobierz model: {model}", a nie „Pobierz {model}", co wymagałoby biernika.
 *
 * Dwie zasady przy edycji:
 *   - placeholderów {nazwa} się nie tłumaczy i można je dowolnie PRZESTAWIAĆ;
 *   - polecenia do wpisania (brew install ollama, ollama pull …) zostają po angielsku:
 *     przetłumaczone przestałyby działać.
 */

import type { MessageCatalog } from "../catalog.js";

export const pl: MessageCatalog = {
  "firstrun.language.title": "Wybierz język",
  "firstrun.language.intro":
    "PROMETHEUS mówi w kilku językach. To pytanie jest po angielsku, bo pada przed Twoim wyborem; wszystko dalej będzie zgodne z odpowiedzią.",
  "firstrun.language.prompt": "Wybierz numer albo naciśnij Enter, aby zostać przy angielskim:",
  "firstrun.language.detected": "System sugeruje: {language} — naciśnij Enter, aby zaakceptować.",
  "firstrun.language.confirmed":
    "Ustawiono język: {language}. Możesz go zmienić w każdej chwili poleceniem /language.",
  "firstrun.language.partial":
    "Tłumaczenie na {language} jest gotowe w {percent}%; reszta wyświetla się po angielsku.",

  "firstrun.welcome.title": "Witaj w PROMETHEUS",
  "firstrun.welcome.body":
    "PROMETHEUS uruchamia modele AI na Twoim komputerze i pozwala im pracować na Twoich plikach, wykonywać zatwierdzone przez Ciebie polecenia oraz szukać w sieci. Nic nie opuszcza tego komputera, dopóki sam nie podłączysz usługi w chmurze.",
  "firstrun.welcome.next":
    "Sprawdźmy, co jest już zainstalowane. Zajmie to kilka sekund i niczego nie zmieni.",
  "firstrun.newhere":
    "Pierwszy raz? Wpisz /guide, aby przejść przewodnik, albo /doctor w dowolnym momencie, aby zobaczyć, czego brakuje.",

  "doctor.title": "Sprawdzenie konfiguracji",
  "doctor.checking": "Sprawdzam, co jest zainstalowane…",
  "doctor.ready.title": "Wszystko gotowe",
  "doctor.ready.body":
    "Wszystko, czego potrzebuje PROMETHEUS, jest zainstalowane. Zadaj pytanie, aby zacząć.",
  "doctor.blocked.title": "PROMETHEUS nie może jeszcze uruchomić modelu",
  "doctor.blocked.body":
    "Brakuje {count} wymaganego elementu. Poniższe polecenia go instalują; możesz kopiować je pojedynczo.",
  "doctor.blocked.body.plural":
    "Brakujących elementów wymaganych: {count}. Poniższe polecenia je instalują; możesz kopiować je pojedynczo.",
  "doctor.optional.title": "Dodatki opcjonalne",
  "doctor.optional.body": "Nie są wymagane. Każdy z nich włącza konkretną funkcję, opisaną obok.",
  "doctor.recheck": "Po instalacji uruchom /doctor ponownie, aby to potwierdzić.",

  "doctor.status.installed": "zainstalowane",
  "doctor.status.missing": "brak",
  "doctor.status.required": "wymagane",
  "doctor.status.optional": "opcjonalne",
  "doctor.status.running": "działa",
  "doctor.status.stopped": "zainstalowane, ale nie działa",
  "doctor.label.why": "Po co",
  "doctor.label.install": "Instalacja",
  "doctor.label.then": "Następnie",
  "doctor.label.unlocks": "Włącza",
  "doctor.label.docs": "Więcej",

  "need.ollama.what": "Ollama — uruchamia modele AI na Twoim komputerze",
  "need.ollama.why":
    "PROMETHEUS sam nie zawiera modelu AI. Ollama to program, który wczytuje model i odpowiada na zapytania — lokalnie i bez internetu. Bez niego nie ma z kim rozmawiać.",
  "need.ollama.after":
    "Po instalacji uruchom go i pobierz model — /doctor podpowie taki, który zmieści się w Twojej pamięci.",
  "need.model.what": "Model AI",
  "need.model.why":
    "Ollama jest zainstalowana, ale nie ma jeszcze żadnego modelu. Model to plik, który myśli; rozmiary sięgają od około 2 GB do ponad 40 GB.",
  "need.model.suggest":
    "Przy {memory} wolnej pamięci dobrym pierwszym wyborem jest {model} ({size}).",
  "need.model.none":
    "Żaden model z katalogu nie mieści się w obecnie wolnej pamięci. Pomoże zamknięcie innych programów albo wybór mniejszego modelu.",
  "need.ripgrep.what": "ripgrep — szybkie wyszukiwanie w plikach",
  "need.ripgrep.why":
    "PROMETHEUS przeszukuje Twoje pliki za pomocą ripgrep. Bez niego narzędzie wyszukiwania zawodzi, a model traci możliwość samodzielnego znajdowania kodu.",
  "need.git.what": "git — kontrola wersji",
  "need.git.why":
    "Potrzebny do klonowania repozytoriów i do pokazania modelowi, co zmieniło się w projekcie. Większość systemów już go ma.",
  "need.node.what": "Node.js 22 lub nowszy",
  "need.node.why":
    "Sam PROMETHEUS działa na Node. Wersja 22 to minimum, bo czyta źródła TypeScript bezpośrednio; starsze wersje kończą się błędem, zanim cokolwiek wystartuje.",

  "runner.notinstalled":
    "Ollama nie jest zainstalowana na tym komputerze, więc nie ma lokalnego modelu, który mógłby odpowiedzieć.",
  "runner.notrunning":
    "Ollama jest zainstalowana, ale nie działa. PROMETHEUS może ją uruchomić — możesz też zrobić to sam: ollama serve",
  "runner.starting": "Uruchamiam Ollamę…",
  "runner.nomodels":
    "Ollama działa, ale nie ma pobranych modeli. Pobierz jeden poleceniem: ollama pull {model}",
  "runner.unreachable":
    "Brak odpowiedzi serwera modeli pod adresem {url}. Jeśli działa na innej maszynie, sprawdź, czy jest włączona i czy /remote ją wypisuje.",

  "cloud.alternative.title": "Albo skorzystaj z usługi w chmurze",
  "cloud.alternative.body":
    "Jeśli wolisz nie pobierać modelu, PROMETHEUS może użyć płatnego API. Ustaw klucz dostawcy jako zmienną środowiskową, a pojawi się w /model. Twoje zapytania będą wtedy opuszczać ten komputer — taki jest kompromis.",

  "guide.title": "Pierwsze kroki",
  "guide.step": "Krok {n} z {total}",
  "guide.step1.title": "Zainstaluj silnik modeli",
  "guide.step1.body":
    "To program, który faktycznie uruchamia AI. /doctor pokaże dokładne polecenie dla Twojego systemu.",
  "guide.step2.title": "Pobierz model",
  "guide.step2.body":
    "Modele różnią się rozmiarem i możliwościami. Większy potrafi więcej i potrzebuje więcej pamięci; /ram pokazuje, które zmieszczą się na Twojej maszynie.",
  "guide.step3.title": "Zadaj pytanie",
  "guide.step3.body":
    "Pisz zwykłym językiem. Aby pracować na plikach, najpierw otwórz katalog poleceniem /cd, a potem opisz, co ma się zmienić.",
  "guide.step4.title": "Zatwierdzanie działań",
  "guide.step4.body":
    "Zanim model zapisze plik, wykona polecenie albo sięgnie do sieci, PROMETHEUS zapyta Cię o zgodę. /auth ustala, jak często pyta: zacznij ostrożnie i poluzuj, gdy zaufasz temu, co widzisz.",
  "guide.step5.title": "Co dalej",
  "guide.step5.body":
    "/help wypisuje wszystkie polecenia. /doctor ponownie sprawdza konfigurację. /language zmienia język. /ram pokazuje, które modele się zmieszczą.",
  "guide.done": "To cały przewodnik. Zadaj pytanie, kiedy tylko zechcesz.",

  "common.notinstalled": "nie zainstalowano",
  "common.copycommand": "Skopiuj to polecenie i wklej je w terminalu:",
  "common.needsadmin": "Wymaga uprawnień administratora i poprosi o hasło.",
  "common.nointernet":
    "Ten krok pobiera dane z internetu. Bez połączenia zakończy się błędem, dopóki nie wrócisz do sieci.",
  "common.safe":
    "PROMETHEUS nigdy nie wykonuje instalacji za Ciebie bez pokazania polecenia i zapytania o zgodę.",
  "common.gated":
    "Wszystko, co PROMETHEUS pobiera, jest skanowane, zanim będzie mogło się uruchomić. Nieudany skan blokuje instalację.",
  "common.cancelled": "Anulowano. Nic nie zostało zmienione.",
  "common.unknownos":
    "PROMETHEUS nie rozpoznaje tego systemu operacyjnego, więc nie podpowie polecenia instalacji. Znajdziesz je na stronie projektu.",

  "language.current": "Język: {language} ({source}).",
  "language.source.setting": "Twój wybór",
  "language.source.environment": "z ustawień systemu",
  "language.source.fallback": "domyślny",
  "language.available": "Dostępne języki:",
  "language.usage": "Użycie: /language <kod> albo samo /language, aby wybrać z listy.",
  "language.unknown": "{code} nie należy do dostępnych języków.",
  "language.help": "Pokazuje lub zmienia język PROMETHEUS.",

  /* ── the help menu framing (the command NAMES stay English) ─────────────── */
  "help.title": "Sesja Prometheus — pomoc",
  "help.intro":
    "Napisz wiadomość, aby rozmawiać · polecenie zaczynające się od / wykonuje akcję · sam czasownik (scan) też je uruchamia.",
  "help.total": "Łącznie poleceń: {count} — /commands pokazuje wszystkie.",
  "commands.title": "Polecenia",
  "commands.hint": "Poleceń: {count} — wpisz / i nazwę",
};
