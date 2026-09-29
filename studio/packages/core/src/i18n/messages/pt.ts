/**
 * i18n/messages/pt.ts — Português.
 *
 * Uma só variante de português, sem distinguir pt-PT de pt-BR: `localeFromPosix` reduz ambos a
 * `pt`, porque dar português aproximado a quem escreveu `pt_BR` é melhor do que dar-lhe inglês.
 * O vocabulário escolhido evita, onde possível, as palavras em que as duas variantes divergem.
 *
 * Duas regras ao editar:
 *   - os marcadores {nome} não se traduzem e podem ser REORDENADOS livremente;
 *   - os comandos a escrever (brew install ollama, ollama pull …) ficam em inglês:
 *     traduzi-los torná-los-ia inúteis.
 */

import type { MessageCatalog } from "../catalog.js";

export const pt: MessageCatalog = {
  "firstrun.language.title": "Escolhe o teu idioma",
  "firstrun.language.intro":
    "O PROMETHEUS fala vários idiomas. Esta pergunta está em inglês porque é feita antes da tua escolha; tudo o resto segue a tua resposta.",
  "firstrun.language.prompt": "Escolhe um número ou carrega em Enter para inglês:",
  "firstrun.language.detected": "O teu sistema sugere {language} — carrega em Enter para aceitar.",
  "firstrun.language.confirmed":
    "Idioma definido para {language}. Podes mudá-lo quando quiseres com /language.",
  "firstrun.language.partial":
    "{language} está traduzido a {percent}%; o que falta aparece em inglês.",

  "firstrun.welcome.title": "Bem-vindo ao PROMETHEUS",
  "firstrun.welcome.body":
    "O PROMETHEUS executa modelos de IA no teu próprio computador e permite-lhes trabalhar com os teus ficheiros, executar comandos que aprovas e pesquisar na web. Nada sai deste computador, a não ser que ligues tu mesmo um serviço na nuvem.",
  "firstrun.welcome.next":
    "Vamos ver o que já está instalado. Demora alguns segundos e não altera nada.",
  "firstrun.newhere":
    "É a primeira vez? Escreve /guide para um percurso guiado, ou /doctor a qualquer momento para veres o que falta.",

  "doctor.title": "Verificação da instalação",
  "doctor.checking": "A verificar o que está instalado…",
  "doctor.ready.title": "Está tudo pronto",
  "doctor.ready.body":
    "Tudo o que o PROMETHEUS precisa está instalado. Escreve uma pergunta para começar.",
  "doctor.blocked.title": "O PROMETHEUS ainda não consegue executar um modelo",
  "doctor.blocked.body":
    "Falta {count} elemento necessário. Os comandos abaixo instalam-no; podes copiá-los um a um.",
  "doctor.blocked.body.plural":
    "Faltam {count} elementos necessários. Os comandos abaixo instalam-nos; podes copiá-los um a um.",
  "doctor.optional.title": "Extras opcionais",
  "doctor.optional.body": "Não são necessários. Cada um ativa algo específico, indicado ao lado.",
  "doctor.recheck": "Corre /doctor outra vez depois de instalar, para confirmar.",

  "doctor.status.installed": "instalado",
  "doctor.status.missing": "em falta",
  "doctor.status.required": "necessário",
  "doctor.status.optional": "opcional",
  "doctor.status.running": "em execução",
  "doctor.status.stopped": "instalado mas parado",
  "doctor.label.why": "Porquê",
  "doctor.label.install": "Instalação",
  "doctor.label.then": "Depois",
  "doctor.label.unlocks": "Ativa",
  "doctor.label.docs": "Mais",

  "need.ollama.what": "Ollama — executa modelos de IA no teu computador",
  "need.ollama.why":
    "O PROMETHEUS não inclui nenhum modelo de IA. O Ollama é o programa que carrega um e responde aos pedidos, localmente e sem ligação à internet. Sem ele não há com quem falar.",
  "need.ollama.after":
    "Depois de instalado, inicia-o e descarrega um modelo — o /doctor sugere um que caiba na tua memória.",
  "need.model.what": "Um modelo de IA",
  "need.model.why":
    "O Ollama está instalado mas ainda não tem nenhum modelo. O modelo é o ficheiro que raciocina; os tamanhos vão de cerca de 2 GB a mais de 40 GB.",
  "need.model.suggest":
    "Com {memory} de memória livre, {model} é uma boa primeira escolha ({size}).",
  "need.model.none":
    "Nenhum modelo do catálogo cabe na memória livre atual. Fechar outras aplicações, ou escolher um modelo mais pequeno, deve resolver.",
  "need.ripgrep.what": "ripgrep — pesquisa rápida em ficheiros",
  "need.ripgrep.why":
    "O PROMETHEUS usa o ripgrep para pesquisar nos teus ficheiros. Sem ele a ferramenta de pesquisa falha, e o modelo perde a capacidade de encontrar código sozinho.",
  "need.git.what": "git — controlo de versões",
  "need.git.why":
    "Necessário para clonar repositórios e para mostrar ao modelo o que mudou no teu projeto. A maioria dos sistemas já o tem.",
  "need.node.what": "Node.js 22 ou mais recente",
  "need.node.why":
    "O próprio PROMETHEUS corre sobre o Node. A versão 22 é o mínimo porque lê diretamente o código TypeScript; versões anteriores falham antes de arrancar.",

  "runner.notinstalled":
    "O Ollama não está instalado neste computador, por isso não há nenhum modelo local que possa responder.",
  "runner.notrunning":
    "O Ollama está instalado mas não está a correr. O PROMETHEUS pode iniciá-lo, ou podes fazê-lo com: ollama serve",
  "runner.starting": "A iniciar o Ollama…",
  "runner.nomodels":
    "O Ollama está a correr mas não tem modelos descarregados. Descarrega um com: ollama pull {model}",
  "runner.unreachable":
    "Sem resposta do servidor de modelos em {url}. Se estiver noutra máquina, verifica se está ligada e se o /remote a lista.",

  "cloud.alternative.title": "Ou usa um serviço na nuvem",
  "cloud.alternative.body":
    "Se preferires não descarregar um modelo, o PROMETHEUS pode usar uma API paga. Define a chave do fornecedor como variável de ambiente e ela aparece em /model. Os teus pedidos passam então a sair deste computador: é esse o compromisso.",

  "guide.title": "Primeiros passos",
  "guide.step": "Passo {n} de {total}",
  "guide.step1.title": "Instala um motor de modelos",
  "guide.step1.body":
    "É o programa que executa de facto a IA. O /doctor mostra o comando exato para o teu sistema.",
  "guide.step2.title": "Descarrega um modelo",
  "guide.step2.body":
    "Os modelos variam em tamanho e capacidade. Um maior é mais capaz e precisa de mais memória; o /ram mostra quais cabem na tua máquina.",
  "guide.step3.title": "Faz uma pergunta",
  "guide.step3.body":
    "Escreve em linguagem corrente. Para trabalhar com ficheiros, abre primeiro uma pasta com /cd e depois descreve o que queres alterar.",
  "guide.step4.title": "Aprovar ações",
  "guide.step4.body":
    "Antes de o modelo escrever um ficheiro, executar um comando ou aceder à rede, o PROMETHEUS pergunta-te. O /auth define com que frequência pergunta: começa cauteloso e alivia quando confiares no que vês.",
  "guide.step5.title": "Para onde ir a seguir",
  "guide.step5.body":
    "/help lista todos os comandos. /doctor verifica de novo a instalação. /language muda o idioma. /ram mostra que modelos cabem.",
  "guide.done": "O percurso acabou. Pergunta o que quiseres quando estiveres pronto.",

  "common.notinstalled": "não instalado",
  "common.copycommand": "Copia este comando e cola-o no teu terminal:",
  "common.needsadmin": "Isto exige permissões de administrador e vai pedir a tua palavra-passe.",
  "common.nointernet":
    "Este passo descarrega da internet. Sem ligação, falha até voltares a ligar-te.",
  "common.safe":
    "O PROMETHEUS nunca executa uma instalação por ti sem antes te mostrar o comando e perguntar.",
  "common.gated":
    "Tudo o que o PROMETHEUS descarrega é analisado antes de poder ser executado. Se a análise falhar, a instalação é bloqueada.",
  "common.cancelled": "Cancelado. Não foi alterado nada.",
  "common.unknownos":
    "O PROMETHEUS não reconhece este sistema operativo, por isso não consegue sugerir um comando de instalação. A página do projeto terá um.",

  "language.current": "Idioma: {language} ({source}).",
  "language.source.setting": "escolha tua",
  "language.source.environment": "das definições do sistema",
  "language.source.fallback": "predefinido",
  "language.available": "Idiomas disponíveis:",
  "language.usage": "Utilização: /language <código>, ou /language para escolher de uma lista.",
  "language.unknown": "{code} não está entre os idiomas disponíveis.",
  "language.help": "Mostra ou muda o idioma do PROMETHEUS.",

  /* ── the help menu framing (the command NAMES stay English) ─────────────── */
  "help.title": "Sessão Prometheus — ajuda",
  "help.intro":
    "Escreve uma mensagem para conversar · um comando começado por / executa uma ação · um verbo sozinho (scan) executa-o.",
  "help.total": "{count} comandos no total — /commands para ver todos.",
  "commands.title": "Comandos",
  "commands.hint": "{count} comandos — escreve / seguido de um nome",
};
