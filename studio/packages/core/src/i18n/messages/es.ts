// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * i18n/messages/es.ts — Español.
 *
 * Traducido, no calcado: donde el inglés usa una construcción que en español sonaría forzada,
 * la frase se reescribe para decir lo mismo con naturalidad.
 *
 * Dos reglas al modificar este archivo:
 *   - los marcadores {nombre} no se traducen y pueden REORDENARSE libremente;
 *   - los comandos que el usuario debe escribir (brew install ollama, ollama pull …) quedan en
 *     inglés: traducirlos los volvería inservibles.
 *
 * Registro: tuteo. Es una herramienta de terminal, no una comunicación formal.
 */

import type { MessageCatalog } from "../catalog.js";

export const es: MessageCatalog = {
  "firstrun.language.title": "Elige tu idioma",
  "firstrun.language.intro":
    "PROMETHEUS habla varios idiomas. Esta pregunta está en inglés porque se hace antes de que elijas; todo lo demás sigue tu respuesta.",
  "firstrun.language.prompt": "Elige un número o pulsa Intro para inglés:",
  "firstrun.language.detected": "Tu sistema sugiere {language}: pulsa Intro para aceptarlo.",
  "firstrun.language.confirmed":
    "Idioma establecido en {language}. Puedes cambiarlo cuando quieras con /language.",
  "firstrun.language.partial":
    "{language} está traducido al {percent}%; lo que falta aparece en inglés.",

  "firstrun.welcome.title": "Bienvenido a PROMETHEUS",
  "firstrun.welcome.body":
    "PROMETHEUS ejecuta modelos de IA en tu propio ordenador y les permite trabajar con tus archivos, ejecutar comandos que tú apruebas y buscar en la web. No sale nada de este ordenador salvo que conectes tú mismo un servicio en la nube.",
  "firstrun.welcome.next":
    "Vamos a comprobar qué hay ya instalado. Tarda unos segundos y no cambia nada.",
  "firstrun.newhere":
    "¿Es tu primera vez? Escribe /guide para un recorrido guiado, o /doctor en cualquier momento para ver qué falta.",

  "doctor.title": "Comprobación de la instalación",
  "doctor.checking": "Comprobando qué hay instalado…",
  "doctor.ready.title": "Todo listo",
  "doctor.ready.body":
    "Todo lo que PROMETHEUS necesita está instalado. Escribe una pregunta para empezar.",
  "doctor.blocked.title": "PROMETHEUS aún no puede ejecutar un modelo",
  "doctor.blocked.body":
    "Falta {count} elemento necesario. Los comandos de abajo lo instalan; puedes copiarlos de uno en uno.",
  "doctor.blocked.body.plural":
    "Faltan {count} elementos necesarios. Los comandos de abajo los instalan; puedes copiarlos de uno en uno.",
  "doctor.optional.title": "Complementos opcionales",
  "doctor.optional.body": "No son necesarios. Cada uno habilita algo concreto, indicado al lado.",
  "doctor.recheck": "Vuelve a ejecutar /doctor después de instalar para confirmarlo.",

  "doctor.status.installed": "instalado",
  "doctor.status.missing": "falta",
  "doctor.status.required": "necesario",
  "doctor.status.optional": "opcional",
  "doctor.status.running": "en ejecución",
  "doctor.status.stopped": "instalado pero detenido",
  "doctor.label.why": "Por qué",
  "doctor.label.install": "Instalación",
  "doctor.label.then": "Después",
  "doctor.label.unlocks": "Habilita",
  "doctor.label.docs": "Más información",

  "need.ollama.what": "Ollama — ejecuta modelos de IA en tu ordenador",
  "need.ollama.why":
    "PROMETHEUS no incluye ningún modelo de IA. Ollama es el programa que carga uno y responde a las peticiones, en local y sin conexión. Sin él no hay nadie con quien hablar.",
  "need.ollama.after":
    "Una vez instalado, inícialo y descarga un modelo: /doctor te sugerirá uno que quepa en tu memoria.",
  "need.model.what": "Un modelo de IA",
  "need.model.why":
    "Ollama está instalado pero todavía no tiene ningún modelo. El modelo es el archivo que razona; su tamaño va de unos 2 GB a más de 40 GB.",
  "need.model.suggest":
    "Con {memory} de memoria libre, {model} es una buena primera opción ({size}).",
  "need.model.none":
    "Ningún modelo del catálogo cabe en la memoria libre actual. Cerrar otras aplicaciones, o elegir un modelo más pequeño, debería bastar.",
  "need.ripgrep.what": "ripgrep — búsqueda rápida en archivos",
  "need.ripgrep.why":
    "PROMETHEUS usa ripgrep para buscar en tus archivos. Sin él, la herramienta de búsqueda falla y el modelo pierde la capacidad de encontrar código por su cuenta.",
  "need.git.what": "git — control de versiones",
  "need.git.why":
    "Hace falta para clonar repositorios y para mostrarle al modelo qué ha cambiado en tu proyecto. La mayoría de los sistemas ya lo tienen.",
  "need.node.what": "Node.js 22 o posterior",
  "need.node.why":
    "PROMETHEUS funciona sobre Node. La versión 22 es el mínimo porque lee directamente los fuentes de TypeScript; con versiones anteriores no llega a arrancar.",

  "runner.notinstalled":
    "Ollama no está instalado en este ordenador, así que no hay ningún modelo local que pueda responder.",
  "runner.notrunning":
    "Ollama está instalado pero no se está ejecutando. PROMETHEUS puede iniciarlo, o puedes hacerlo tú con: ollama serve",
  "runner.starting": "Iniciando Ollama…",
  "runner.nomodels":
    "Ollama está en marcha pero no tiene modelos descargados. Descarga uno con: ollama pull {model}",
  "runner.unreachable":
    "No hubo respuesta del servidor de modelos en {url}. Si está en otra máquina, comprueba que esté encendida y que /remote la muestre.",

  "cloud.alternative.title": "O usa un servicio en la nube",
  "cloud.alternative.body":
    "Si prefieres no descargar un modelo, PROMETHEUS puede usar una API de pago. Define la clave del proveedor como variable de entorno y aparecerá en /model. Entonces tus peticiones salen de este ordenador: ese es el compromiso.",

  "guide.title": "Primeros pasos",
  "guide.step": "Paso {n} de {total}",
  "guide.step1.title": "Instala un motor de modelos",
  "guide.step1.body":
    "Es el programa que ejecuta realmente la IA. /doctor muestra el comando exacto para tu sistema.",
  "guide.step2.title": "Descarga un modelo",
  "guide.step2.body":
    "Los modelos varían en tamaño y capacidad. Uno más grande rinde mejor y necesita más memoria; /ram muestra cuáles caben en tu máquina.",
  "guide.step3.title": "Pregunta algo",
  "guide.step3.body":
    "Escribe en lenguaje natural. Para trabajar con archivos, abre primero una carpeta con /cd y luego describe qué quieres cambiar.",
  "guide.step4.title": "Aprobar acciones",
  "guide.step4.body":
    "Antes de que el modelo escriba un archivo, ejecute un comando o acceda a la red, PROMETHEUS te lo pregunta. /auth ajusta con qué frecuencia pregunta: empieza con cautela y reléjalo cuando confíes en lo que ves.",
  "guide.step5.title": "Dónde mirar después",
  "guide.step5.body":
    "/help lista todos los comandos. /doctor vuelve a comprobar la instalación. /language cambia el idioma. /ram muestra qué modelos caben.",
  "guide.done": "Hasta aquí el recorrido. Pregunta lo que quieras cuando estés listo.",

  "common.notinstalled": "no instalado",
  "common.copycommand": "Copia este comando y pégalo en tu terminal:",
  "common.needsadmin": "Requiere permisos de administrador y pedirá tu contraseña.",
  "common.nointernet":
    "Este paso descarga desde internet. Sin conexión fallará hasta que vuelvas a conectarte.",
  "common.safe":
    "PROMETHEUS nunca ejecuta una instalación por ti sin mostrarte antes el comando y preguntártelo.",
  "common.gated":
    "Todo lo que PROMETHEUS descarga se analiza antes de poder ejecutarse. Si el análisis falla, la instalación se bloquea.",
  "common.cancelled": "Cancelado. No se ha cambiado nada.",
  "common.unknownos":
    "PROMETHEUS no reconoce este sistema operativo, así que no puede sugerir un comando de instalación. La página del proyecto tendrá uno.",

  "language.current": "Idioma: {language} ({source}).",
  "language.source.setting": "elección tuya",
  "language.source.environment": "según tu sistema",
  "language.source.fallback": "predeterminado",
  "language.available": "Idiomas disponibles:",
  "language.usage": "Uso: /language <código>, o /language para elegir de una lista.",
  "language.unknown": "{code} no está entre los idiomas disponibles.",
  "language.help": "Muestra o cambia el idioma de PROMETHEUS.",

  /* ── the help menu framing (the command NAMES stay English) ─────────────── */
  "help.title": "Sesión de Prometheus — ayuda",
  "help.intro":
    "Escribe un mensaje para conversar · un comando que empieza por / ejecuta una acción · un verbo suelto (scan) lo ejecuta.",
  "help.total": "{count} comandos en total — /commands para verlos todos.",
  "commands.title": "Comandos",
  "commands.hint": "{count} comandos — escribe / seguido de un nombre",
};
