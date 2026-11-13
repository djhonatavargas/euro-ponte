// Euro Ponte: WhatsApp (QR, via Baileys) <-> Claude, atendimento da Euro Consultoria.
// Versão 2: espelho do WhatsApp (painel web ao vivo), assistente por conversa, conectar/desconectar por QR.
// Roda no servidor como serviço "euro-ponte". Configuração em /opt/euro-ponte/.env
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const pino = require('pino');
const QRCode = require('qrcode');
// Biblioteca do WhatsApp: tenta a versão 7 ("baileys", com suporte aos códigos LID); se não carregar, usa a 6 (antiga).
let makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, downloadMediaMessage, Browsers;
let BAILEYS = null, BAILEYS_VERSAO = '', BPICK = () => undefined;
let forcarAntigo = false, abriuComV7 = false;
function voltarParaAntigo(motivo) {   // a versão 7 não funcionou aqui: volta para a 6 sem derrubar o serviço
  if (forcarAntigo) return; forcarAntigo = true; BAILEYS = null; log('voltando para a biblioteca antiga:', motivo);
}
async function carregarBaileys() {
  if (BAILEYS) return BAILEYS;
  try { if (forcarAntigo || process.env.EP_BAILEYS6) throw new Error('forçado'); BAILEYS = await import('baileys'); BAILEYS_VERSAO = 'baileys 7'; }
  catch (e) { BAILEYS = require('@whiskeysockets/baileys'); BAILEYS_VERSAO = 'baileys 6 (antigo)'; try { log('baileys 7 indisponível, usando o antigo:', e.message); } catch (x) { } }
  const ns = BAILEYS;
  const pick = (k) => (ns[k] !== undefined ? ns[k] : (ns.default && ns.default[k]));
  makeWASocket = typeof ns.makeWASocket === 'function' ? ns.makeWASocket : (typeof ns.default === 'function' ? ns.default : (ns.default && (ns.default.makeWASocket || ns.default.default)));
  useMultiFileAuthState = pick('useMultiFileAuthState'); DisconnectReason = pick('DisconnectReason');
  fetchLatestBaileysVersion = pick('fetchLatestBaileysVersion'); downloadMediaMessage = pick('downloadMediaMessage'); Browsers = pick('Browsers');
  BPICK = pick;
  return BAILEYS;
}

// ---------- configuração ----------
const BASE = __dirname;
function lerEnv() {
  const env = {};
  try {
    for (const l of fs.readFileSync(path.join(BASE, '.env'), 'utf8').split(/\r?\n/)) {
      const m = /^\s*([A-Z_]+)\s*=\s*(.*)\s*$/.exec(l);
      if (m) env[m[1]] = m[2];
    }
  } catch (e) { }
  return env;
}
const ENV = lerEnv();
const API_KEY = ENV.ANTHROPIC_API_KEY || '';
const MODELO = ENV.MODELO || 'claude-haiku-5-5';
const TOKEN = ENV.TOKEN || '';
const PORTA = Number(ENV.PORTA || 8080);
const DONO = ENV.DONO || '554799043294';          // WhatsApp pessoal do Djhonata (sem o 9 extra)
const PAUSA_HORAS = Number(ENV.PAUSA_HORAS || 0);  // 0 = quando o Djhonata escreve, a assistente continua junto (lendo o que ele mandou)
const SENHA = ENV.SENHA || '';                     // senha do painel (além do TOKEN)
const ESPERA_MS = Number(ENV.ESPERA_MS || 18000);  // espera o cliente terminar de digitar (ele costuma mandar várias mensagens seguidas)
const ESPERA_CURTA_MS = 26000;                      // mensagem curta e sem pergunta ("tranquilo", "mas", "então"): quase sempre vem outra logo depois
// mensagem que chegou atrasada (WhatsApp caiu e voltou, servidor reiniciou) ainda é respondida até este tempo
const JANELA_ATRASADA = Number(ENV.JANELA_ATRASADA_HORAS || 12) * 3600e3;
const HORA_INI = ENV.HORA_INI || '08:00';
const HORA_FIM = ENV.HORA_FIM || '23:30';
const ATENDE_24H = !/^(nao|não|0|false)$/i.test(String(ENV.ATENDE_24H || 'sim'));   // decisão do Djhonata, 12/11/2026: a assistente responde a qualquer hora (lembretes e retomadas seguem a janela das rotinas)
// Voz e ouvido (como no OpenClaw): ElevenLabs fala com a voz do Djhonata e transcreve os áudios recebidos.
const ELEVEN_KEY = ENV.ELEVENLABS_API_KEY || '';
const ELEVEN_VOZ = ENV.ELEVEN_VOZ || 'ESI8AvlyEl6TuR4ajagH';       // voz do Djhonata (a mesma do OpenClaw)
const ELEVEN_MODELO = ENV.ELEVEN_MODELO || 'eleven_v4';
const GEMINI_KEY = ENV.GEMINI_API_KEY || ENV.GOOGLE_API_KEY || '';  // opcional: transcreve pelo Gemini se a ElevenLabs falhar
// Rotinas (lembrete de visita e retomada) só nesse horário
const ROTINAS = ENV.ROTINAS !== '0';
const ROT_INI = ENV.ROTINA_INI || '08:00', ROT_FIM = ENV.ROTINA_FIM || '21:30';
// Retomada do mesmo dia (decisão do Djhonata, 12/11/2026): só das 9h às 19h30; o que passar disso sai na manhã seguinte.
// Lembrete de visita e retorno combinado com o cliente seguem o horário das rotinas (acima).
let RET_INI = ENV.RETOMADA_INI || '09:00', RET_FIM = ENV.RETOMADA_FIM || '19:30';

const DADOS = path.join(BASE, 'dados');
const CATALOGO = path.join(BASE, 'catalogo');
const AUTH = path.join(DADOS, 'auth');
const CONV = path.join(DADOS, 'conversas');
const ESPELHO = path.join(DADOS, 'espelho');
const MIDIA = path.join(DADOS, 'midia');
for (const d of [DADOS, CATALOGO, AUTH, CONV, ESPELHO, MIDIA]) fs.mkdirSync(d, { recursive: true });
const ESTADO_F = path.join(DADOS, 'estado.json');

function lerJson(f, padrao) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return padrao; } }
function gravarJson(f, v) { fs.writeFileSync(f + '.tmp', JSON.stringify(v, null, 1)); fs.renameSync(f + '.tmp', f); }
const estado = Object.assign({ ativo: false, pausas: {}, whatsDesligado: false }, lerJson(ESTADO_F, {}));
function salvarEstado() { gravarJson(ESTADO_F, estado); }

function log(...a) { const t = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }); console.log(t, ...a); try { fs.appendFileSync(path.join(DADOS, 'ponte.log'), t + ' ' + a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ') + '\n'); } catch (e) { } }

// ---------- números ----------
function digitos(s) { return String(s || '').replace(/\D/g, ''); }
// Brasil: celular com o 9 extra (13 dígitos) vira 12 dígitos, que é como o WhatsApp registra (DDD 31+)
function normal(n) {
  n = digitos(n);
  if (n.startsWith('55') && n.length === 13 && Number(n.slice(2, 4)) >= 31) n = n.slice(0, 4) + n.slice(5);
  return n;
}
function lerBloqueados() {
  try { return new Set(fs.readFileSync(path.join(CATALOGO, '_ponte', 'bloqueados.txt'), 'utf8').split(/\s+/).filter(Boolean).map(normal)); }
  catch (e) { return new Set(); }
}
function telefoneDe(m) {
  const k = m.key || {};
  if (k.remoteJid && k.remoteJid.endsWith('@lid') && (k.senderPn || k.remoteJidAlt)) ligarLid(k.remoteJid, k.senderPn || k.remoteJidAlt);
  const alt = k.senderPn || k.participantPn || k.remoteJidAlt || lidPn[k.remoteJid] || '';
  const j = alt || k.remoteJid || '';
  if (j.endsWith('@lid')) return '';
  return normal(j.split('@')[0].split(':')[0]);
}
function formatoBR(n) { n = digitos(n); if (n.length === 12) return `+${n.slice(0, 2)} ${n.slice(2, 4)} ${n.slice(4, 8)}-${n.slice(8)}`; return '+' + n; }

// ---------- horário ----------
function agoraSP() { return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' })); }
function minutos(hhmm) { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; }
function dentroDoHorario() { if (ATENDE_24H) return true; const d = agoraSP(); const x = d.getHours() * 60 + d.getMinutes(); return x >= minutos(HORA_INI) && x <= minutos(HORA_FIM); }

// ---------- conversas (memória) ----------
function arqConv(id) { return path.join(CONV, id.replace(/[^0-9a-zA-Z@._-]/g, '_') + '.json'); }
function lerConv(id) { return lerJson(arqConv(id), []); }
function anotar(id, role, texto, mid) {   // mid = id da mensagem do WhatsApp (evita a IA ler a mesma mensagem duas vezes)
  const h = lerConv(id);
  const e = { role, texto: String(texto).slice(0, 6000), ts: Date.now() }; if (mid) e.mid = mid;
  h.push(e);
  gravarJson(arqConv(id), h.slice(-200));
}
// Todo cliente que a assistente atende ganha um card no CRM (Em atendimento), mesmo que ela não registre nada:
// antes, quem só trocava duas mensagens (ou indicava outra pessoa) não aparecia em Pessoas.
function cardAutomatico(jid, forcar) {
  const c = chats[jid]; if (!c || c.crmAuto) return false;
  if (estado.teste && estado.teste.ativo) return false;
  const tel = String(c.telefone || (pnDe(jid) || '').split('@')[0] || '').replace(/\D/g, ''), t8 = tel.slice(-8);
  if (t8.length !== 8 || normal(tel) === normal(DONO) || lerBloqueados().has(normal(tel))) return false;
  const mapa = estado.crmStatus || {}; if (!Object.keys(mapa).length) return false;   // o CRM ainda não mandou a lista: não arrisca
  if (t8 in mapa) { c.crmAuto = -1; return false; }   // já tem card
  c.crmAuto = Date.now(); salvarChats();
  const ad = c.anuncio ? 'Lead do anúncio' + (c.anuncio.titulo ? ' "' + c.anuncio.titulo + '"' : '') : 'Chamou no WhatsApp';
  fs.appendFileSync(path.join(DADOS, 'eventos-crm.jsonl'), JSON.stringify({ rid: 'au' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), ts: new Date().toISOString(), telefone: formatoBR(tel), nome: c.nome || '', novoStatus: 'atendimento', soCriar: true, resultado: ad + ': a assistente começou o atendimento.' }) + '\n');
  log('card criado no CRM para', tel);
  return true;
}
// Resposta da IA: se o cliente mandou algo ENQUANTO ela respondia, a resposta fica antes dessas mensagens no histórico
// e elas ganham um aviso, para a próxima rodada responder o que ficou sem resposta (em vez de achar que já respondeu).
const AVISO_MEIO = '[o cliente mandou isto enquanto você escrevia a resposta acima; ela NÃO considerou esta mensagem. Responda agora SÓ o que esta mensagem acrescenta, em 1 ou 2 linhas. NÃO repita nada da resposta acima: nem a pergunta que você fez (se ela continua sem resposta, não faça de novo: espere o cliente), nem convite, horário, link, endereço ou explicação. Se esta mensagem não pede nada novo (um ok, um emoji, o nome, uma foto), responda com uma confirmação curta, sem pergunta]\n';
function anotarResposta(id, texto, tIni) {
  const h = lerConv(id);
  const e = { role: 'assistant', texto: String(texto).slice(0, 6000), ts: Date.now() };
  let i = h.length; while (i > 0 && h[i - 1].role === 'user' && (h[i - 1].ts || 0) >= tIni) i--;
  const meio = h.slice(i).map((x, k) => (k === 0 && !String(x.texto || '').startsWith(AVISO_MEIO) ? Object.assign({}, x, { texto: (AVISO_MEIO + x.texto).slice(0, 6000) }) : x));
  if (meio.length) { e.ts = Math.max(tIni, (h[i].ts || tIni) - 1); log('cliente escreveu no meio da resposta', id, meio.length, 'mensagem(ns)'); }
  gravarJson(arqConv(id), [...h.slice(0, i), e, ...meio].slice(-200));
}
function esquecerConversa(jid) {   // guarda uma cópia e a IA começa do zero nessa conversa (ex.: depois de um teste)
  const f = arqConv(jid); if (!fs.existsSync(f)) return false;
  try { fs.renameSync(f, f.replace(/\.json$/, `.esquecida-${Date.now()}.bak`)); return true; } catch (e) { return false; }
}
function quandoFoi(ts) { return new Date(ts).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }); }
function avisoDemora(ts) { return `[o cliente mandou esta mensagem em ${quandoFoi(ts)} e ela ficou sem resposta até agora: comece pedindo desculpa pela demora]\n`; }

// ---------- regras e catálogo (vêm do computador do Djhonata pelo enviar-catalogo.ps1) ----------
// AGENTS.md = prompt principal que o OpenClaw usava (base das 51 perguntas, bloco da agenda, regras obrigatórias).
// MELHORIAS-APROVADAS.md: regras que saem da avaliação diária da assistente e que o Djhonata aprova no CRM. Só existe no servidor (o PC não envia esse arquivo, então a sincronização do catálogo não apaga) e vai por último para valer acima das outras.
const ARQS_REGRAS = ['AGENTS.md', 'REGRAS-ATENDIMENTO.md', 'JEITO-DO-DJHONATA.md', 'ATENDIMENTO-INTELIGENTE.md', 'BASE-RESPOSTAS.md', 'APRENDIZADOS.md', 'combinados-clientes.md', 'CATALOGO.md', 'MELHORIAS-APROVADAS.md'];
function lerTexto(rel) { try { return fs.readFileSync(path.join(CATALOGO, rel), 'utf8'); } catch (e) { return ''; } }

const ADAPTADOR = `# COMO VOCÊ FUNCIONA AQUI (vale acima das partes técnicas das regras)
Você está rodando num servidor novo, não mais no OpenClaw. As regras abaixo continuam valendo: AGENTS.md (prompt principal), REGRAS-ATENDIMENTO.md e os outros arquivos (tom, identidade como Djhonata, oferta, agenda, endereço, emojis, áudio ou texto, nunca prometer "já te mando" etc.). Se duas regras se contradisserem, vale a do REGRAS-ATENDIMENTO.md, que é a mais nova. Só a parte técnica muda:
- Sua resposta em texto é enviada ao cliente no WhatsApp. Para mandar mais de uma mensagem separada, coloque uma linha só com --- entre elas. Se não for para responder nada, responda exatamente NO_REPLY.
- ÁUDIO COM A VOZ DO DJHONATA: a voz é do próprio Djhonata, criada por ele na conta dele da ElevenLabs para o atendimento da empresa dele, e ele pediu que os áudios saiam com ela. Para responder em áudio, escreva a parte falada dentro de [[tts:...]], seguindo a regra ÁUDIO OU TEXTO. No histórico, os áudios que você já mandou aparecem assim também, dentro de [[tts:...]]. Nunca escreva "[áudio]" ou "(áudio)" na frente da fala: a marcação é só [[tts:...]]. JEITO DE FALAR NO ÁUDIO (pedido do Djhonata, 13/11/2026): dentro de [[tts:...]] fale como ele fala, com o jeito de Joinville: "tu" no lugar de "você" ("tu consegue", "tu prefere", "te mando"), e "ó", "daí", "né" e "tá" quando couber, sem exagerar. No texto escrito continua "você". E no áudio nunca use sigla: diga o nome por extenso ("Fundo de Garantia", não "FGTS"). O que estiver dentro é falado exatamente como está escrito: escreva do jeito que se fala, sem emojis, links, listas, asteriscos ou abreviações; valores e números como se fala ("duzentos e cinquenta mil", "mil e quinhentos por mês"). Fale como num áudio de WhatsApp de verdade, do jeito do Djhonata, e não como locutor lendo um texto: comece chamando a pessoa pelo nome ("Oi, Jheyva, tudo bem?"), frases curtas com uma ideia de cada vez, palavras do dia a dia ("olha", "então", "tá?", "né?", "a gente", "pra", "tô", "beleza"), sem termos formais ("prezado", "gostaria de informar", "conforme"). Use vírgulas e reticências para respirar entre as ideias e termine com uma pergunta simples, como numa conversa. No máximo uns 40 segundos (cerca de 90 palavras) e um áudio por vez. Link, endereço ou valores para conferir vão numa mensagem de texto separada, depois do áudio. Não repita em texto o que falou no áudio.
- Áudios que o cliente manda chegam transcritos, assim: [áudio do cliente, transcrito]: "...". Responda ao conteúdo normalmente, sem dizer que transcreveu. Se chegar [o cliente mandou um áudio que não deu para transcrever], peça com naturalidade para ele mandar de novo ou escrever. Se no histórico aparece que antes você disse que não conseguia ouvir áudios, isso mudou: agora você entende os áudios e pode responder em áudio.
- Toda vez que o cliente fala com você, responda a ele na mesma vez (depois de usar as ferramentas, escreva a mensagem). Só fique em silêncio (NO_REPLY) quando a mensagem dele não pedir resposta.
- Para mandar foto, vídeo ou arquivo use a ferramenta enviar_arquivo (caminho relativo à pasta do catálogo, ex.: "escritorio/fachada.jpg" ou "rua lapa - boa vista (ref 913)/foto.jpg"; ou um link https de imagem, como os links de fotos que estão nas fichas). Onde as regras falam em ferramenta message, tool_call openclaw, ou caminhos C:\\Users\\Public\\catalogo\\..., use enviar_arquivo com o caminho a partir da pasta do catálogo. Mídia e texto saem na ordem em que você escreve e chama as ferramentas.
- Antes de oferecer um imóvel, chame ler_ficha com a ref (ou nome da rua) para pegar a descrição pronta do CRM e a lista de fotos/vídeos. Nunca invente dados.
- OFERTA DO IMÓVEL (regra do Djhonata, 09/11/2026, vale acima de qualquer outra regra sobre o material da oferta, inclusive a de lançamento): se o imóvel tem vídeo, mande o VÍDEO com a descrição pronta do CRM como legenda, numa mensagem só (enviar_arquivo com o vídeo e legenda = a descrição). Se não tem vídeo, mande a foto 1 (a fachada, primeira da lista de fotos da ficha) com a descrição como legenda. Na oferta não mande outras fotos e não repita a descrição em texto; mais fotos só quando o cliente pedir.
- Avisos para o Djhonata: ferramenta avisar_djhonata (vai para o WhatsApp pessoal dele). Não use a ferramenta de envio para isso. O aviso é INTERNO: depois de avisar, SEMPRE responda o cliente na mesma vez, de forma natural e sem dizer que foi consultar alguém (por exemplo, fazendo uma pergunta para entender melhor o que ele procura: bairro, quartos, faixa de valor, se é pronto ou na planta). Nunca deixe o cliente sem resposta. Use NO_REPLY só quando a mensagem do cliente não pede resposta (ex.: "ok", "👍", "obrigado" no fim da conversa).
- Quem escreve é um CLIENTE (lead), a não ser que o sistema diga explicitamente que é o Djhonata. Trate a pessoa como cliente: nunca fale com ela como se fosse o dono, o chefe ou o corretor.
- Eventos do CRM (visita marcada com data e hora, remarcar, negociação, cliente pausado, nome real, imóvel de interesse): ferramenta registrar_crm. Onde as regras mandam escrever em arquivos (visitas-agendadas.md, avisos-enviados.md, resultados-assistente.jsonl, AGENTS.md, combinados), não escreva arquivos: use registrar_crm e avisar_djhonata. O sistema guarda as visitas e os avisos.
- ROTINAS: os lembretes de visita e a retomada de quem parou de responder são disparados pelo sistema, com uma mensagem [ROTINA AUTOMÁTICA ...]. Siga o que ela pedir; quando não houver nada a fazer, responda NO_REPLY (nunca escreva "nada a fazer", porque iria para o cliente). Fora disso, não prometa mandar mensagem depois e não marque nada por conta própria.
- Imagens que o cliente mandar chegam para você ver (ex.: comprovante do agendamento).
- RESPONDA TODAS AS PERGUNTAS (regra do Djhonata, 10/11/2026): antes de responder, veja todas as perguntas que o cliente fez desde a sua última resposta, inclusive as que vieram em mensagens separadas (ex.: "como funciona pela Caixa?" e "precisa de nome limpo e score bom?"), e responda cada uma, curto, antes de convidar ou mandar outro assunto. Nunca deixe pergunta sem resposta.
- NOME (regra do Djhonata, 10/11/2026): se o cliente já disse o nome (mesmo numa mensagem solta, ex.: "Stefani") ou o nome do WhatsApp dele já é um nome de pessoa, use esse nome e não pergunte. Pergunte o nome no máximo uma vez na conversa. Chame sempre só pelo PRIMEIRO nome (Maria Gabriela é "Maria", Ana Kelly é "Ana"), nunca nome composto nem sobrenome.
- CONVITE PARA O ESCRITÓRIO E AGENDA (regra do Djhonata, 10/11/2026, vale acima de qualquer regra ou exemplo que mande a agenda toda vez): convide para o escritório na hora certa, quando o cliente mostrar interesse (gostou do imóvel, quer ver de perto, quer fechar, pergunta como faz para comprar). Não convide depois de cada simulação ou dúvida. No PRIMEIRO convite mande a agenda no formato fixo; logo depois o sistema manda sozinho a foto do escritório e o endereço com a localização (não mande você a foto nem o endereço junto com a agenda). Depois disso NÃO mande a agenda de novo: quando o cliente der abertura para vir, convide e pergunte o dia e o horário que fica bom, que você mesma marca. Mande a agenda de novo só se o cliente pedir (não achou o link, pediu de novo, quer remarcar) ou numa retomada em que você convida para vir tirar as dúvidas.
- VOCÊ MARCA NA AGENDA (regra do Djhonata, 11/11/2026, vale acima de qualquer regra ou exemplo antigo que diga "não consigo marcar por aqui" ou que peça comprovante): quando o cliente disser um dia ou um horário para vir (ex.: "pode ser sábado às 14h", "amanhã de manhã"), use agenda_visita. Primeiro consulte o dia; se o horário estiver livre, marque você mesma e confirme dia, hora e endereço. NUNCA diga que um horário está bom sem ter consultado a agenda. Se não estiver livre, ofereça os horários livres que a ferramenta devolver (do mesmo dia ou dos próximos). Se ele disser só o dia, consulte e ofereça dois ou três horários livres. Depois de marcar, não mande o link e não peça comprovante. O link continua valendo para o cliente que ainda não escolheu o dia; se ele marcar pelo link e mandar o comprovante, confirme a visita.
- OFERTAS (análise das conversas de 10/11/2026): no máximo 2 imóveis por vez. Se o cliente pedir "mais em conta" ou "pronto", pergunte antes quanto ele quer pagar (ou a renda) e mostre a melhor opção dentro disso, em vez de mandar vários. Confira na ficha se é casa geminada ou apartamento antes de oferecer: se ele pediu casa/geminado, não ofereça apartamento sem dizer antes que é apartamento. O preço que vale para o cliente é o preço de venda: só fale da avaliação do banco se ele perguntar, deixando claro que não é o preço.
- SIMULAÇÃO E FLUXO DE PAGAMENTO (regra do Djhonata, 10/11/2026, refeita em 13/11/2026; vale acima da seção "Entrada" e do gatilho de ENTRADA/NEGOCIAÇÃO das regras): o objetivo é o cliente sair de casa sabendo que consegue comprar; o fluxo de pagamento é o que fecha o negócio. Quando ele pedir simulação ou perguntar como fica a entrada/pagamento de um imóvel, monte e mande a simulação você mesma: (1) não faça NENHUMA pergunta antes (nem sinal, nem parcela, nem renda, nem FGTS): no primeiro momento é informação demais para pedir. Use logo a ferramenta simular_fluxo com o imóvel que ele está vendo e com o que ele JÁ disse. Sem os números dele, ela monta o FLUXO PADRÃO: sinal de R$ 10 mil (o mínimo do padrão; se ele não conseguir, ajusta), parcelas de R$ 1.500 por mês até 3 meses depois da entrega, um reforço de R$ 5 mil em cada dezembro (fim de ano, quando entra 13º; o dezembro deste ano só entra se a conversa for até julho) e o que sobrar num reforço na entrega das chaves. Mande o texto que ela devolver, por texto; (2) depois do bloco faça UMA pergunta aberta, só ela: "O que você achou desse fluxo? Se quiser, eu ajusto o sinal, a parcela ou o reforço pra ficar bom pra você."; (3) o cliente diz o que pesa ou o que consegue, e você refaz com a ferramenta, mexendo só no que ele falou: não consegue R$ 1.500 por mês -> parcela = o que ele consegue (ex.: 1000); não consegue o reforço de fim de ano -> balao = 0 (ou o valor que ele consegue); não consegue dar o valor na entrega das chaves -> reforco = 0 (ou o valor que ele consegue) e pos_chaves = 36: o que faltar vira parcelas mensais DEPOIS das chaves, no valor da parcela que ele pode pagar (a ferramenta usa só as parcelas que precisar), e se sobrar um valor pequeno ele fica na entrega das chaves para a conta fechar ("pelo menos R$ 400 você precisa dar na entrega das chaves"); consegue mais de sinal -> sinal maior. Da segunda vez em diante a ferramenta devolve só os valores, e você responde em 1 a 3 linhas o que mudou, sem mandar o bloco outra vez (só se ele pedir a conta completa). Uma pergunta por vez, sempre. FGTS: no fluxo NÃO considere e NÃO pergunte de FGTS nem de carteira assinada. Só fale de FGTS quando o cliente achar o fluxo pesado (aí pergunte UMA vez: "Você tem FGTS? Dá pra usar pra abater na entrada.") ou quando ele mesmo citar. RENDA: não pergunte a renda para montar o fluxo. PARCELA DO FINANCIAMENTO: você NÃO fala de parcela pela renda do cliente (nada de "30% da renda"). Fale a estimativa pela faixa de preço do imóvel, que já sai no bloco ("em torno de R$ X por mês"): imóvel de 350 mil, uns R$ 1.700; 400 mil, uns R$ 1.800; 450 mil, uns R$ 2.200; 500 mil, uns R$ 2.600; 600 mil, uns R$ 3.000. É estimativa: o valor certo sai na aprovação da Caixa. O financiamento já sai calculado do jeito mais atrativo para o cliente (80% da avaliação do banco quando ela está acima do preço; senão, 80% do próprio preço): não fale da avaliação ao cliente (só se ele perguntar). Se o cliente questionar a entrada menor (ex.: "mas não tem que dar mais de entrada?"), explique com suas palavras: o banco financia pelo valor da avaliação do imóvel, e esse imóvel a gente está vendendo abaixo do valor de mercado; por isso a gente consegue dar esse desconto e ele consegue financiar mais. É uma condição que a gente tem por ter muitos anos de mercado e ser construtora também, e isso ajuda na negociação dele. Não diga um valor de avaliação (o valor certo só sai quando o banco avalia). Não convide para o escritório depois de cada simulação: só quando ele mostrar interesse em fechar ou ver de perto. Nunca invente números fora da ferramenta e nunca prometa aprovação. Isso vale acima da regra antiga de não passar número fechado.
- OFERTA CERTA (regra do Djhonata, 13/11/2026; vale acima de "o mais em conta do bairro" e de qualquer regra de escolher pelo menor preço): o imóvel mais barato do bairro NÃO é necessariamente a melhor compra. O cliente daqui compra geminado NA PLANTA com condição facilitada: sinal pequeno, parcelas de R$ 1.000 a R$ 2.000 e o resto na entrega. A melhor oferta é o imóvel com a MELHOR CONDIÇÃO DE COMPRA: o que deixa menos para pagar na entrega das chaves no fluxo padrão, porque tem entrada menor (o banco avalia acima do preço e isso vira desconto para o cliente) e entrega mais longa (mais meses de parcela e mais reforços de fim de ano). Para escolher o que oferecer: na tabela CONDIÇÃO DE COMPRA, no fim, pegue o PRIMEIRO do bairro que o cliente pediu (ou do bairro perto, pela tabela BAIRROS PERTO) que atende o que ele pediu (tipo, quartos, medida, valor máximo se ele deu). Ex.: no Aventureiro, um de R$ 375 mil com entrada de 52,6 mil é oferta melhor que um de R$ 360 mil com entrada de 57,6 mil. Se ele achar o valor alto, o próximo é o que vem depois na tabela entre os que servem (menor sobra na entrega e menor entrada), não o de menor preço. Imóvel pronto para morar é exceção: só ofereça se o cliente pedir pronto ou precisar mudar logo. Ao apresentar, fale a condição com naturalidade (ex.: "esse dá pra entrar com 10 mil de sinal e parcelas de 1.500"); não fale "avaliação" nem "desconto" em número e não mande a tabela. Continua valendo UM imóvel por vez.
- RESPOSTAS CONFIRMADAS PELO DJHONATA (13/11/2026): (a) documentação (imposto de transmissão, cartório, fundo de reaparelhamento da Justiça e engenharia da Caixa) fica em torno de 3% do valor do imóvel, e dá para parcelar no cartão, no cartório; (b) carro entra no negócio pela tabela FIPE, com base em 80% do valor da tabela; (c) a gente costuma trabalhar a partir de uns R$ 4 mil de renda familiar. Pode dizer essas três coisas. Terreno do cliente como parte do pagamento: NÃO diga percentual nem valor (isso depende da avaliação); diga que você vai avaliar e já fala o valor. QUANDO VOCÊ NÃO SOUBER UMA RESPOSTA: você é o Djhonata, então fale em primeira pessoa, uma vez: "vou confirmar isso e já te falo". Nunca diga que vai confirmar "com o Djhonata", "com o corretor", "com a equipe", "com o setor" nem "no sistema", e não se comporte como assistente ou atendente de alguém. Na mesma hora use avisar_djhonata com a pergunta exata do cliente e o imóvel. Quando a resposta chegar (pelo Djhonata ou porque a ficha foi atualizada), VOLTE ao cliente com ela, sem esperar ele perguntar de novo.
- GEOGRAFIA DE JOINVILLE (regra do Djhonata, 12/11/2026, vale acima de qualquer outra): informação errada de localização faz o cliente perder a viagem e a confiança. Você só pode dizer que um imóvel ou bairro fica "perto", "pertinho", "ao lado", "colado" ou "na região" de outro bairro ou lugar em dois casos: (a) os dois bairros aparecem juntos na tabela BAIRROS PERTO, no fim destas instruções; ou (b) a ferramenta distancia devolveu até 10 minutos de carro. Fora disso, nunca use essas palavras: diga o tempo real que a ferramenta devolveu ("fica a uns 25 minutos de carro do Aventureiro"). Antes de afirmar qualquer coisa sobre distância entre um imóvel e um lugar, chame a ferramenta distancia. Quando o cliente disser onde trabalha, estuda ou mora (ex.: "trabalho no Hospital Regional", "na Tupy", "moro no Jardim Paraíso"), chame imoveis_perto com esse lugar, ofereça os mais próximos que caibam no que ele pediu e diga o tempo de carro. Sobre o que tem perto de um imóvel (escola, mercado, posto de saúde, ônibus), use só o que vier em "PERTO DESTE IMÓVEL" na ficha; se não vier nada, diga que vai confirmar. Nunca invente distância, tempo de trajeto ou ponto de referência, nem em áudio.
- O Djhonata acompanha as conversas por um painel e às vezes escreve direto para o cliente. As mensagens dele aparecem no histórico como "(Djhonata escreveu)"; as que você mandou a pedido dele, como "(mensagem a pedido do Djhonata)". Continue a conversa a partir disso: não repita o que ele já mandou, não contradiga e não se apresente de novo.`;

// Pacote de 12/11/2026: a assistente passa a saber quem é o cliente antes de responder.
// jaFalouCom: este WhatsApp já mandou mensagem para o cliente (assistente, follow-up, celular ou painel)? -> não é primeiro contato.
function jaFalouCom(jid) {
  try { const l = lerEsp(jid).filter(e => e.autor !== 'cliente' && (String(e.texto || '').trim() || e.tipo !== 'text')); return l.length ? { n: l.length, ts: l[l.length - 1].ts || 0, texto: String(l[l.length - 1].texto || '').replace(/\s+/g, ' ').slice(0, 220), followup: !!l[l.length - 1].followup } : null; } catch (e) { return null; }
}
// Pergunta em aberto (pedido do Djhonata, 13/11/2026, conversa do final 4424): a nossa última mensagem (até 40 min atrás) terminou com pergunta ou convite
// e o cliente escreveu de novo. Se ele não respondeu a ela, a assistente não pergunta outra vez nem oferece outros horários: duas perguntas seguidas travam o cliente.
function perguntaAberta(jid) {
  try {
    const l = lerEsp(jid).filter(e => e.autor !== 'aviso' && String(e.texto || '').trim());
    let i = l.length - 1; while (i >= 0 && l[i].autor === 'cliente') i--;
    if (i < 0 || i === l.length - 1) return null;   // não há mensagem nossa antes, ou o cliente não escreveu depois dela
    const m = l[i], idade = Date.now() - (m.ts || 0); if (idade > 40 * 60e3) return null;
    const tx = String(m.texto || '').replace(/\s+/g, ' ').trim(), q = tx.lastIndexOf('?'); if (q < 0 || q < tx.length - 220) return null;
    let ini = Math.max(0, q - 220); if (ini > 0) { const b = tx.slice(ini, q).search(/[.!?]\s/); if (b >= 0) ini += b + 2; }   // começa numa frase inteira
    return { frase: tx.slice(ini, q + 1).trim(), min: Math.max(1, Math.round(idade / 60e3)) };
  } catch (e) { return null; }
}
const primeiroNome = (s) => (semAcento(s).replace(/[^a-z ]/g, ' ').trim().split(/\s+/)[0] || '');
function nomeDoCrm(jid) { const t8 = tel8Chat(jid), n = t8 ? String((estado.crmNomes || {})[t8] || '').trim() : ''; return n && primeiroNome(n).length >= 2 && !/^(sem nome|cliente|lead|contato|whatsapp)\b/i.test(semAcento(n)) ? n : ''; }
const CRM_ETAPA = {
  negociacao: 'CRM: o card deste cliente está em "Em negociação": ele já esteve no escritório com o Djhonata ou já recebeu proposta. Não é lead novo.',
  novo: 'CRM: o card deste cliente está em "Remarcar visita": ele já teve visita marcada e não veio, ou pediu para remarcar. Não é lead novo.',
  perdido: 'CRM: o card deste cliente estava em "Perdido" (tinha parado de responder) e ele voltou a falar. Não é lead novo.'
};
function crmContexto(ctx, jaFalou) {
  let s = '';
  const nome = nomeDoCrm(ctx.jid);
  if (nome && primeiroNome(nome) !== primeiroNome(ctx.nome)) s += `\nNOME: no card do CRM este cliente se chama ${nome}. Chame por esse nome${ctx.nome ? ` (o nome que aparece no WhatsApp, "${String(ctx.nome).slice(0, 40)}", pode ser apelido, empresa ou outra pessoa)` : ''} e não pergunte o nome.`;
  const st = (estado.crmStatus || {})[tel8Chat(ctx.jid)] || '';
  if (CRM_ETAPA[st]) s += '\n' + CRM_ETAPA[st];
  if (jaFalou) s += `\nJÁ SE APRESENTOU: este cliente já recebeu ${jaFalou.n} mensagem(ns) deste WhatsApp; a última foi em ${quandoFoi(jaFalou.ts)}${jaFalou.texto ? `: "${jaFalou.texto}"` : ''}. NÃO se apresente de novo ("Aqui é o Djhonata...") e não pergunte o nome nem o bairro como se fosse o primeiro contato: ele está respondendo a essa conversa, continue a partir dela${jaFalou.followup ? ' (a última mensagem foi um follow-up seu: é sobre ela que ele está falando)' : ''}.`;
  return s;
}
function sistema(ctx) {
  const partes = [ADAPTADOR];
  for (const f of ARQS_REGRAS) {
    let t = lerTexto(f);
    if (f === 'AGENTS.md') t = t.replace(/<!--\s*REGRAS-FIM\s*-->[\s\S]*$/, '');   // a lista de números "não atender" já é bloqueada pelo servidor
    if (t) partes.push(`\n\n===== ${f} =====\n${t}`);
  }
  partes.push('\n\n===== BAIRROS PERTO (Joinville; só estes pares podem ser chamados de "perto") =====\n' + geoTabelaTexto() + '\nSe dois bairros não aparecem juntos numa linha, NÃO são perto: use a ferramenta distancia e diga o tempo.');
  const oferta = ofertaTabelaTexto();
  if (oferta) partes.push('\n\n===== CONDIÇÃO DE COMPRA (imóveis na planta, por bairro, do MELHOR para o pior; regra OFERTA CERTA) =====\nConta feita das fichas, com o fluxo padrão (sinal de R$ 10 mil, parcelas de R$ 1.500 até 3 meses depois da entrega e reforço de R$ 5 mil em cada dezembro; "sobra na entrega" é o que fica para pagar na entrega das chaves). O primeiro de cada bairro é o de melhor condição de compra: o que deixa menos para a entrega das chaves. Serve para você ESCOLHER o que oferecer; não mande esta tabela ao cliente e não fale de avaliação nem de desconto.\n' + oferta);
  const fixo = partes.join('');
  const d = agoraSP();
  const dia = d.toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric' });
  const hora = d.toTimeString().slice(0, 5);
  let din = `Agora: ${dia}, ${hora} (horário de Joinville).\nConversa com: ${ctx.nome || 'nome não informado'} — WhatsApp ${ctx.telefone ? formatoBR(ctx.telefone) : 'desconhecido'}.`;
  din += `\nRegra de segurança do número: escreva cada resposta com suas palavras para este cliente; não copie textos prontos idênticos aos de outras conversas (varie saudação e frases). Mensagens curtas, uma ideia por mensagem, sem excesso de links.`;
  if (!ELEVEN_KEY) din += `\nÁudio com a voz do Djhonata: indisponível agora. Responda só em texto (não use [[tts:...]]).`;
  else if (!ctx.dono) {
    const pref = (estado.prefAudio || {})[ctx.jid] || 0;
    if (pref < 0) din += `\nEste cliente pediu para não receber áudio: responda só em texto.`;
    else if (pref > 0) din += `\nEste cliente pediu para conversar por ÁUDIO: responda em áudio ([[tts:...]]) sempre que for explicar algo; texto só para link, endereço, valores para conferir ou confirmação curta.`;
    else if (ctx.audioAgora) din += `\nO cliente mandou ÁUDIO agora: responda em ÁUDIO ([[tts:...]]). No áudio, fale o nome por extenso em vez da sigla ("Fundo de Garantia", não "FGTS"; "imposto de transmissão", não "ITBI"). Decisão do Djhonata em 12/11/2026, que vale acima da parte "pergunta rápida vai em texto" da regra ÁUDIO OU TEXTO: explicação vai em áudio e pergunta também ("qual bairro vocês preferem?", "quanto você consegue dar de sinal?"). Em texto fica só a confirmação curta, de uma linha ("Combinado!", "Fechado ✅"), e o que é para conferir ou tocar: link, endereço, valores, o bloco da simulação e a legenda do imóvel, sempre em mensagem de texto separada, depois do áudio.`;
  }
  if (ctx.dono) {
    din += `\nATENÇÃO: quem está escrevendo é o próprio Djhonata (dono), pelo WhatsApp pessoal dele. Ele NÃO é cliente: não se apresente, não mande agenda, material nem endereço para ele.
Siga a seção 13 do AGENTS.md: quando ele der uma orientação sobre um cliente (ex.: "fala pra ele que aposentado também pode"), descubra de qual cliente é (o nome/número que ele citou ou, se não citou, o último aviso abaixo; na dúvida, pergunte curto: "É o Emerson (+55 47 9991-5821)?"), use a ferramenta mandar_ao_cliente para mandar a mensagem ao cliente falando como o Djhonata (primeira pessoa, frases naturais, sem copiar o texto dele ao pé da letra; pode usar [[tts:...]] e ---), e depois responda a ele curto: "Feito! Mandei pro Emerson: [resumo]". Se a mensagem dele não for sobre cliente (ex.: "quem marcou hoje?"), responda direto e curto, com os dados abaixo.
Se ele mandar só um link, arquivo, contato ou nome, sem dizer o que fazer (ex.: o link de um contrato com o nome do cliente), não mande nada a cliente nenhum e não responda como se ele fosse cliente: pergunte curto o que ele quer (ex.: "Quer que eu mande esse link para o João Carlos Teixeira?") e só mande depois que ele confirmar.
Esta conversa pode ter mensagens antigas de quando ele testou a assistente fingindo ser cliente: ignore essas mensagens, ele não está esperando resposta delas. Nunca fale com o Djhonata como se ele fosse cliente.`;
    const av = (estado.avisos || []).slice(-8).reverse().map(a => `- ${new Date(a.ts).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}: ${a.nome || 'sem nome'} (${a.telefone ? formatoBR(a.telefone) : 'sem número'}) — ${String(a.texto || '').slice(0, 220)}`).join('\n');
    din += `\nÚltimos avisos que você mandou ao Djhonata (o mais recente primeiro):\n${av || '(nenhum)'}`;
    const vis = Object.entries(estado.visitas || {}).map(([j, v]) => ({ j, v, T: quandoMs(v.q) })).filter(x => x.T > Date.now() - 3600e3).sort((a, b) => a.T - b.T).slice(0, 15)
      .map(x => { const c = chatPublico(x.j); return `- ${descreverQuando(x.v.q)}: ${c.nome || 'sem nome'} (${c.telefone ? formatoBR(c.telefone) : 'sem número'})`; }).join('\n');
    din += `\nVisitas marcadas que o sistema conhece (próximas):\n${vis || '(nenhuma)'}`;
  } else {
    const comb = (estado.combinados || {})[ctx.jid];
    if (comb && comb.length) din += `\nCombinados com este cliente (orientações do Djhonata, siga):\n` + comb.map(c => '- ' + c.texto).join('\n');
    const jaFalou = jaFalouCom(ctx.jid);
    din += adsContexto(ctx.jid, !!jaFalou);
    din += crmContexto(ctx, jaFalou);
    const pa = !ctx.rotina && !ctx.dono ? perguntaAberta(ctx.jid) : null;
    if (pa) din += `\nPERGUNTA EM ABERTO: há ${pa.min} min você mandou "${pa.frase}". Se a mensagem nova do cliente responde a ela, siga em frente. Se NÃO responde (ele só continuou o assunto, desabafou ou completou o que estava dizendo), NÃO faça outra pergunta e NÃO ofereça horários de novo: responda só o ponto novo, em 1 ou 2 linhas. A pergunta que já está lá continua valendo.`;
    if (!ctx.dono) din += `\nNão comece a resposta repetindo ou resumindo o que o cliente acabou de dizer ("Entendo, vocês querem sair do aluguel..."): vá direto ao que é novo. E não explique de novo, com outras palavras, o que você já explicou na mensagem anterior.`;
    const rt = (estado.retornos || {})[ctx.jid];
    if (rt && quandoMs(rt.q) > Date.now()) din += `\nRETORNO COMBINADO: você marcou de chamar este cliente ${descreverQuando(rt.q)}${rt.assunto ? ` (${rt.assunto})` : ''}. Se ele escrever antes, atenda normalmente.`;
    const v = (estado.visitas || {})[ctx.jid];
    if (v && quandoMs(v.q) > Date.now() - 3600e3) din += `\nVisita marcada deste cliente: ${descreverQuando(v.q)}, no escritório.`;
    const ag = agendaEnviadaEm(ctx.jid);
    if (ag && Date.now() - ag <= AGENDA_VALE) {
      if (ctx.rotina === 'retomada' && Date.now() - ag > 24 * 3600e3) din += `\nAGENDA: você mandou a agenda para este cliente em ${quandoFoi(ag)}. Nesta retomada, se convidar para vir ao escritório tirar as dúvidas, pode mandar a agenda de novo.`;
      else din += `\nAGENDA: você já mandou a agenda para este cliente em ${quandoFoi(ag)}. Não mande de novo: quando for convidar, pergunte o dia e o horário que fica bom e marque você mesma com agenda_visita (ele também pode marcar pelo link que você já passou). Só mande a agenda de novo se ele pedir (não achou o link, quer remarcar).`;
    }
  }
  return [{ type: 'text', text: fixo, cache_control: { type: 'ephemeral' } }, { type: 'text', text: din }];
}

// ---------- ferramentas ----------
const FERRAMENTAS = [
  { name: 'ler_ficha', description: 'Lê a ficha de um imóvel do catálogo (descrição pronta do CRM, dados e lista de fotos e vídeo). Use a ref (ex.: "913") ou parte do nome da rua/residencial.', input_schema: { type: 'object', properties: { busca: { type: 'string' } }, required: ['busca'] } },
  { name: 'enviar_arquivo', description: 'Envia ao cliente uma foto, um vídeo ou um PDF (planta ou projeto) do catálogo (caminho relativo à pasta do catálogo) ou uma imagem por link https. A legenda vai junto com a mídia. Só foto, vídeo e PDF: a ficha do imóvel (ficha.md) e os outros arquivos de texto são internos e nunca vão para o cliente.', input_schema: { type: 'object', properties: { caminho: { type: 'string' }, legenda: { type: 'string' } }, required: ['caminho'] } },
  { name: 'simular_fluxo', description: 'Monta a simulação do pagamento de um imóvel e devolve o texto pronto para mandar ao cliente, por texto, do jeito que veio. O financiamento já sai calculado do jeito mais atrativo para o cliente (avaliação do banco ou preço, o que for maior; não fale da avaliação ao cliente) e a parcela do financiamento sai como estimativa pela faixa de preço do imóvel (nunca pela renda). Sem os números dele, monta o FLUXO PADRÃO: sinal de R$ 10 mil, parcelas de R$ 1.500 por mês até 3 meses depois da entrega, reforço de R$ 5 mil em cada dezembro e o que sobrar na entrega das chaves. Chame assim na PRIMEIRA vez (só imovel), sem perguntar nada antes. Depois mude SÓ o que o cliente falar: imovel = ref (ex.: "832") ou parte do nome da rua/residencial. sinal = quanto ele dá na assinatura. parcela = quanto ele consegue pagar por mês (vale para as parcelas da entrada e para o pós-chaves). balao = valor do reforço de cada dezembro (0 quando ele disser que não consegue reforço no fim do ano). reforco = quanto o cliente DISSE que consegue dar na entrega das chaves, em reais (0 quando ele disser que não consegue nada na entrega). pos_chaves = máximo de parcelas mensais DEPOIS da entrega para o que faltar (mande 36; a ferramenta usa só as parcelas que precisar, no valor de parcela dele; se sobrar menos que uma parcela, esse resto fica na entrega das chaves para a conta fechar): o texto já sai avisando que depende de a construtora aceitar e que se formaliza na proposta, no escritório. fgts = saldo de FGTS que ele tem hoje: mande SÓ depois que o cliente falar de FGTS. carteira = true se ele disse que trabalha de carteira assinada e quer usar o FGTS: aí o FGTS cresce até a entrega. renda = renda bruta mensal da família, só se ele informou (serve para o FGTS de quem é de carteira assinada; não muda a parcela do financiamento). completo = true só quando o cliente PEDIR a conta completa de novo (sem isso, da segunda vez em diante a ferramenta devolve só os valores para você dizer o que mudou em 1 a 3 linhas).', input_schema: { type: 'object', properties: { imovel: { type: 'string' }, sinal: { type: 'number' }, parcela: { type: 'number' }, balao: { type: 'number' }, reforco: { type: 'number' }, pos_chaves: { type: 'number' }, fgts: { type: 'number' }, carteira: { type: 'boolean' }, renda: { type: 'number' }, completo: { type: 'boolean' } }, required: ['imovel'] } },
  { name: 'avisar_djhonata', description: 'Avisa o Djhonata, só no que é essencial: visita marcada, desmarcada ou remarcada; cliente que pede para falar com uma pessoa; indicação; permuta de terreno; projeto que NÃO está na pasta do imóvel ("ENVIAR PROJETO"); cliente quente que esfriou. Dúvida de cliente que você não sabe responder também entra aqui, mas fica anotada no CRM para ele responder, sem ir para o celular dele. Não use para contar o que você ofereceu nem como a conversa está indo. O cliente não vê e não fica sabendo desse aviso: com ele você continua falando em primeira pessoa, como o próprio Djhonata (ex.: "vou confirmar isso e já te falo"), nunca "pedi para o Djhonata".', input_schema: { type: 'object', properties: { texto: { type: 'string' } }, required: ['texto'] } },
  { name: 'agenda_visita', description: 'Agenda do escritório. acao = "consultar" devolve os horários livres de um dia (mande data AAAA-MM-DD); acao = "marcar" marca a visita do cliente atual (mande data AAAA-MM-DD, hora HH:00 e, se o cliente disse, o nome dele). A agenda é de hora em hora. Use sempre que o cliente disser um dia ou um horário para vir: consulte antes de confirmar e, estando livre, marque. Se a ferramenta disser que não está livre, ofereça os horários que ela devolver. Ela já registra a visita no CRM e liga os lembretes: não chame registrar_crm para isso.', input_schema: { type: 'object', properties: { acao: { type: 'string' }, data: { type: 'string' }, hora: { type: 'string' }, nome: { type: 'string' } }, required: ['acao'] } },
  { name: 'registrar_crm', description: 'Registra no CRM um evento do cliente atual e move o card dele: novoStatus = atendimento, visita_marcada, remarcar, sem_interesse ou pausado ("em negociação" NÃO é com você: só o Djhonata move para lá, depois que o cliente vem ao escritório; cliente negociando valores pelo WhatsApp continua em atendimento). Em visita_marcada mande data (AAAA-MM-DD) e hora (HH:MM): o sistema usa para os lembretes da visita. Se o cliente cancelar ou pedir para remarcar, use remarcar (os lembretes param). Mande nomeReal quando o cliente disser o nome e imovel quando souber qual imóvel interessa. resultado = frase curta do que aconteceu.', input_schema: { type: 'object', properties: { novoStatus: { type: 'string' }, data: { type: 'string' }, hora: { type: 'string' }, nomeReal: { type: 'string' }, imovel: { type: 'string' }, resumo: { type: 'string' }, resultado: { type: 'string' } } } },
  { name: 'agendar_retorno', description: 'Marca para VOCÊ chamar o cliente de volta num dia e horário combinados. Use quando o cliente disser que fala depois e der uma hora ou um dia (ex.: "falo contigo depois das 14h30", "me chama amanhã cedo", "só consigo à noite"). Use TAMBÉM quando ele disser que vai conversar com a esposa, o marido, o namorado ou a família, ou que vai pensar e te retorna, sem dar hora: aí é VOCÊ que propõe o retorno ("Te chamo amanhã no fim da tarde pra saber o que ela achou, pode ser?") e marca na mesma hora para esse dia e horário (amanhã às 17:00; se amanhã for domingo, segunda às 10:00), sem esperar ele confirmar. quando = AAAA-MM-DD HH:MM no horário de Joinville (se ele disse "depois das 14h30", use 14:40; "amanhã cedo" = 09:00; "à noite" = 19:00). assunto = uma linha com o que ficou combinado e de onde retomar (ex.: "ver opções perto do Jardim Paraíso"). Depois de marcar, responda ao cliente em uma linha que você chama nessa hora (ex.: "Combinado, te chamo às 14h40"). Não use para visita ao escritório (isso é agenda_visita).', input_schema: { type: 'object', properties: { quando: { type: 'string' }, assunto: { type: 'string' } }, required: ['quando'] } },
  { name: 'distancia', description: 'Tempo de carro e distância entre um imóvel do catálogo e um lugar de Joinville que o cliente citou (trabalho, escola, casa atual, outro bairro). Use SEMPRE antes de dizer que um imóvel fica perto ou longe de algum lugar. imovel = ref (ex.: "913") ou parte do nome da rua/residencial. lugar = o nome do lugar ou do bairro, como o cliente falou (ex.: "Hospital Regional", "Tupy", "Aventureiro").', input_schema: { type: 'object', properties: { imovel: { type: 'string' }, lugar: { type: 'string' } }, required: ['imovel', 'lugar'] } },
  { name: 'imoveis_perto', description: 'Lista os imóveis do catálogo mais próximos de um lugar de Joinville, com o tempo de carro de cada um. Use quando o cliente disser onde trabalha, estuda ou mora, para oferecer o que fica mais perto dali. lugar = o nome do lugar ou do bairro, como ele falou.', input_schema: { type: 'object', properties: { lugar: { type: 'string' } }, required: ['lugar'] } },
];
// Só quando quem escreve é o Djhonata (WhatsApp pessoal, modo teste desligado): seção 13 do AGENTS.md
const FERRAMENTA_DONO = { name: 'mandar_ao_cliente', description: 'Manda uma mensagem a um cliente a pedido do Djhonata, falando como o Djhonata. cliente = nome ou telefone do cliente, como o Djhonata citou (ou o do último aviso). texto = a mensagem para o cliente (pode ter [[tts:...]] para áudio e linhas com --- para separar mensagens). combinado = resumo curto da orientação do Djhonata sobre esse cliente, para seguir nas próximas conversas com ele.', input_schema: { type: 'object', properties: { cliente: { type: 'string' }, texto: { type: 'string' }, combinado: { type: 'string' } }, required: ['cliente', 'texto'] } };

function pastasImoveis() {
  try { return fs.readdirSync(CATALOGO, { withFileTypes: true }).filter(d => d.isDirectory() && !d.name.startsWith('_')).map(d => d.name); } catch (e) { return []; }
}
function semAcento(s) { return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase(); }
function acharPasta(busca) {
  const b = semAcento(busca).trim();
  const ps = pastasImoveis();
  const ref = /(\d{2,4})/.exec(b);
  if (ref) { const p = ps.find(n => new RegExp(`\\(ref ${ref[1]}\\)`).test(n)); if (p) return p; }
  const porNome = b && ps.find(n => semAcento(n).includes(b)); if (porNome) return porNome;
  // pasta sem "(ref N)" no nome (ex.: Residencial Alira = "rua witmarsum - comasa"): procura pela referência e pelo título da ficha
  for (const n of ps) {
    const t = semAcento(lerTexto(path.join(n, 'ficha.md')).slice(0, 800)), tit = (/^#\s*(.+)$/m.exec(t) || [])[1] || '';
    if ((ref && new RegExp(`referencia no sistema:\\s*${ref[1]}\\b`).test(t)) || (b.length >= 4 && tit.includes(b))) return n;
  }
  return null;
}
const EXT_IMG = /\.(jpe?g|png|webp)$/i, EXT_VID = /\.(mp4)$/i;
// ---------- simulação do pagamento (o Djhonata pediu: a assistente monta e manda sozinha, 10/11/2026) ----------
// Financiamento = 80% do que for mais atrativo para o cliente: a avaliação do banco, quando está acima do preço; senão, o próprio
// preço (sem falar da avaliação ao cliente). Avaliação: a anotada na ficha; se não tiver, a sugestão do CRM (menor área × o m² da
// tabela pela entrega, de R$ 6.300 a R$ 7.500), no máximo 15% acima do preço e redonda para baixo no milhar. Construtora que "não aceita avaliação superior": vale o preço. O resto da entrada: sinal, parcelas até a entrega, FGTS (o de hoje mais o que
// entra até a entrega, cerca de 1/12 da renda por mês, para quem é de carteira assinada) e reforços, o último na entrega das chaves.
const SIM_BLOCO_VALE = 7 * 864e5;                              // por 7 dias o bloco completo de um imóvel não é reenviado na mesma conversa (só se o cliente pedir)
const brl = (v) => 'R$ ' + (Math.round((Number(v) || 0) * 100) / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const MESES_CURTOS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const M2_AVALIACAO = 6300, AVAL_MAX_ACIMA = 0.15, MESES_DEPOIS_ENTREGA = 3;   // m² base, teto da avaliação estimada (15% acima do preço) e parcelas da entrada até 3 meses depois da entrega
function valorBR(s) {   // "430.000,00" | "305.000" | "580 mil" -> número
  s = String(s || '').trim();
  const mil = /^(\d+(?:[.,]\d+)?)\s*mil$/i.exec(s); if (mil) return Math.round(parseFloat(mil[1].replace(',', '.')) * 1000);
  const m = /^(\d{1,3}(?:\.\d{3})+|\d+)(?:,(\d{1,2}))?$/.exec(s);
  return m ? Number(m[1].replace(/\./g, '')) + (m[2] ? Number(m[2].padEnd(2, '0')) / 100 : 0) : 0;
}
const numArea = (s) => /^\d{1,3}(\.\d{3})+(,\d+)?$/.test(s) ? parseFloat(s.replace(/\./g, '').replace(',', '.')) : parseFloat(String(s).replace(',', '.'));
function avaliacaoDaFicha(t, preco) {   // valor anotado na ficha ("avaliação CEF R$ 430.000,00", "580 mil avaliação caixa", tabela "VALOR AVALIADO")
  const ok = (v) => v > 0 && (!preco || (v >= preco * 0.5 && v <= preco * 2));
  let m = /avalia[çc][ãa]o[^\d\n]{0,25}?(\d{1,3}(?:\.\d{3})+(?:,\d{2})?|\d+(?:[.,]\d+)?\s*mil\b)/i.exec(t);
  if (m && ok(valorBR(m[1]))) return valorBR(m[1]);
  m = /(\d{2,4}(?:[.,]\d+)?)\s*mil\s+(?:de\s+)?avalia[çc][ãa]o/i.exec(t);
  if (m && ok(valorBR(m[1] + ' mil'))) return valorBR(m[1] + ' mil');
  if (preco && /valor avaliado/i.test(t)) {   // tabela por unidade: a linha com o preço da ficha
    for (const l of t.split(/\n|;/)) {
      const v = [...l.matchAll(/R\$\s*([\d.]+(?:,\d{2})?)/g)].map(x => valorBR(x[1]));
      if (v.length >= 2 && Math.abs(v[0] - preco) < 1 && ok(v[1])) return v[1];
    }
  }
  return 0;
}
function dadosDaFicha(pasta) {
  const t = lerTexto(path.join(pasta, 'ficha.md')).replace(/\r/g, '');
  const nome = (/^#\s*(.+)$/m.exec(t) || [])[1] || pasta;
  const pm = /-\s*Preço:\s*R\$\s*([\d.]+)(?:,(\d{2}))?/i.exec(t);
  const preco = pm ? Number(pm[1].replace(/\./g, '')) + (pm[2] ? Number(pm[2]) / 100 : 0) : 0;
  const em = /-\s*Entrega:\s*([^\n]+)/i.exec(t), ent = em ? em[1].trim() : '';
  const d = /(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(ent);
  const am = /-\s*[ÁA]rea:\s*([^\n]+)/i.exec(t);
  const areas = am ? [...am[1].matchAll(/(\d{1,3}(?:\.\d{3})+(?:,\d+)?|\d+(?:[.,]\d+)?)\s*m²/g)].map(x => numArea(x[1])).filter(v => v > 0) : [];
  const tipo = (/-\s*Tipo[^:\n]*:\s*([^\n]+)/i.exec(t) || [])[1] || '';
  const constr = ((/-\s*Tipo de constru[çc][ãa]o:\s*([^\n]+)/i.exec(t) || [])[1] || '').trim();   // "Geminado sobrado", "Apartamento", "Geminado térreo"...
  return {
    nome: nome.replace(/\s+—\s+/, ' – ').trim(), preco, entrega: d ? { mes: Number(d[2]), ano: Number(d[3]) } : null, pronto: /pronto/i.test(ent) || (!d && /entregue|pronto/i.test(t)),
    area: areas.length ? Math.min(...areas) : 0, terreno: /terreno|\blote\b/i.test(tipo), tipo: (/^[^\[]/.test(constr) ? constr : tipo).split(/[,(]/)[0].trim().toLowerCase().slice(0, 30),
    aval: avaliacaoDaFicha(t, preco), naoAceitaSuperior: /n[aã]o aceita avalia[çc][ãa]o superior/i.test(t)
  };
}
// m² de avaliação pela entrega (tabela do Djhonata, 13/11/2026: o imóvel vale mais lá na frente): pronto ou até junho de 2027 = 6.300;
// julho a dezembro de 2027 = 6.600; 2028 = 7.000; 2029 em diante = 7.500.
function m2Avaliacao(f) {
  const e = f && f.entrega; if (!e || f.pronto || e.ano < 2027) return M2_AVALIACAO;
  if (e.ano === 2027) return e.mes <= 6 ? 6300 : 6600;
  return e.ano === 2028 ? 7000 : 7500;
}
function avaliacaoUsada(f) {   // o que for mais atrativo para o cliente (regra do Djhonata, 10/11/2026): a avaliação quando está acima do preço; senão, o próprio preço
  let av = f.aval || (f.area > 0 && !f.terreno ? Math.min(f.area * m2Avaliacao(f), f.preco * (1 + AVAL_MAX_ACIMA)) : 0);   // a da ficha vale como está; a estimada, no máximo 15% acima do preço
  if (f.naoAceitaSuperior || !(av > f.preco)) return f.preco;   // ex.: Residencial Itália (ref 947), preço acima da avaliação: vale o preço
  return Math.max(f.preco, Math.floor(Math.round(av) / 1000) * 1000);   // redonda para baixo no milhar (403.830 -> 403.000), para a conta não ficar quebrada
}
// Parcela do financiamento: estimativa pela faixa de preço do imóvel (tabela do Djhonata, 13/11/2026), não pela renda do cliente.
const PARCELA_FAIXAS = [[350000, 1700], [400000, 1800], [450000, 2200], [500000, 2600], [600000, 3000]];
function parcelaEstimada(preco) {
  const F = PARCELA_FAIXAS, v = Number(preco) || 0; let p;
  if (v <= F[0][0]) p = F[0][1] - (F[0][0] - v) * (F[1][1] - F[0][1]) / (F[1][0] - F[0][0]);
  else if (v >= F[F.length - 1][0]) p = F[F.length - 1][1] + (v - F[F.length - 1][0]) * (F[F.length - 1][1] - F[F.length - 2][1]) / (F[F.length - 1][0] - F[F.length - 2][0]);
  else { const i = F.findIndex(x => v < x[0]); p = F[i - 1][1] + (v - F[i - 1][0]) * (F[i][1] - F[i - 1][1]) / (F[i][0] - F[i - 1][0]); }
  return Math.max(1000, Math.round(p / 50) * 50);
}
function prazoDaObra(f) {   // meses até a entrega e nº de parcelas da entrada (até 3 meses depois da entrega, igual ao CRM)
  const hoje = agoraSP(); let meses = 0;
  if (f.entrega) meses = (f.entrega.ano - hoje.getFullYear()) * 12 + (f.entrega.mes - (hoje.getMonth() + 1));
  const obra = !f.pronto && meses >= 1;   // pronto: não dá para parcelar a entrada antes das chaves
  return { hoje, meses, obra, n: obra ? meses + MESES_DEPOIS_ENTREGA : 0 };
}
// Balões de fim de ano (regra do Djhonata, 13/11/2026): um reforço todo dezembro (padrão R$ 5 mil), enquanto durarem as parcelas da entrada
// (entrega + 3 meses). O dezembro do próprio ano só entra se a conversa for até julho: depois disso o cliente não tem tempo de se planejar.
// Devolve os meses (contados de hoje) de cada dezembro que vale.
const BALAO_PADRAO = 5000, BALAO_MES_LIMITE = 7;
function dezembrosDoFluxo(hoje, n) {
  const m0 = hoje.getMonth() + 1, r = [];
  for (let k = (m0 <= BALAO_MES_LIMITE ? 12 - m0 : 24 - m0); k <= n; k += 12) if (k >= 1) r.push(k);
  return r;
}
// Fluxo padrão de um imóvel na planta: sinal de 10 mil, parcelas de 1.500, balões de 5 mil em dezembro e o que sobra na entrega das chaves.
function fluxoPadrao(f) {
  const av = avaliacaoUsada(f), entrada = Math.round(f.preco - Math.min(0.8 * av, f.preco - 10000)), z = prazoDaObra(f);
  let resto = Math.max(0, entrada - 10000);
  if (!z.obra) return { entrada, obra: false, meses: z.meses, parcelas: 0, baloes: 0, naEntrega: resto };
  resto = Math.max(0, resto - 1500 * z.n);
  let baloes = 0; for (const k of dezembrosDoFluxo(z.hoje, z.n)) if (resto >= BALAO_PADRAO) { resto -= BALAO_PADRAO; baloes++; }
  return { entrada, obra: true, meses: z.meses, parcelas: z.n, baloes, naEntrega: Math.round(resto) };
}
// ---------- oferta certa (regra do Djhonata, 13/11/2026): o melhor imóvel para oferecer não é o mais barato, é o de melhor condição de compra ----------
// Condição de compra = quanto sobra para pagar na entrega das chaves no fluxo padrão (sinal de 10 mil, parcelas de 1.500 até 3 meses depois
// da entrega e balões de 5 mil em dezembro). Quanto maior o desconto (avaliação acima do preço) e mais longa a entrega, menor essa sobra.
function condicaoDeCompra(pasta) {
  const f = dadosDaFicha(pasta); if (!f.preco || f.terreno) return null;
  const x = fluxoPadrao(f);
  const e = geoEnderecoDaFicha(pasta), ib = e && e.bairro >= 0 ? e.bairro : geoBairro(pasta.replace(/\(ref.*$/, '').split(' - ').slice(1).join(' '));   // sem endereço na ficha: o bairro do nome da pasta
  const bairro = ib >= 0 ? GEOJOI.nomes[ib] : ((geo.imoveis || {})[pasta] || {}).bairro || '';
  return { pasta, nome: f.nome, ref: geoRef(pasta), tipo: f.tipo, bairro, preco: f.preco, entrada: x.entrada, obra: x.obra, meses: x.meses, parcelas: x.parcelas, baloes: x.baloes, entrega: f.entrega, naEntrega: x.naEntrega };
}
const milCurto = (v) => (Math.round(v / 100) / 10).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + ' mil';
let ofertaCache = { em: 0, chave: '', texto: '' };
function ofertaTabelaTexto() {
  const pastas = pastasImoveis(), chave = pastas.length + '|' + agoraSP().toISOString().slice(0, 7);
  if (ofertaCache.texto && ofertaCache.chave === chave && Date.now() - ofertaCache.em < 10 * 60000) return ofertaCache.texto;
  const porBairro = {};
  for (const p of pastas) {
    let c = null; try { c = condicaoDeCompra(p); } catch (e) { c = null; }
    if (!c || !c.obra) continue;   // pronto não entra: só se oferece pronto quando o cliente pede
    (porBairro[c.bairro || 'Outros'] = porBairro[c.bairro || 'Outros'] || []).push(c);
  }
  const linhas = Object.keys(porBairro).sort((a, b) => a.localeCompare(b, 'pt-BR')).map(b => {
    // menor sobra na entrega das chaves primeiro (em faixas de R$ 5 mil: diferença pequena não decide); no empate, menor entrada; depois, entrega mais longa
    const l = porBairro[b].sort((x, y) => Math.floor(x.naEntrega / 5000) - Math.floor(y.naEntrega / 5000) || x.entrada - y.entrada || y.meses - x.meses || x.preco - y.preco);
    return `${b}:\n` + l.map((c, i) => `  ${i + 1}. ${c.nome.replace(/\s+–\s+.*$/, '')}${c.ref ? ' (ref ' + c.ref + ')' : ''}${c.tipo ? ', ' + c.tipo : ''}: ${brl(c.preco).replace(/,00$/, '')} · entrega ${String(c.entrega.mes).padStart(2, '0')}/${c.entrega.ano} · entrada ${milCurto(c.entrada)} · sobra na entrega ${c.naEntrega > 0 ? milCurto(c.naEntrega) : 'nada'}`).join('\n');
  });
  const texto = linhas.length ? linhas.join('\n') : '';
  ofertaCache = { em: Date.now(), chave, texto };
  return texto;
}
function simularFluxo(e) {
  const pasta = acharPasta(String(e.imovel || ''));
  if (!pasta) return { erro: 'Imóvel não encontrado no catálogo: confira a ref no CATALOGO.md e tente de novo.' };
  const f = dadosDaFicha(pasta);
  if (!f.preco) return { erro: 'Esse imóvel está sem preço na ficha: não monte simulação; diga que o valor certinho você confirma e convide para o escritório.' };
  const num = (v, pad) => { const n = Number(v); return isFinite(n) && n > 0 ? n : pad; };
  const informado = (v) => v !== undefined && v !== null && v !== '' && isFinite(Number(v));
  const cent = (v) => Math.round(v * 100) / 100, acima = (v) => Math.ceil(v * 100 - 1e-6) / 100;
  const sinal = num(e.sinal, 10000), parcela = num(e.parcela, 1500), renda = num(e.renda, 0);
  const fgtsHoje = informado(e.fgts) ? Math.max(0, Number(e.fgts)) : 0;
  const carteira = e.carteira === true || /^(true|sim|s)$/i.test(String(e.carteira || ''));
  const av = avaliacaoUsada(f);
  const financ = Math.max(0, Math.min(cent(0.8 * av), f.preco - sinal));   // 80% da avaliação (que já vem redonda no milhar)
  const entrada = cent(f.preco - financ);                                   // o que o cliente paga fora do financiamento
  const { hoje, meses, obra, n } = prazoDaObra(f);   // parcelas da entrada: até 3 meses depois da entrega, igual ao CRM (decisão do Djhonata, 13/11/2026)
  const mesRot = (k) => { const d = new Date(hoje.getFullYear(), hoje.getMonth() + k, 1); return `${MESES_CURTOS[d.getMonth()]}/${d.getFullYear()}`; };
  const L = [`📋 *Simulação inicial – ${f.nome}*`, `💰 Valor: ${brl(f.preco)}`, ''];
  L.push(`✅ Sinal: ${brl(sinal)} na assinatura`);
  let resto = Math.max(0, cent(entrada - sinal)), q = 0, alt = '', parcelaUsada = 0, posTxt = '', falta = 0, nBal = 0, naEntrega = 0, entregaMin = false;
  const nPos = Math.min(36, Math.max(0, Math.round(num(e.pos_chaves, 0))));   // máximo de parcelas mensais depois das chaves (a conta usa só as que precisar)
  const balaoV = informado(e.balao) ? Math.max(0, Number(e.balao)) : BALAO_PADRAO;   // reforço de cada dezembro (0 = cliente não consegue)
  // Quanto o cliente disse que consegue dar na entrega das chaves. Sem isso, o que sobrar vai para lá; se pediu pós-chaves sem dizer, o pós-chaves vem antes.
  const entregaCli = informado(e.reforco) ? Math.max(0, Number(e.reforco)) : (nPos ? 0 : null);
  // Pós-chaves: cada parcela é a parcela que o cliente pode pagar (ele ainda vai ter a parcela da Caixa); usa só as parcelas inteiras que precisar.
  const posChaves = (valor) => {
    const k = Math.min(nPos, Math.floor((valor + 0.005) / parcela)); if (k < 1) return valor;
    const tot = cent(parcela * k);
    posLinha = `✅ Pós-chaves: ${k}x de ${brl(parcela)} por mês depois da entrega = ${brl(tot)}`; posTxt = `, pós-chaves ${k}x de ${brl(parcela)}`;
    return cent(valor - tot);
  };
  let posLinha = '';
  const fgtsMes = obra && carteira && renda > 0 ? renda / 12 : 0;
  const fgtsTotal = cent(fgtsHoje + fgtsMes * (obra ? meses : 0)), fgtsUsado = Math.min(fgtsTotal, resto);
  if (fgtsUsado > 0) {
    const detalhe = fgtsMes ? ` (${fgtsHoje ? `os ${brl(fgtsHoje)} de hoje + ` : ''}uns ${brl(fgtsMes)} por mês que entram até a entrega)` : '';
    L.push(`✅ FGTS${obra ? ' na entrega' : ''}: ${brl(fgtsUsado)}${detalhe}${fgtsTotal > fgtsUsado + 1 ? ' — já cobre o resto da entrada' : ''}`);
    resto = cent(resto - fgtsUsado);
  }
  if (!obra) {
    if (resto > 0 && nPos) resto = posChaves(resto);
    if (posLinha) L.push(posLinha);
    if (resto >= 1) { L.push(`✅ Complemento da entrada: ${brl(resto)} (a gente combina como fica: ${posTxt ? 'reforços depois das chaves, FGTS, subsídio, ou um carro ou moto no negócio' : 'com subsídio, FGTS, um carro ou moto no negócio, ou parcelado depois das chaves'})`); falta = resto; }
  } else if (resto > 0) {
    parcelaUsada = Math.min(parcela, acima(resto / n));   // não pede por mês mais do que precisa
    const parcelado = Math.min(resto, cent(parcelaUsada * n));
    L.push(`✅ Entrada parcelada: ${n}x de ${brl(parcelaUsada)} por mês (até ${mesRot(n)}) = ${brl(parcelado)}`);
    resto = cent(resto - parcelado);
    const parcSem = acima((entrada - sinal - fgtsUsado) / n), temResto = resto >= 1;
    // balões de fim de ano: um por dezembro, inteiro (o padrão é R$ 5 mil); o que não fecha um balão fica para a entrega das chaves
    if (balaoV >= 1) {
      const dez = dezembrosDoFluxo(hoje, n).filter(() => { if (resto + 0.005 >= balaoV) { resto = cent(resto - balaoV); return true; } return false; });
      nBal = dez.length;
      if (nBal) { const dts = dez.map(k => mesRot(k)); L.push(`✅ Reforço de fim de ano: ${nBal > 1 ? nBal + 'x de ' : ''}${brl(balaoV)} (${dts.length > 1 ? dts.slice(0, -1).join(', ') + ' e ' + dts[dts.length - 1] : dts[0]})`); }
    }
    if (resto >= 1) {
      if (entregaCli === null) { naEntrega = resto; resto = 0; }                      // padrão: o que sobra vai na entrega das chaves
      else {
        const rf = Math.min(entregaCli, resto); naEntrega = rf; resto = cent(resto - rf);
        if (resto >= 1 && nPos) resto = posChaves(resto);
        if (resto >= 1 && resto < parcela && posTxt) { naEntrega = cent(naEntrega + resto); resto = 0; entregaMin = true; }   // sobra menor que uma parcela: fica na entrega das chaves, para a conta fechar
      }
    }
    if (naEntrega >= 1) L.push(`✅ Reforço na entrega das chaves: ${brl(naEntrega)} (${mesRot(meses)})`);
    if (posLinha) L.push(posLinha);   // na ordem em que o cliente paga: entrega das chaves e, depois, as parcelas pós-chaves
    if (resto >= 1) { L.push(`✅ Falta combinar: ${brl(resto)} (${posTxt ? 'a gente vê junto como fica' : 'dá para parcelar depois das chaves'})`); falta = resto; }
    q = nBal + (naEntrega >= 1 ? 1 : 0);
    if (temResto && q && parcSem <= 3000) alt = `Sem reforço, a parcela mensal fica em ${brl(parcSem)}.`;   // só quando é uma opção de verdade (com poucos meses passa de R$ 3 mil e só confunde)
  }
  const parcFin = parcelaEstimada(f.preco);
  L.push(`🏦 Financiamento pela Caixa: ${brl(financ)}${obra ? ' (começa quando o imóvel ficar pronto)' : ''}`);
  L.push(`💵 Parcela do financiamento: em torno de ${brl(parcFin)} por mês (estimativa; o valor certo sai na aprovação da Caixa).`);
  if (alt) L.push('', alt);
  if (posTxt) L.push('', 'O pós-chaves depende de a construtora aceitar e é formalizado na proposta.');
  L.push('', 'Simulação inicial, sujeita à aprovação do banco.');
  return {
    texto: L.join('\n'),
    resumo: `${f.nome}, ${brl(f.preco)}, sinal ${brl(sinal)}${parcelaUsada ? ', parcela ' + brl(parcelaUsada) : ''}${fgtsUsado ? ', FGTS ' + brl(fgtsUsado) : ''}${nBal ? `, ${nBal} reforço(s) de fim de ano de ${brl(balaoV)}` : ''}${naEntrega >= 1 ? ', na entrega das chaves ' + brl(naEntrega) : ''}${posTxt}${falta ? ', falta combinar ' + brl(falta) : ''}, financiamento ${brl(financ)} (avaliação ${brl(av)}${f.aval ? ' da ficha' : ''})`,
    financ, entrada, renda: renda || 0, pasta, nome: f.nome, parcelas: n, falta, parcFin, baloes: nBal, naEntrega, entregaMin,
    sinalPadrao: !informado(e.sinal), acimaDoPreco: av > f.preco, temReforco: q > 0, temFgts: fgtsUsado > 0, reforcoDoCliente: informado(e.reforco), semBalao: informado(e.balao) && balaoV < 1, temPos: !!posTxt
  };
}

// ---------- oferta do imóvel: qual é o vídeo e a foto da fachada de cada pasta ----------
function pastaDoCaminho(c) {   // caminho local "pasta/arquivo" ou link do Loft ".../fotos/963/..." -> pasta do imóvel
  c = String(c || '');
  if (/^https?:\/\//i.test(c)) { const m = /\/fotos\/(\d{2,5})\//.exec(c); return m ? (pastasImoveis().find(n => n.endsWith(`(ref ${m[1]})`)) || '') : ''; }
  const rel = c.replace(/\\/g, '/').replace(/^[a-z]:\/users\/public\/catalogo\//i, '').replace(/^\/+/, '');
  const p = rel.split('/')[0];
  try { return p && !p.startsWith('_') && p !== 'escritorio' && fs.statSync(path.join(CATALOGO, p)).isDirectory() ? p : ''; } catch (e) { return ''; }
}
function midiaDaOferta(pasta) {   // { video: 'pasta/video-whatsapp.mp4' ou '', foto1: primeira foto da lista da ficha (local ou link) }
  let video = '', foto1 = '';
  try { if (fs.existsSync(path.join(CATALOGO, pasta, 'video-whatsapp.mp4'))) video = pasta + '/video-whatsapp.mp4'; } catch (e) { }
  const m = /^- Fotos[^\n]*\n((?:[ \t]+- .+\n?)+)/m.exec(lerTexto(path.join(pasta, 'ficha.md')));
  if (m) {
    const l = (m[1].split('\n').map(x => x.replace(/^[ \t]+- /, '').trim()).filter(Boolean)[0] || '');
    foto1 = /^https?:/i.test(l) ? l : l.replace(/\\/g, '/').replace(/^[a-z]:\/users\/public\/catalogo\//i, '');
  }
  if (!foto1) { try { const f = fs.readdirSync(path.join(CATALOGO, pasta)).filter(a => EXT_IMG.test(a)).sort()[0]; if (f) foto1 = pasta + '/' + f; } catch (e) { } }
  return { video, foto1 };
}
function textoRecenteCliente(jid) {   // o que o cliente mandou desde a última resposta
  const h = lerConv(jid); const t = [];
  for (let i = h.length - 1; i >= 0 && h[i].role === 'user'; i--) t.push(h[i].texto);
  return t.join(' ');
}
// Projeto ou planta do imóvel (pedido do Djhonata, 13/11/2026): quando o cliente pede a planta, o projeto vai. Arquivo de projeto = PDF da pasta, ou imagem com "projeto" ou "planta" no nome.
const EH_PROJETO = /\.pdf$|(projeto|planta)[^\\/]*\.(jpe?g|png|webp)$/i;
function projetosDaPasta(p) { try { return fs.readdirSync(path.join(CATALOGO, p)).filter(f => EH_PROJETO.test(f)).map(f => `${p}/${f}`); } catch (e) { return []; } }
function clientePediuProjeto(jid) { return /\b(plantas?|projetos?|pdf|layout)\b/i.test(textoRecenteCliente(jid)); }
function clientePediuFotos(jid) { return /\b(fotos?|imagens?)\b/i.test(textoRecenteCliente(jid)); }

// ---------- geografia de Joinville (pedido do Djhonata, 12/11/2026): bairros vizinhos, tempo de carro e o que tem perto de cada imóvel ----------
// Limites dos bairros: OpenStreetMap. Tempo de carro: OSRM, sem trânsito, com 25% de folga. "Perto" = bairros que fazem divisa ou até 10 minutos de carro.
const GEOJOI = {"fonte":"OpenStreetMap (limites dos bairros) e OSRM (tempo de carro sem trânsito), levantado em 12/11/2026","nomes":["Adhemar Garcia","América","Anita Garibaldi","Atiradores","Aventureiro","Boa Vista","Boehmerwald","Bom Retiro","Bucarein","Centro","Comasa","Costa e Silva","Dona Francisca","Espinheiros","Floresta","Fátima","Glória","Guanabara","Iririú","Itaum","Itinga","Jardim Iririú","Jardim Paraíso","Jardim Sofia","Jarivatuba","João Costa","Marinas","Morro do Meio","Nova Brasília","Paranaguamirim","Parque Guarani","Petrópolis","Pirabeiraba Centro","Profipo","Rio Bonito","Saguaçu","Santa Catarina","Santo Antônio","São Marcos","Ulysses Guimarães","Vale Verde","Vila Cubatão","Vila Nova","Zona Industrial Norte","Zona Industrial Tupy"],"centros":[[-26.32172,-48.80179],[-26.29034,-48.85358],[-26.31735,-48.85837],[-26.31016,-48.86377],[-26.23994,-48.8096],[-26.29799,-48.82243],[-26.363,-48.82895],[-26.26059,-48.84178],[-26.31466,-48.83827],[-26.30162,-48.84624],[-26.27919,-48.80162],[-26.27472,-48.88005],[-26.20107,-48.92245],[-26.28338,-48.78092],[-26.33499,-48.85303],[-26.32382,-48.81549],[-26.29635,-48.87436],[-26.32221,-48.82874],[-26.27548,-48.82372],[-26.33297,-48.82939],[-26.38303,-48.82574],[-26.26323,-48.80711],[-26.21386,-48.82247],[-26.23862,-48.8438],[-26.33287,-48.80516],[-26.34697,-48.80971],[-26.21207,-48.79827],[-26.32491,-48.90846],[-26.33906,-48.87389],[-26.34482,-48.76258],[-26.36144,-48.80592],[-26.34903,-48.83065],[-26.21295,-48.90568],[-26.3689,-48.83927],[-26.16533,-48.90827],[-26.28626,-48.83865],[-26.36711,-48.84874],[-26.26899,-48.85673],[-26.31327,-48.88411],[-26.32684,-48.79209],[-26.21624,-48.86471],[-26.21742,-48.79923],[-26.28445,-48.90571],[-26.24245,-48.86559],[-26.29262,-48.80818]],"vizinhos":[[15,24,39],[3,9,11,16,35,37],[3,8,9,14,28,38],[1,2,9,16,38],[7,18,21,26,41,43],[8,9,10,17,18,35,44],[20,30,31,33,36],[4,18,35,37,43],[2,5,9,14,17,19,35],[1,2,3,5,8,35],[5,18,21,44],[1,16,37,42,43],[32],[],[2,8,19,28,31,36,38],[0,17,19,24],[1,3,11,38,42],[5,8,15,19],[4,5,7,10,21,35],[8,14,15,17,24,25,31],[6,30,33,36],[4,10,18],[26,40,43],[40,43],[0,15,19,25,29,39],[19,24,29,30,31],[4,22,40,41,43],[28],[2,14,27,36,38],[24,25,30,39],[6,20,25,29,31],[6,14,19,25,30,36],[12,34,40,43],[6,20,36],[32,40],[1,5,7,8,9,18,37],[6,14,20,28,31,33],[1,7,11,35,43],[2,3,14,16,28,42],[0,24,29],[22,23,26,32,34,43],[4,26],[11,16,38,43],[4,7,11,22,23,26,32,37,40,42],[5,10]],"seg":[[0,784,687,755,1206,628,660,1049,453,668,818,1106,1594,960,671,256,925,401,965,369,859,947,1361,1263,232,427,1495,1174,961,682,605,552,1410,790,1949,760,861,922,1023,178,1764,1483,1192,1464,697],[808,0,329,252,823,576,777,438,354,201,751,412,972,893,592,673,231,458,435,514,980,677,954,651,736,729,1088,864,650,1206,939,634,793,860,1327,222,834,311,542,942,1147,1076,524,847,646],[685,373,0,140,1085,542,605,705,262,271,732,563,1022,875,282,551,389,351,697,391,808,861,1221,918,614,556,1356,601,388,1034,767,462,902,651,1376,491,609,509,417,819,1298,1344,620,997,612],[754,286,78,0,1008,597,674,565,331,195,787,424,991,930,360,620,250,420,620,460,877,862,1082,779,683,625,1216,612,399,1103,836,532,804,720,1345,414,678,370,335,888,1158,1204,542,858,667],[1458,846,1079,1001,0,857,1427,709,1004,916,683,885,1258,917,1249,1324,964,1109,506,1164,1630,371,344,452,1386,1379,459,1566,1400,1857,1589,1284,1010,1510,1640,679,1491,674,1274,1592,1040,447,1256,889,883],[753,410,501,506,732,0,743,675,264,308,344,731,1283,486,601,596,550,360,492,487,946,473,887,888,710,700,1022,988,775,1178,911,600,1036,826,1646,385,843,547,837,887,1390,1010,843,1089,224],[657,810,649,779,1334,756,0,1075,529,688,946,1064,1436,1088,576,534,894,450,991,397,271,1075,1489,1289,544,480,1624,1074,860,716,258,185,1316,226,1791,786,297,947,879,763,1790,1612,1034,1490,825],[1151,460,692,615,586,851,1119,0,697,585,815,499,935,958,942,1016,577,801,500,857,1322,742,624,321,1079,1071,758,1227,1013,1549,1282,977,688,1202,1318,470,1184,287,888,1285,889,746,870,566,876],[545,331,237,301,899,340,514,596,0,215,529,653,1144,672,337,411,472,196,512,251,717,658,1054,810,473,466,1188,724,510,944,676,371,957,597,1498,307,579,468,572,679,1311,1176,742,1011,409],[651,185,333,256,832,419,619,471,197,0,609,512,1072,751,442,516,330,301,444,357,822,686,987,684,579,571,1121,836,622,1049,782,477,832,702,1426,239,684,344,590,785,1187,1109,623,886,488],[1042,699,790,795,625,325,1032,630,553,597,0,918,1434,251,891,885,839,649,384,777,1235,366,780,843,999,989,914,1277,1064,1467,1200,889,1187,1115,1817,584,1133,698,1126,1176,1411,902,1132,1089,350],[1087,404,481,403,905,856,1056,437,634,481,866,0,789,1008,763,953,334,738,551,793,1259,793,943,637,1016,1008,1077,919,785,1486,1219,914,636,1095,1143,407,1054,240,582,1221,991,1065,470,690,925],[1655,993,985,957,1265,1424,1441,1001,1202,1023,1463,713,0,1605,1128,1521,788,1306,1148,1361,1601,1390,1296,880,1584,1527,1420,1158,1105,2005,1621,1433,262,1416,666,1004,1374,759,902,1789,825,1408,861,1023,1493],[1197,854,946,951,782,480,1187,787,709,753,232,1075,1592,0,1046,1041,995,805,542,932,1390,523,937,1000,1155,1145,1072,1433,1219,1623,1355,1045,1344,1270,1974,741,1288,856,1281,1331,1568,1060,1287,1246,506],[676,661,319,456,1254,690,478,947,405,511,879,775,1147,1022,0,542,605,406,866,382,643,1008,1409,1160,591,527,1543,646,430,1005,658,371,1027,453,1501,661,412,820,572,810,1532,1531,745,1314,759],[202,637,543,607,1059,481,534,902,306,521,670,958,1450,813,537,0,777,254,817,235,733,800,1214,1116,199,313,1348,1029,816,729,552,426,1263,664,1804,612,735,774,878,336,1617,1336,1048,1316,550],[899,249,278,201,989,668,868,529,446,267,858,327,778,1000,560,765,0,550,601,605,1071,843,1045,742,828,820,1179,773,581,1298,1031,726,659,892,1133,388,850,333,348,1033,1122,1167,330,821,737],[462,502,377,472,924,346,452,767,171,386,535,823,1284,678,394,305,642,0,682,197,655,664,1079,980,419,409,1213,864,650,887,620,309,1128,535,1638,477,606,639,713,596,1482,1201,882,1181,415],[1068,491,770,692,485,350,1046,344,579,535,315,633,1149,457,869,911,672,675,0,783,1249,339,640,558,1006,998,774,1263,1049,1476,1209,904,902,1129,1532,299,1111,413,983,1202,1126,762,965,803,376],[372,548,371,501,1066,488,350,813,267,410,678,870,1278,820,302,238,689,188,729,0,553,807,1221,1027,301,303,1356,838,622,779,519,208,1158,433,1632,524,504,685,706,506,1528,1344,876,1228,557],[905,1025,850,929,1549,971,312,1290,744,903,1160,1150,1522,1303,751,777,979,665,1205,611,0,1289,1704,1503,792,728,1838,1159,945,964,506,399,1402,317,1876,1000,385,1162,964,1012,1907,1826,1120,1704,1040],[1251,665,944,866,374,591,1220,519,798,709,377,807,1323,610,1043,1117,847,902,274,957,1423,0,597,704,1180,1172,731,1437,1223,1650,1383,1078,1076,1303,1706,473,1285,587,1157,1385,1293,719,1139,978,616],[1555,864,1097,1019,337,974,1524,727,1101,989,899,903,1275,1081,1346,1420,981,1205,624,1261,1727,594,0,412,1483,1476,382,1584,1417,1953,1686,1381,1028,1607,1658,796,1588,692,1292,1689,967,370,1274,906,1000],[1260,569,802,724,450,960,1229,432,807,694,925,609,885,1067,1052,1126,687,911,610,966,1432,708,415,0,1189,1181,539,1289,1123,1659,1392,1087,637,1312,1267,579,1294,397,997,1394,588,527,979,612,986],[224,768,616,746,1203,625,572,1033,450,654,815,1090,1523,957,580,253,909,398,949,298,770,944,1358,1247,0,288,1492,1103,890,627,516,429,1394,668,1878,744,739,906,952,295,1748,1480,1121,1448,694],[421,753,575,705,1250,672,512,1018,472,614,862,1074,1482,1004,506,302,893,393,933,263,715,991,1405,1231,288,0,1540,1043,826,679,503,356,1362,595,1837,728,665,890,911,533,1733,1528,1080,1432,742],[1690,999,1232,1154,443,1109,1659,862,1236,1124,1034,1038,1410,1216,1481,1555,1116,1340,759,1396,1862,729,378,536,1618,1611,0,1719,1552,2088,1821,1516,1163,1742,1793,931,1723,827,1427,1824,1124,147,1409,1041,1135],[1172,930,603,644,1569,1029,1001,1209,749,839,1219,944,1162,1362,688,1038,734,838,1210,878,1166,1348,1607,1301,1101,1043,1741,0,394,1521,1182,949,1042,977,1516,1005,935,1014,602,1306,1547,1729,574,1383,1099],[952,710,383,424,1377,809,763,989,528,619,999,758,1130,1141,450,818,567,617,990,658,928,1128,1505,1203,881,823,1640,391,0,1301,943,729,1010,738,1484,785,696,794,381,1086,1515,1628,707,1282,878],[652,1238,1061,1191,1706,1128,727,1503,953,1099,1318,1559,1967,1460,991,756,1378,878,1418,748,925,1447,1861,1717,619,692,1995,1528,1311,0,564,828,1848,869,2322,1213,940,1375,1396,628,2218,1983,1565,1917,1197],[626,970,793,923,1494,916,258,1235,689,832,1106,1239,1611,1248,724,546,1069,610,1151,481,457,1235,1649,1449,556,492,1783,1248,1035,555,0,360,1491,401,1965,946,472,1108,1054,602,1950,1771,1209,1650,985],[545,659,498,628,1183,605,189,924,378,537,794,966,1338,937,425,411,796,299,839,246,392,924,1338,1137,426,362,1472,965,749,827,370,0,1218,272,1693,634,343,796,781,672,1639,1460,936,1338,674],[1443,752,882,804,1024,1212,1412,760,990,877,1222,683,274,1364,1129,1309,767,1094,907,1149,1602,1149,1055,639,1372,1364,1179,1159,1107,1842,1575,1270,0,1417,656,763,1376,518,904,1577,584,1167,862,782,1281],[786,880,675,754,1423,845,219,1164,618,730,1035,975,1346,1177,560,652,804,539,1080,486,312,1164,1578,1378,667,603,1713,984,770,858,400,274,1227,0,1701,875,177,1036,789,906,1731,1701,945,1579,914],[1713,1063,1042,1014,1362,1482,1498,1097,1259,1080,1559,771,368,1701,1185,1579,846,1364,1244,1419,1658,1486,1392,977,1642,1585,1516,1215,1163,2063,1679,1491,358,1474,0,1100,1432,856,960,1847,863,1504,918,1120,1551],[819,274,512,434,646,588,788,388,366,277,574,479,996,716,611,685,430,470,258,525,991,500,801,601,748,740,935,1005,791,1218,951,646,748,871,1379,0,853,260,741,953,1103,923,723,802,634],[858,900,553,632,1496,917,292,1179,691,802,1107,853,1225,1250,547,724,683,612,1152,558,382,1236,1651,1393,739,675,1785,862,649,930,472,346,1105,173,1579,947,0,984,667,978,1610,1773,823,1472,987],[946,255,478,400,761,714,915,282,492,380,725,286,764,867,737,812,363,597,409,652,1118,651,799,496,874,867,933,1012,799,1345,1077,772,516,998,1146,265,979,0,673,1080,870,921,656,570,784],[1003,647,326,361,1369,860,840,926,579,556,1050,695,1067,1192,527,869,504,668,981,709,1000,1179,1442,1140,932,874,1577,597,384,1352,1021,780,947,815,1421,775,774,731,0,1137,1452,1565,644,1219,929],[181,927,831,898,1349,771,752,1193,596,812,961,1249,1737,1103,814,399,1068,544,1108,512,950,1090,1504,1406,300,532,1639,1317,1104,665,589,674,1553,894,2092,903,965,1065,1166,0,1908,1627,1335,1607,841],[1804,1113,1243,1165,1046,1532,1773,1004,1350,1238,1497,1044,832,1639,1524,1670,1127,1455,1181,1510,1976,1305,968,597,1733,1725,1136,1554,1501,2203,1936,1630,584,1812,1129,1123,1771,879,1298,1938,0,1124,1257,1143,1557],[1642,951,1184,1106,395,1061,1611,814,1188,1076,986,990,1362,1168,1433,1507,1068,1292,711,1348,1814,681,330,488,1570,1563,99,1671,1504,2040,1773,1468,1115,1694,1745,883,1675,779,1379,1776,1076,0,1361,993,1087],[1267,617,646,568,1270,1036,1122,859,814,634,1226,464,952,1368,809,1133,400,918,969,973,1282,1211,1308,1002,1196,1188,1442,528,787,1666,1302,1094,832,1097,1306,755,1056,661,553,1401,1337,1430,0,1084,1105],[1470,779,942,864,906,1170,1439,642,1017,904,1135,743,1004,1277,1224,1336,826,1121,820,1176,1642,1062,944,638,1399,1391,1079,1313,1262,1869,1602,1297,757,1522,1387,790,1504,578,1136,1604,1111,1067,1046,0,1196],[923,580,671,676,657,205,913,661,434,478,269,901,1453,411,771,766,720,530,416,657,1116,398,812,875,880,870,946,1158,944,1348,1081,770,1205,996,1816,555,1013,717,1007,1057,1443,934,1013,1120,0]]};
const GEO_PERTO_MIN = 10, GEO_FOLGA = 1.25, GEO_ARQ = path.join(DADOS, 'geo.json');
const GEO_CAB = { 'user-agent': 'euro-ponte/1.0 (atendimento imobiliario em Joinville)', accept: 'application/json' };
let geo = lerJson(GEO_ARQ, null) || { imoveis: {}, lugares: {} };
let geoUltima = 0, geoErro = '', geoRodando = false;
function geoSalvar() { try { gravarJson(GEO_ARQ, geo); } catch (e) { } }
function geoChaveBairro(s) { return semAcento(s).replace(/\bjd\.?\s/g, 'jardim ').replace(/\bpq\.?\s/g, 'parque ').replace(/\bulisses\b/, 'ulysses').replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim(); }
const GEO_IDX = {}; GEOJOI.nomes.forEach((n, i) => { GEO_IDX[geoChaveBairro(n)] = i; }); GEO_IDX['pirabeiraba'] = GEO_IDX['pirabeiraba centro'];
function geoBairro(s) {   // índice do bairro citado no texto (o nome mais longo que aparecer), ou -1
  const t = ' ' + geoChaveBairro(s) + ' '; let melhor = -1, tam = 0;
  for (const k in GEO_IDX) if (t.includes(' ' + k + ' ') && k.length > tam) { melhor = GEO_IDX[k]; tam = k.length; }
  return melhor;
}
const geoMin = (seg) => Math.max(1, Math.round(seg * GEO_FOLGA / 60));
function geoMinBairros(a, b) { return a === b ? 0 : geoMin((GEOJOI.seg[a][b] + GEOJOI.seg[b][a]) / 2); }
function geoBairrosPerto(a) {   // quem faz divisa e quem, sem fazer divisa, fica a até 10 min de carro
  const div = GEOJOI.vizinhos[a], per = [];
  GEOJOI.nomes.forEach((n, b) => { if (b !== a && !div.includes(b) && geoMinBairros(a, b) <= GEO_PERTO_MIN) per.push(b); });
  return { divisa: div.map(i => GEOJOI.nomes[i]), perto: per.sort((x, y) => geoMinBairros(a, x) - geoMinBairros(a, y)).map(i => GEOJOI.nomes[i]) };
}
function geoSaoPerto(a, b) { return a >= 0 && b >= 0 && (a === b || GEOJOI.vizinhos[a].includes(b) || geoMinBairros(a, b) <= GEO_PERTO_MIN); }
function geoTabelaTexto() {
  return GEOJOI.nomes.map((n, a) => { const p = geoBairrosPerto(a); return `- ${n}: ${p.divisa.length ? 'faz divisa com ' + p.divisa.join(', ') : 'sem divisa mapeada'}${p.perto.length ? '; até 10 min de carro: ' + p.perto.join(', ') : ''}`; }).join('\n');
}
function geoHav(a, b, c, d) { const R = 6371000, p = Math.PI / 180, x = Math.sin((c - a) * p / 2) ** 2 + Math.cos(a * p) * Math.cos(c * p) * Math.sin((d - b) * p / 2) ** 2; return Math.round(2 * R * Math.asin(Math.sqrt(x))); }
const geoDist = (m) => m >= 1000 ? String(Math.round(m / 100) / 10).replace('.', ',') + ' km' : m + ' m';
async function geoBuscar(url, opt) {   // no máximo 1 chamada por segundo (regra de uso dos serviços do OpenStreetMap)
  const espera = geoUltima + 1100 - Date.now(); if (espera > 0) await dorme(espera); geoUltima = Date.now();
  const r = await fetch(url, Object.assign({ headers: GEO_CAB, signal: AbortSignal.timeout(30000) }, opt || {}));
  if (!r.ok) throw new Error('mapa respondeu ' + r.status);
  return r.json();
}
async function geoNominatim(params) { const j = await geoBuscar('https://nominatim.openstreetmap.org/search?' + params + '&format=jsonv2&limit=3&addressdetails=1&countrycodes=br&viewbox=-49.2,-26.05,-48.65,-26.5&bounded=1'); return Array.isArray(j) ? j : []; }
function geoEnderecoDaFicha(pasta) {   // "- Endereço: Rua X, 576, Bairro" -> { rua, numero, bairro (índice), texto }
  const m = /-\s*Endere[çc]o:\s*([^\n]+)/i.exec(lerTexto(path.join(pasta, 'ficha.md'))); if (!m) return null;
  const p = m[1].split(',').map(x => x.trim()).filter(Boolean); if (!p.length) return null;
  let ib = -1; for (let i = p.length - 1; i >= 1 && ib < 0; i--) ib = geoBairro(p[i]);
  if (ib < 0) ib = geoBairro(pasta.replace(/\(ref.*$/, '').split(' - ').slice(1).join(' '));
  return { rua: p[0].replace(/\.+$/, '').trim(), numero: ((p.slice(1).find(x => /^\d{1,5}\b/.test(x)) || '').match(/^\d+/) || [''])[0], bairro: ib, texto: m[1].trim() };
}
async function geoImovel(pasta, forcar) {   // ponto do imóvel no mapa (fica guardado). aprox = só o centro do bairro, sem o endereço exato
  const g = geo.imoveis[pasta]; if (g && g.lat && !forcar) return g;
  const e = geoEnderecoDaFicha(pasta); if (!e) return null;
  const centro = e.bairro >= 0 ? GEOJOI.centros[e.bairro] : null, nomeB = e.bairro >= 0 ? GEOJOI.nomes[e.bairro] : '';
  const serve = (x) => x && x.lat && (!centro || geoHav(Number(x.lat), Number(x.lon), centro[0], centro[1]) <= 5000);
  let x = null, falhou = false;
  try {
    x = (await geoNominatim('street=' + encodeURIComponent((e.numero ? e.numero + ' ' : '') + e.rua) + '&city=Joinville&state=' + encodeURIComponent('Santa Catarina'))).find(serve);
    if (!x) x = (await geoNominatim('q=' + encodeURIComponent(e.rua + (nomeB ? ', ' + nomeB : '') + ', Joinville'))).find(serve);
  } catch (err) { geoErro = 'endereço: ' + err.message; falhou = true; }
  if (!x && !centro) return null;
  const novo = Object.assign({}, g || {}, x ? { lat: Number(x.lat), lon: Number(x.lon), aprox: false } : { lat: centro[0], lon: centro[1], aprox: true }, { bairro: nomeB, endereco: e.texto, em: Date.now() });
  if (!falhou || !g) { geo.imoveis[pasta] = novo; geoSalvar(); }   // se o mapa falhou e já havia algo guardado, não troca
  return novo;
}
const GEO_TIPOS = [   // [chave do mapa, valores, como falar, raio máximo em metros em linha reta]
  ['amenity', 'school', 'escola', 1500], ['amenity', 'kindergarten', 'creche', 1500], ['amenity', 'clinic|doctors', 'posto de saúde', 1500], ['amenity', 'hospital', 'hospital', 3000],
  ['shop', 'supermarket', 'supermercado', 2000], ['shop', 'convenience', 'mercado', 1000], ['shop', 'bakery', 'padaria', 1000], ['amenity', 'pharmacy', 'farmácia', 1500],
  ['leisure', 'park', 'praça', 1200], ['amenity', 'fuel', 'posto de combustível', 1500], ['highway', 'bus_stop', 'ponto de ônibus', 600]];
async function geoEntorno(pasta) {   // o mais próximo de cada tipo; distância a pé aproximada (linha reta + 30%, arredondada de 50 em 50 m)
  const g = await geoImovel(pasta); if (!g || g.aprox) return null;   // sem o ponto exato não dá para dizer o que tem perto
  const a = `around:1500,${g.lat},${g.lon}`;
  const q = `[out:json][timeout:40];(nwr(${a})[amenity~"^(school|kindergarten|clinic|doctors|pharmacy|fuel)$"];nwr(around:3000,${g.lat},${g.lon})[amenity=hospital];nwr(around:2000,${g.lat},${g.lon})[shop=supermarket];nwr(${a})[shop~"^(convenience|bakery)$"];nwr(${a})[leisure=park];node(around:600,${g.lat},${g.lon})[highway=bus_stop];);out center tags 300;`;
  let j = null;
  for (const base of ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter']) {
    try { j = await geoBuscar(base, { method: 'POST', headers: Object.assign({ 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8' }, GEO_CAB), body: 'data=' + encodeURIComponent(q), signal: AbortSignal.timeout(60000) }); break; } catch (e) { geoErro = 'entorno: ' + e.message; }
  }
  if (!j || !Array.isArray(j.elements)) return null;
  const itens = [];
  for (const [chave, vals, rotulo, raio] of GEO_TIPOS) {
    const re = new RegExp('^(' + vals + ')$');
    const c = j.elements.map(el => { const t = el.tags || {}, la = el.lat || (el.center || {}).lat, lo = el.lon || (el.center || {}).lon; return re.test(t[chave] || '') && la ? { nome: String(t.name || '').trim(), m: geoHav(g.lat, g.lon, la, lo) } : null; })
      .filter(x => x && x.m <= raio && (x.nome || chave === 'highway')).sort((x, y) => x.m - y.m)[0];
    if (c) itens.push({ tipo: rotulo, nome: chave === 'highway' ? '' : c.nome, m: Math.max(50, Math.round(c.m * 1.3 / 50) * 50) });
  }
  const at = geo.imoveis[pasta] || g; at.entorno = itens; at.entornoEm = Date.now(); geo.imoveis[pasta] = at; geoSalvar();
  return itens;
}
const geoItensTexto = (itens) => (itens || []).map(i => i.nome ? `${semAcento(i.nome).startsWith(semAcento(i.tipo).split(' ')[0]) ? '' : i.tipo + ' '}${i.nome} (a uns ${geoDist(i.m)})` : `${i.tipo} a uns ${geoDist(i.m)}`).join('; ');
function geoEntornoTexto(pasta) {   // só entra no atendimento o que o Djhonata aprovou (ou escreveu) no CRM
  const g = geo.imoveis[pasta]; if (!g || !g.aprovado) return '';
  return g.revisado || geoItensTexto(g.entorno);
}
async function geoLugar(texto) {   // lugar citado pelo cliente -> { nome, lat, lon, bairro, ehBairro, aprox } (guarda o que achou por 90 dias)
  const k = semAcento(texto).replace(/\s+/g, ' ').trim(); if (k.length < 3) return null;
  const guardado = geo.lugares[k]; if (guardado && Date.now() - (guardado.em || 0) < 90 * 864e5) return guardado.lat ? guardado : null;
  const semCidade = String(texto).replace(/\b(em\s+)?joinville\b|\bsc\b|\bbairro\b/ig, ' ').replace(/\s+/g, ' ').trim(), exato = GEO_IDX[geoChaveBairro(semCidade)], ib = geoBairro(semCidade);
  const centroDe = (i, aprox) => ({ nome: (aprox ? semCidade + ' (' : 'bairro ') + GEOJOI.nomes[i] + (aprox ? ', pelo centro do bairro)' : ''), lat: GEOJOI.centros[i][0], lon: GEOJOI.centros[i][1], bairro: GEOJOI.nomes[i], ehBairro: !aprox, aprox: !!aprox });
  let r = null;
  if (exato !== undefined) r = centroDe(exato, false);
  else {
    const achar = async (q) => { const x = (await geoNominatim('q=' + encodeURIComponent(q + ', Joinville')))[0]; if (!x) return null; const b = geoBairro(((x.address || {}).suburb || '') + ' ' + ((x.address || {}).neighbourhood || '') + ' ' + ((x.address || {}).city_district || '')); return { nome: String(x.display_name || q).split(',').slice(0, 2).join(',').trim(), lat: Number(x.lat), lon: Number(x.lon), bairro: b >= 0 ? GEOJOI.nomes[b] : '' }; };
    // Pacote de 12/11/2026: endereço escrito pelo cliente é limpo antes da busca (CEP, cidade, "R." -> "Rua"); se o mapa não achar
    // pelo nome, tenta uma busca que tolera erro de grafia ("Forte Atacadista" -> Fort Atacadista).
    const ehEndereco = /^\s*(r\.?|rua|av\.?|avenida|rod\.?|rodovia|estr\.?|estrada|travessa|servid[aã]o|alameda)\s+\S/i.test(semCidade) || /\b\d{5}-?\d{3}\b/.test(String(texto)), limpo = ehEndereco ? geoLimparEndereco(texto) : semCidade;
    r = await achar(limpo);
    if (!r && ehEndereco && /\s\d+\s*$/.test(limpo)) r = await achar(limpo.replace(/\s+\d+\s*$/, ''));   // sem o número
    if (!r && !/https?:\/\//i.test(limpo)) r = await geoPhoton(limpo);
    if (!r && ib >= 0) {   // "hospital regional no boa vista": tenta sem o bairro; se nem assim, vale o centro do bairro citado
      const semBairro = semAcento(semCidade).replace(geoChaveBairro(GEOJOI.nomes[ib]), ' ').replace(/\b(no|na|do|da|de|em|perto|proximo|ao|a|o)\s*$/g, ' ').replace(/\s+/g, ' ').trim();
      if (semBairro.length >= 4) r = await achar(semBairro);
      if (!r) r = centroDe(ib, true);
    }
  }
  geo.lugares[k] = Object.assign({ em: Date.now() }, r || {}); geoSalvar();
  return r;
}
function geoLimparEndereco(s) {   // "R. Tuiuti, 4157 - Aventureiro, Joinville - SC, 89226-001" -> "Rua Tuiuti 4157"
  let t = String(s || '').replace(/\b\d{5}-?\d{3}\b/g, ' ').replace(/\b(joinville|santa catarina|brasil)\b/ig, ' ').replace(/[-–,/]\s*sc\b/ig, ' ');
  t = t.replace(/^\s*r\.?\s+/i, 'Rua ').replace(/^\s*av\.?\s+/i, 'Avenida ').replace(/^\s*rod\.?\s+/i, 'Rodovia ').replace(/^\s*estr\.?\s+/i, 'Estrada ');
  return t.replace(/\s+[-–]\s+.*$/, ' ').replace(/[,\s]+/g, ' ').trim();
}
async function geoPhoton(q) {   // segunda busca, tolerante a erro de grafia; só vale resultado dentro de Joinville
  try {
    const j = await geoBuscar('https://photon.komoot.io/api/?q=' + encodeURIComponent(q + ' Joinville') + '&limit=5&bbox=-49.2,-26.5,-48.65,-26.05');
    for (const f of (j && j.features) || []) {
      const c = (f.geometry || {}).coordinates || [], pr = f.properties || {}, lat = Number(c[1]), lon = Number(c[0]);
      if (!(lat < -26.05 && lat > -26.5 && lon > -49.2 && lon < -48.65)) continue;
      const b = geoBairro([pr.district, pr.suburb, pr.locality, pr.neighbourhood].filter(Boolean).join(' '));
      return { nome: [pr.name, pr.street].filter(Boolean).slice(0, 2).join(', ') || q, lat, lon, bairro: b >= 0 ? GEOJOI.nomes[b] : '' };
    }
  } catch (e) { log('geo (busca tolerante)', e.message); }
  return null;
}
function geoRetaMin(a, b) {   // sem roteador: estima pelo trajeto em linha reta (x1,4) a 25 km/h
  const R = 6371, p = Math.PI / 180, x = Math.sin((b.lat - a.lat) * p / 2) ** 2 + Math.cos(a.lat * p) * Math.cos(b.lat * p) * Math.sin((b.lon - a.lon) * p / 2) ** 2, km = 2 * R * Math.asin(Math.sqrt(x)) * 1.4;
  return { min: Math.max(2, Math.round(km / 25 * 60)), km: Math.round(km * 10) / 10, estimado: true };
}
async function geoTempos(orig, dests) {   // tempo de carro de um ponto até vários (um pedido só ao roteador)
  const pts = [orig].concat(dests).map(p => Number(p.lon).toFixed(5) + ',' + Number(p.lat).toFixed(5)).join(';');
  const j = await geoBuscar('https://router.project-osrm.org/table/v1/driving/' + pts + '?sources=0&annotations=duration,distance');
  if (!j || j.code !== 'Ok' || !j.durations) throw new Error('roteador: ' + ((j && j.code) || 'sem resposta'));
  return dests.map((_, i) => ({ min: geoMin(j.durations[0][i + 1]), km: Math.round(((j.distances || [[]])[0][i + 1] || 0) / 100) / 10 }));
}
function geoRef(pasta) { return (/\(ref (\d+)\)/.exec(pasta) || /Refer[êe]ncia no sistema:\s*(\d+)/i.exec(lerTexto(path.join(pasta, 'ficha.md'))) || [])[1] || ''; }
async function geoRotina(max = 12) {   // aos poucos: localiza no mapa os imóveis novos e levanta o que tem perto de cada um
  if (geoRodando) return 0; geoRodando = true; let n = 0;
  try {
    for (const p of pastasImoveis()) {
      if (n >= max) break;
      const g = geo.imoveis[p];
      if (g && g.lat && !g.aprox && g.entornoEm) continue;
      if (g && g.tentativa && Date.now() - g.tentativa < 12 * 3600e3) continue;
      if (!lerTexto(path.join(p, 'ficha.md'))) continue;
      n++;
      try { const x = await geoImovel(p, !!(g && g.aprox)); if (x && !x.aprox) await geoEntorno(p); } catch (e) { geoErro = e.message; }
      geo.imoveis[p] = Object.assign(geo.imoveis[p] || {}, { tentativa: Date.now() });
    }
    if (n) { geoSalvar(); log('geografia: conferidos', n, 'imóveis; no mapa:', Object.values(geo.imoveis).filter(x => x.lat && !x.aprox).length, geoErro ? '(último erro: ' + geoErro + ')' : ''); }
  } finally { geoRodando = false; }
  return n;
}
setInterval(() => geoRotina().catch(e => log('geo', e.message)), 10 * 60e3);
setTimeout(() => geoRotina().catch(e => log('geo', e.message)), 90e3);

async function executar(nome, entrada, ctx) {
  try {
    if (nome === 'distancia') {
      const p = acharPasta(entrada.imovel || ''); if (!p) return 'Imóvel não encontrado no catálogo. Confira a ref no CATALOGO.md.';
      const NAO_SEI = 'Não consegui calcular o trajeto agora. NÃO diga que é perto nem que é longe: diga que vai confirmar o tempo de trajeto e siga o atendimento.';
      let g = null, l = null; try { g = await geoImovel(p); l = await geoLugar(entrada.lugar || ''); } catch (e) { log('geo', e.message); return NAO_SEI; }
      if (!g) return NAO_SEI;
      if (!l) return /https?:\/\//i.test(String(entrada.lugar || '')) ? 'Link de mapa não dá para abrir por aqui. Peça ao cliente o nome do lugar ou a rua e o bairro por escrito e chame de novo. Sem isso, não diga que é perto nem longe.' : `Não achei "${entrada.lugar}" no mapa de Joinville. Pergunte ao cliente em qual bairro ou rua fica e chame de novo com essa informação (pode mandar o endereço completo, do jeito que ele escrever). Sem isso, não diga que é perto nem longe.`;
      let t = null; try { t = (await geoTempos(l, [g]))[0]; } catch (e) { log('geo', e.message); }
      const d = dadosDaFicha(p), ib = geoBairro(g.bairro || ''), il = geoBairro(l.bairro || '');
      if (!t) {   // roteador fora do ar: entre bairros vale a tabela; ponto exato (rua, mercado) estima pela distância; sem nenhum dos dois, não chuta
        if (ib >= 0 && il >= 0 && (l.ehBairro || g.aprox || l.aprox)) t = { min: geoMinBairros(ib, il), km: 0, estimado: true };
        else if (g.lat && l.lat) t = geoRetaMin(g, l);
        else return NAO_SEI;
      }
      const divisa = l.ehBairro && ib >= 0 && il >= 0 && (ib === il || GEOJOI.vizinhos[ib].includes(il)), perto = t.min <= GEO_PERTO_MIN || divisa;
      log('distância', d.nome, '->', l.nome, t.min, 'min', perto ? 'perto' : 'não é perto');
      return `${d.nome} (${g.bairro || 'Joinville'}) até ${l.nome}${l.bairro && !l.ehBairro && !l.aprox ? ' (' + l.bairro + ')' : ''}: uns ${t.min} min de carro${t.km ? ', ' + String(t.km).replace('.', ',') + ' km' : ''}, fora do horário de pico${t.estimado || g.aprox || l.aprox ? ' (estimativa pelo bairro, sem o endereço exato)' : ''}. `
        + (perto ? `PODE dizer que é perto${divisa && ib !== il ? ' (os bairros fazem divisa)' : ''}, falando o tempo.` : `NÃO é perto: não use "perto", "pertinho" nem "na região". Diga o tempo real ("fica a uns ${t.min} minutos de carro") e, se fizer sentido para o cliente, veja com imoveis_perto o que existe mais próximo desse lugar.`);
    }
    if (nome === 'imoveis_perto') {
      let l = null; try { l = await geoLugar(entrada.lugar || ''); } catch (e) { log('geo', e.message); return 'Não consegui consultar o mapa agora. Pergunte o bairro do lugar e ofereça os imóveis desse bairro e dos bairros que aparecem com ele na tabela BAIRROS PERTO.'; }
      if (!l) return `Não achei "${entrada.lugar}" no mapa de Joinville. Pergunte ao cliente em qual bairro fica e use a tabela BAIRROS PERTO.`;
      const cand = pastasImoveis().map(p => ({ p, g: geo.imoveis[p] })).filter(x => x.g && x.g.lat).map(x => Object.assign(x, { reta: geoHav(l.lat, l.lon, x.g.lat, x.g.lon) })).sort((a, b) => a.reta - b.reta).slice(0, 24);
      if (!cand.length) return 'Os imóveis ainda não foram localizados no mapa. Use a tabela BAIRROS PERTO com o bairro do lugar' + (l.bairro ? ' (' + l.bairro + ')' : '') + '.';
      let tempos = null; try { tempos = await geoTempos(l, cand.map(x => x.g)); } catch (e) { log('geo', e.message); }
      const lista = cand.map((x, i) => Object.assign(x, { t: tempos ? tempos[i] : { min: geoMin(x.reta * 1.4 / 8.3), km: Math.round(x.reta * 1.4 / 100) / 10, est: true } })).sort((a, b) => a.t.min - b.t.min).slice(0, 8);
      log('imóveis perto de', l.nome, lista.slice(0, 3).map(x => x.p.slice(0, 30) + ' ' + x.t.min + 'min').join(' | '));
      return `Lugar: ${l.nome}${l.bairro && !l.ehBairro && !l.aprox ? ' (' + l.bairro + ')' : ''}. Imóveis mais próximos, por tempo de carro fora do horário de pico${tempos ? '' : ' (estimado pela distância)'}:\n`
        + lista.map(x => { const d = dadosDaFicha(x.p), r = geoRef(x.p); return `- ${d.nome}${r ? ' (ref ' + r + ')' : ''}, ${x.g.bairro || 'Joinville'}: ${x.t.min} min${x.t.km ? ' (' + String(x.t.km).replace('.', ',') + ' km)' : ''}${x.g.aprox ? ', pelo centro do bairro' : ''} · ${d.preco ? brl(d.preco) : 'preço na ficha'} · ${d.pronto ? 'pronto' : d.entrega ? 'entrega ' + String(d.entrega.mes).padStart(2, '0') + '/' + d.entrega.ano : 'entrega na ficha'}`; }).join('\n')
        + `\nOfereça só os que cabem no que o cliente pediu (valor, tipo, pronto ou em construção), começando pelo mais próximo, e diga o tempo de carro. Só chame de "perto" os de até ${GEO_PERTO_MIN} min.`;
    }
    if (nome === 'simular_fluxo') {
      const r = simularFluxo(entrada);
      if (r.erro) return r.erro;
      ctx.notas.push('[simulação montada: ' + r.resumo + ']');
      log('simulação', ctx.telefone || ctx.jid, r.resumo);
      // Memória da simulação nesta conversa (12/11/2026): o bloco completo vai UMA vez por imóvel; depois dele, uma pergunta aberta (13/11/2026) e, nos ajustes, uma pergunta por vez.
      estado.sim = estado.sim || {};
      const ms = estado.sim[ctx.jid] || (estado.sim[ctx.jid] = { blocos: {} }); ms.blocos = ms.blocos || {};
      const repetida = !entrada.completo && !!ms.blocos[r.pasta] && Date.now() - ms.blocos[r.pasta] < SIM_BLOCO_VALE;
      const porque = r.acimaDoPreco ? ' Aqui a entrada ficou menor porque o banco financia pela avaliação, que está acima do preço: se ele questionar (ex.: "não tem que dar mais de entrada?"), explique que o banco usa o valor da avaliação do imóvel e que esse imóvel a gente está vendendo abaixo do valor de mercado, por isso consegue o desconto e ele financia mais (condição que a gente tem por ter muitos anos de mercado e ser construtora). Não diga valor de avaliação.' : '';
      // Renda e parcela do financiamento (13/11/2026): a parcela é a estimativa pela faixa de preço; nada de conta pela renda.
      const avisoRenda = ` PARCELA DO FINANCIAMENTO: a que você fala é a estimativa do bloco (em torno de ${brl(r.parcFin)} por mês, pela faixa de preço do imóvel); não calcule parcela pela renda e não fale "30% da renda". NÃO diga que o financiamento "cabe na renda", "fica dentro da renda" nem que "dá para entrar": quanto a Caixa libera só sai na análise, no escritório.${r.renda > 0 && r.renda < 5000 ? ' Como a renda informada é menor que R$ 5 mil, pode perguntar se tem alguém para somar renda.' : ''}${r.temFgts ? '' : ' FGTS: não fale de FGTS agora; só se o cliente achar o fluxo pesado (aí pergunte UMA vez se ele tem FGTS para abater na entrada) ou se ele mesmo citar.'}`;
      // Depois do fluxo (decisão do Djhonata, 13/11/2026): UMA pergunta aberta; nos ajustes, mexe só no que o cliente falou, uma pergunta por vez.
      const comoAjustar = ' Se ele disser que ficou pesado, descubra O QUE pesa (a parcela, o reforço de fim de ano ou o valor na entrega das chaves) e refaça mexendo só nisso: parcela = o que ele consegue por mês; balao = 0 se não consegue reforço no fim do ano; reforco = 0 (ou o valor que consegue) e pos_chaves = 36 se não consegue o valor na entrega das chaves.';
      let depois;
      if (!repetida) depois = 'faça SÓ esta pergunta, com as suas palavras: "O que você achou desse fluxo? Se quiser, eu ajusto o sinal, a parcela ou o reforço pra ficar bom pra você." Não pergunte de renda, FGTS nem carteira assinada';
      else if (r.falta >= 1 && !r.temPos) depois = `diga que ficam faltando ${brl(r.falta)} e proponha parcelar esse valor depois das chaves (ex.: "Vamos fazer um pós-chaves então?"). Se ele topar, chame simular_fluxo de novo com os mesmos números e pos_chaves = 36 (a ferramenta usa só as parcelas que precisar)`;
      else if (r.falta >= 1) depois = `diga que ainda ficam ${brl(r.falta)} para combinar e pergunte SÓ como ele prefere acertar esse valor: um pouco mais de sinal, um reforço no fim do ano ou um valor na entrega das chaves`;
      else if (r.entregaMin) depois = `explique que, para a conta fechar, ficam ${brl(r.naEntrega)} na entrega das chaves (é o mínimo: "pelo menos ${brl(r.naEntrega)} você precisa dar na entrega das chaves") e pergunte SÓ se assim fica bom para ele`;
      else depois = 'pergunte SÓ se assim fica bom para ele';
      const fecho = ` Não fale da avaliação do banco por conta própria e não convide para o escritório por causa da simulação: só se ele mostrar interesse em fechar ou ver de perto.${comoAjustar}${avisoRenda}${porque}`;
      ms.em = Date.now(); for (const k of Object.keys(estado.sim)) if (Date.now() - (estado.sim[k].em || 0) > 30 * 864e5) delete estado.sim[k];
      salvarEstado();
      if (repetida) {
        // A linha "Sem reforço, a parcela mensal..." é OUTRA forma de pagar. Em 12/11/2026 a IA leu esse valor como "a parcela" e somou com os reforços (conta da Luana): agora vai rotulada.
        const consulta = r.texto.split('\n').map(l => /^\s*Sem reforço, a parcela mensal/i.test(l) ? '- OUTRA FORMA DE PAGAR (no lugar do reforço, NUNCA junto com ele): s' + l.trim().slice(1) : l.replace(/^\s*📋\s*\*?/, 'Conta atualizada: ').replace(/\*\s*$/, '').replace(/^\s*(💰|✅|🏦|💵)\s*/, '- ')).join('\n');
        const avisoParcela = /Sem reforço, a parcela mensal/i.test(r.texto) ? ' ATENÇÃO: a parcela mensal dele é a da linha "Entrada parcelada" e ela continua igual quando existe reforço. A linha "OUTRA FORMA DE PAGAR" é uma segunda opção (parcela maior e nenhum reforço): nunca diga esse valor como "a parcela" junto com os reforços.' : '';
        return `NÃO mande o bloco da simulação de novo: o cliente já recebeu a conta completa deste imóvel nesta conversa. Responda em 1 a 3 linhas, com as suas palavras, SÓ o que mudou em relação à conta que você já mandou (ex.: "com 40 mil de sinal a parcela cai para R$ 800 por mês"), usando os valores abaixo. Só mande a conta completa outra vez se o cliente PEDIR: nesse caso chame simular_fluxo de novo com completo = true. Depois, na mesma resposta, ${depois}.${fecho}${avisoParcela}\n\nVALORES ATUALIZADOS (só para você consultar; NÃO envie esta lista):\n${consulta}`;
      }
      ms.blocos[r.pasta] = Date.now();
      return `Mande o bloco abaixo ao cliente por TEXTO, do jeito que está, SOZINHO numa mensagem: não escreva nada antes nem depois dentro dele, porque o cliente encaminha esse bloco para a esposa, o marido ou a família junto com o vídeo do imóvel (o sistema separa o bloco numa mensagem própria). Depois, em OUTRA mensagem, curta, ${depois}.${fecho}\n\n${r.texto}`;
    }
    if (nome === 'ler_ficha') {
      const p = acharPasta(entrada.busca || '');
      if (!p) return 'Imóvel não encontrado no catálogo. Confira a ref no CATALOGO.md.';
      const ficha = lerTexto(path.join(p, 'ficha.md'));
      const arqs = fs.readdirSync(path.join(CATALOGO, p)).filter(f => EXT_IMG.test(f) || /^video-whatsapp\.mp4$/i.test(f));
      const { video, foto1 } = midiaDaOferta(p);
      const guia = video
        ? `OFERTA DESTE IMÓVEL: mande o VÍDEO "${video}" com enviar_arquivo, com a descrição pronta (seção "Descrição pronta para o WhatsApp") como legenda, numa mensagem só. Não mande fotos agora; mais fotos só se o cliente pedir.`
        : `OFERTA DESTE IMÓVEL (sem vídeo): mande a foto 1 (fachada) "${foto1 || 'primeira foto da ficha'}" com enviar_arquivo, com a descrição pronta como legenda, numa mensagem só. Mais fotos só se o cliente pedir.`;
      const ge = geoEnderecoDaFicha(p), entornoTxt = geoEntornoTexto(p), bp = ge && ge.bairro >= 0 ? geoBairrosPerto(ge.bairro) : null;
      const local = (bp ? `\nLOCALIZAÇÃO: bairro ${GEOJOI.nomes[ge.bairro]}. Faz divisa com: ${bp.divisa.join(', ') || 'nenhum mapeado'}.${bp.perto.length ? ' Até 10 min de carro: ' + bp.perto.join(', ') + '.' : ''} Só estes bairros podem ser chamados de "perto"; para qualquer outro lugar use a ferramenta distancia.` : '')
        + (entornoTxt ? `\nPERTO DESTE IMÓVEL (conferido no mapa e aprovado pelo Djhonata; distâncias aproximadas a pé): ${entornoTxt}.` : '\nPERTO DESTE IMÓVEL: ainda sem informação conferida. Se o cliente perguntar o que tem perto, diga que vai confirmar.');
      const projs = projetosDaPasta(p);
      const projTxt = projs.length
        ? `\nPROJETO NA PASTA: ${projs.join(' | ')}. Se o cliente pedir a planta ou o projeto, mande este arquivo com enviar_arquivo, com uma legenda curta, e depois convide com dois horários. Não mande sem ele pedir.`
        : `\nPROJETO: não há arquivo de projeto na pasta deste imóvel. Se o cliente pedir a planta ou o projeto, diga uma vez "Vou separar o projeto e já te mando aqui" e use avisar_djhonata com "ENVIAR PROJETO", o nome do cliente e o imóvel.`;
      const unid = /^- Unidades dispon[íi]veis:.*\d/mi.test(ficha) ? `\nPONTA OU MEIO: de ponta são a casa 1 e a de maior número do conjunto (some as disponíveis e as vendidas das anotações); as outras são de meio. Se perguntarem, responda com o número da casa e o valor.` : '';
      const fichaTxt = ficha.replace(/Se o cliente pedir, diga que vai pedir para o Djhonata enviar e mande o aviso\.?/g, 'Se o cliente pedir, siga a linha PROJETO acima.');
      return `Pasta: ${p}\n${guia}${local}${projTxt}${unid}\nArquivos de mídia na pasta: ${arqs.map(a => `${p}/${a}`).join(' | ') || 'nenhum (as fotos são os links da ficha)'}\n\n${fichaTxt}`;
    }
    if (nome === 'enviar_arquivo') {
      let caminho = String(entrada.caminho || '').replace(/^[a-z]:[\\/]+users[\\/]+public[\\/]+catalogo[\\/]+/i, ''); const legenda = entrada.legenda || '';
      // projeto ou planta (13/11/2026): vai quando o cliente pede, e não conta como a oferta do imóvel
      const ehProjeto = !/^https?:\/\//i.test(caminho) && EH_PROJETO.test(caminho);
      if (ehProjeto && !ctx.dono && !clientePediuProjeto(ctx.jid)) return 'Não enviado: o projeto só vai quando o cliente pedir a planta ou o projeto. Continue a conversa sem falar disso.';
      // regra da oferta: com vídeo vai o vídeo; sem vídeo, a foto da fachada; outras fotos só se o cliente pediu
      const pasta = ctx.dono || ehProjeto ? '' : pastaDoCaminho(caminho);
      let extra;
      if (pasta) {
        const ehVideo = EXT_VID.test(caminho.split('?')[0]);
        ctx.ofertas = ctx.ofertas || {};
        const pediuFotos = clientePediuFotos(ctx.jid);
        if (ctx.ofertas[pasta] && !ehVideo && !pediuFotos) return `Não enviado: a oferta deste imóvel já foi agora (${ctx.ofertas[pasta]} com a descrição). Mais fotos só se o cliente pedir.`;
        if (!ctx.ofertas[pasta] && !lerEsp(ctx.jid).some(m => m.oferta === pasta)) {   // primeira vez deste imóvel na conversa
          const { video, foto1 } = midiaDaOferta(pasta);
          if (!pediuFotos && !ehVideo) {
            if (video) { log('oferta: vídeo no lugar da foto', pasta); caminho = video; }
            else if (foto1 && caminho !== foto1) caminho = foto1;
          }
          ctx.ofertas[pasta] = EXT_VID.test(caminho.split('?')[0]) ? 'o vídeo' : 'a foto da fachada';
          extra = { oferta: pasta };
        }
      }
      // nunca reenvia o mesmo arquivo na conversa (a não ser que o cliente peça de novo)
      const refArq = /^https?:\/\//i.test(caminho) ? caminho : 'c/' + caminho.replace(/^[\\/]+/, '').replace(/\\/g, '/');
      if (lerEsp(ctx.jid).some(m => m.arquivo === refArq) && !/de novo|novamente|reenvi|outra vez/i.test(textoRecenteCliente(ctx.jid))) {
        if (extra) delete ctx.ofertas[pasta];
        return 'Não enviado: esse arquivo já foi enviado antes nesta conversa. Não reenvie; continue a conversa.';
      }
      const r = await enviarArquivo(ctx.jid, caminho, legenda, 'ia', extra);
      ctx.notas.push(`[enviei ${caminho}${legenda ? ' com a legenda: ' + legenda.slice(0, 300) : ''}]`);
      return caminho !== String(entrada.caminho || '') && r === 'Enviado.' ? `Enviado: ${caminho} (o vídeo/foto da oferta, com a legenda). Não mande mais fotos agora.` : r;
    }
    if (nome === 'avisar_djhonata') {
      const txt = String(entrada.texto || '').trim(); if (!txt) return 'Aviso vazio: nada enviado.';
      // 13/11/2026 (pedido do Djhonata): o WhatsApp pessoal dele só recebe o essencial. Projeto que está na pasta, ela mesma manda; dúvida de cliente fica na lista do CRM; aviso só informativo não sai.
      if (/projeto|planta/i.test(txt) && !ctx.dono) { const ult = lerEsp(ctx.jid).filter(m => m.oferta).pop(), pj = ult ? projetosDaPasta(ult.oferta) : []; if (pj.length) return `Aviso não enviado: o projeto deste imóvel está na pasta (${pj[0]}). Mande você mesmo agora, com enviar_arquivo e uma legenda curta.` + AVISO_INTERNO; }
      const tipoAv = tipoDoAviso(txt);
      estado.avisos = [...(estado.avisos || []), { id: 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), ts: Date.now(), jid: ctx.jid, nome: ctx.nome || '', telefone: ctx.telefone || '', texto: txt.slice(0, 600), tipo: tipoAv }].slice(-80); salvarEstado();
      if (tipoAv === 'info') { log('aviso só informativo: não foi para o Djhonata', ctx.jid); return 'Aviso não enviado: o Djhonata só recebe aviso de visita marcada ou desmarcada, cliente que pede para falar com uma pessoa, indicação, permuta, projeto que você não tem para mandar e cliente quente que esfriou. Continue atendendo o cliente normalmente.' + AVISO_INTERNO; }
      if (tipoAv === 'duvida') { log('dúvida de cliente anotada para o CRM', ctx.jid); return 'Dúvida anotada para o Djhonata responder pelo CRM (não foi para o celular dele). Diga ao cliente UMA vez que vai confirmar e já fala, e continue a conversa.' + AVISO_INTERNO; }
      if (estado.teste && estado.teste.ativo) {   // no teste o "cliente" é o próprio Djhonata: o aviso fica só no CRM
        registrarEspelho(ctx.jid, { id: 'av' + Date.now().toString(36), autor: 'aviso', tipo: 'text', texto: '🔔 Aviso ao Djhonata (não enviado, modo teste): ' + txt, ts: Date.now() });
        log('teste: aviso ao Djhonata ficou só no CRM');
        return 'Aviso registrado para o Djhonata. Continue atendendo o cliente normalmente.' + AVISO_INTERNO;
      }
      await enviarTexto(DONO + '@s.whatsapp.net', '🔔 ' + txt, 'aviso');
      return 'Aviso enviado ao Djhonata. Continue atendendo o cliente normalmente.' + AVISO_INTERNO;
    }
    if (nome === 'agendar_retorno') {   // pacote de 12/11/2026: o cliente disse "falo depois das 14h30" -> a assistente chama no horário combinado
      const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{1,2})[:h](\d{2})/.exec(String(entrada.quando || '').trim());
      if (!m) return 'Mande quando no formato AAAA-MM-DD HH:MM (horário de Joinville).';
      const q = `${m[1]}T${String(m[2]).padStart(2, '0')}:${m[3]}`, T = quandoMs(q), min = Number(m[2]) * 60 + Number(m[3]);
      if (!T || T < Date.now() + 5 * 60e3) return 'Esse horário já passou ou é daqui a menos de 5 minutos: não marque retorno, continue a conversa agora.';
      if (T > Date.now() + 7 * 864e5) return 'Só dá para marcar retorno para os próximos 7 dias. Combine uma data mais perto ou diga que ele pode chamar quando quiser.';
      if (min < minutos(ROT_INI) || min > minutos(ROT_FIM)) return `Você só chama clientes entre ${ROT_INI} e ${ROT_FIM}. Combine um horário dentro disso (ex.: amanhã às 09:00) e chame agendar_retorno de novo.`;
      estado.retornos = estado.retornos || {}; estado.retornos[ctx.jid] = { q, assunto: String(entrada.assunto || '').slice(0, 200), criado: Date.now() }; salvarEstado();
      log('retorno combinado', ctx.telefone || ctx.jid, q);
      return `Retorno marcado: você chama este cliente ${descreverQuando(q)}. Diga a ele, em uma linha, que você chama nessa hora. Não mande mais nada agora.`;
    }
    if (nome === 'agenda_visita') {
      const iso = (x) => x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0');
      const hh = (h) => String(h).padStart(2, '0') + ':00';
      const diaTxt = (d) => new Date(d + 'T12:00:00Z').toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: '2-digit', timeZone: 'UTC' });
      const falhou = 'Não consegui abrir a agenda agora. NÃO confirme horário: mande o link da agenda para o cliente marcar e avise o Djhonata com avisar_djhonata (cliente, dia e hora pedidos).';
      let ocup; try { ocup = await agendaOcupados(); } catch (e) { log('agenda: não abriu', e.message); return falhou; }
      const proximos = (de, n) => { const out = [], [y, mo, d] = de.split('-').map(Number); for (let i = 0; i < 21 && out.length < n; i++) { const dia = iso(new Date(y, mo - 1, d + i)), l = agendaLivres(ocup, dia); if (l.length) out.push(`${diaTxt(dia)}: ${l.map(hh).join(', ')}`); } return out.join(' | ') || 'nenhum nas próximas três semanas'; };
      const data = /^\d{4}-\d{2}-\d{2}$/.test(String(entrada.data || '')) ? String(entrada.data) : '';
      if (!data) return 'Mande a data no formato AAAA-MM-DD. Próximos horários livres: ' + proximos(iso(agoraSP()), 3) + '.';
      const livres = agendaLivres(ocup, data), marcar = /^marc/i.test(String(entrada.acao || ''));
      const opcoes = livres.length ? `Livres em ${diaTxt(data)}: ${livres.map(hh).join(', ')}.` : `Sem horário livre em ${diaTxt(data)}. Próximos livres: ${proximos(data, 3)}.`;
      if (!marcar) {
        // Pacote de 12/11/2026: para não oferecer os mesmos dois horários a todos os clientes, sugere os menos oferecidos nas últimas 24h
        // (um neste dia e outro no próximo dia com vaga). Quem marcar primeiro leva; os outros já receberam horários diferentes.
        const of = estado.ofertasAg = estado.ofertasAg || {}; for (const k of Object.keys(of)) if (Date.now() - (of[k].ts || 0) > 24 * 3600e3) delete of[k];
        const menos = (dia, l) => l.slice().sort((x, y) => (((of[dia + ' ' + x] || {}).n || 0) - ((of[dia + ' ' + y] || {}).n || 0)) || x - y)[0];
        const meus = estado.ofertasCli = estado.ofertasCli || {}; for (const k of Object.keys(meus)) if (Date.now() - (meus[k].ts || 0) > 6 * 3600e3) delete meus[k];
        const ant = ctx.jid ? meus[ctx.jid] : null;
        // 13/11/2026 (final 4424): em duas respostas seguidas ela ofereceu horários diferentes ao mesmo cliente. Enquanto ele não responde, valem os mesmos.
        if (ant && ant.sug.length === 2 && ant.sug.some(([dia]) => dia === data || data <= ant.sug[0][0]) && ant.sug.every(([dia, h]) => agendaLivres(ocup, dia).includes(h)))
          return opcoes + ` Você JÁ ofereceu a este cliente ${ant.sug.map(([dia, h]) => `${diaTxt(dia)} às ${hh(h)}`).join(' ou ')} há ${Math.max(1, Math.round((Date.now() - ant.ts) / 60e3))} min: se for citar horário, use ESSES MESMOS, não ofereça outros. Se ele ainda não respondeu a esse convite, não repita a pergunta. Se o cliente pediu outro dia ou horário e ele está livre, vale o que ele pediu. Quando o cliente escolher, chame agenda_visita com acao "marcar".`;
        const sug = [], [y0, mo0, d0] = data.split('-').map(Number);
        if (livres.length) sug.push([data, menos(data, livres)]);
        for (let i = 1; i < 14 && sug.length < 2; i++) { const dia = iso(new Date(y0, mo0 - 1, d0 + i)), l = agendaLivres(ocup, dia); if (l.length) sug.push([dia, menos(dia, l)]); }
        if (sug.length) { sug.forEach(([dia, h]) => { const k = dia + ' ' + h; of[k] = { n: ((of[k] || {}).n || 0) + 1, ts: Date.now() }; }); if (ctx.jid && sug.length === 2) meus[ctx.jid] = { sug, ts: Date.now() }; salvarEstado(); }
        const dica = sug.length === 2 ? ` Para não oferecer o mesmo horário a todos os clientes, ofereça AGORA estes dois: ${sug.map(([dia, h]) => `${diaTxt(dia)} às ${hh(h)}`).join(' ou ')}. Se o cliente pediu outro dia ou horário e ele está livre, vale o que ele pediu.` : '';
        return opcoes + dica + ' Quando o cliente escolher, chame agenda_visita com acao "marcar".';
      }
      const hm = /^(\d{1,2})(?:\s*(?:[:h]|horas?)\s*(\d{2})?)?/i.exec(String(entrada.hora || '').trim()), h = hm ? Number(hm[1]) : NaN;
      if (!hm || (hm[2] && hm[2] !== '00') || !livres.includes(h)) return `O horário pedido NÃO está livre (a agenda é de hora em hora e precisa de ${AG_ANTECEDENCIA_H} horas de antecedência). ${opcoes} Ofereça esses ao cliente e não confirme o que ele pediu.`;
      if (estado.teste && estado.teste.ativo) return `Modo teste: ${diaTxt(data)} às ${hh(h)} está livre (nada foi gravado na agenda). Confirme ao cliente normalmente.`;
      const nomeCli = String(entrada.nome || ctx.nome || 'Cliente').trim().slice(0, 60), tel = String(ctx.telefone || '').replace(/\D/g, '');
      let resp = '';
      try { const r = await fetch(`${AGENDA_HOOK}?acao=marcar&data=${data}&hora=${encodeURIComponent(hh(h))}&nome=${encodeURIComponent(nomeCli)}&whatsapp=${encodeURIComponent(tel || '0')}`, { signal: AbortSignal.timeout(20000) }); resp = (await r.text()).trim(); }
      catch (e) { log('agenda: não marcou', e.message); return falhou; }
      if (!/^ok/i.test(resp)) return `Esse horário acabou de ser ocupado. ${livres.filter(x => x !== h).length ? `Ainda livres em ${diaTxt(data)}: ${livres.filter(x => x !== h).map(hh).join(', ')}.` : `Próximos livres: ${proximos(data, 3)}.`} Ofereça esses ao cliente.`;
      guardarVisita(ctx.jid, data, hh(h), 'assistente');
      try { fs.appendFileSync(path.join(DADOS, 'eventos-crm.jsonl'), JSON.stringify(Object.assign({ rid: 'ag' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), ts: new Date().toISOString(), telefone: ctx.telefone ? formatoBR(ctx.telefone) : '', nome: ctx.nome || '', novoStatus: 'visita_marcada', data, hora: hh(h), resultado: `Visita marcada pela assistente na agenda: ${diaTxt(data)} às ${hh(h)}` }, entrada.nome ? { nomeReal: nomeCli } : {})) + '\n'); } catch (e) { }
      if (ctx.jid) aplicarEtiquetaStatus(ctx.jid, 'visita_marcada').catch(() => { });
      if (ctx.notas) ctx.notas.push(`[visita marcada na agenda: ${data} ${hh(h)}]`);
      log('agenda: visita marcada', ctx.telefone || ctx.jid, data, hh(h));
      enviarTexto(DONO + '@s.whatsapp.net', `🔔 Visita marcada pela assistente: ${nomeCli}${ctx.telefone ? ' (' + formatoBR(ctx.telefone) + ')' : ''}, ${diaTxt(data)} às ${hh(h)}.`, 'aviso').catch(() => { });
      return `Marcado na agenda: ${diaTxt(data)} às ${hh(h)}, em nome de ${nomeCli}. Confirme ao cliente o dia, a hora e o endereço (Rua Dona Francisca, 1222 - Saguaçu). Não mande o link nem peça comprovante: já está marcado.`;
    }
    if (nome === 'registrar_crm') {   // visitas: guardadas para os lembretes (também no modo teste, só para o número de teste)
      // "Em negociação" é só de quem já veio ao escritório: quem move para lá é o Djhonata, no CRM. A assistente fica em atendimento.
      if (/^negocia/i.test(String(entrada.novoStatus || ''))) { entrada.novoStatus = 'atendimento'; log('registrar_crm: a assistente pediu negociacao, ficou em atendimento'); }
      const st = String(entrada.novoStatus || '').toLowerCase();
      if (st === 'visita_marcada' && entrada.data) guardarVisita(ctx.jid, String(entrada.data), String(entrada.hora || ''), 'assistente');
      if (['remarcar', 'sem_interesse', 'pausado', 'desistiu', 'negociacao'].includes(st)) cancelarVisita(ctx.jid, st);
    }
    if (nome === 'mandar_ao_cliente') {
      if (!ctx.dono || (estado.teste && estado.teste.ativo)) return 'Só o Djhonata pode pedir isso.';
      const achados = acharCliente(entrada.cliente);
      if (!achados.length) return 'Não achei esse cliente nas conversas do WhatsApp da Euro. Pergunte ao Djhonata o número.';
      if (achados.length > 1) return 'Mais de um cliente parecido: ' + achados.slice(0, 5).map(j => { const c = chatPublico(j); return `${c.nome || 'sem nome'} (${c.telefone ? formatoBR(c.telefone) : '?'})`; }).join(', ') + '. Pergunte ao Djhonata qual é.';
      const alvo = achados[0], c = chatPublico(alvo);
      liberado24h.add(alvo);
      let feitos = [];
      try { feitos = await enviarSaida(alvo, String(entrada.texto || ''), 'ia', { ordem: true }); } finally { liberado24h.delete(alvo); }
      if (!feitos.length) return 'Não consegui mandar agora (WhatsApp desconectado ou limite de segurança). Avise o Djhonata.';
      anotar(alvo, 'assistant', '(mensagem a pedido do Djhonata) ' + feitos.join('\n'));
      if (entrada.combinado) { estado.combinados = estado.combinados || {}; estado.combinados[alvo] = [...(estado.combinados[alvo] || []), { ts: Date.now(), texto: String(entrada.combinado).slice(0, 400) }].slice(-6); salvarEstado(); }
      log('ordem do Djhonata enviada para', c.telefone || alvo);
      return `Enviado para ${c.nome || 'o cliente'} (${c.telefone ? formatoBR(c.telefone) : alvo}).`;
    }
    if (nome === 'registrar_crm' && estado.teste && estado.teste.ativo) { log('teste: registrar_crm ignorado', JSON.stringify(entrada).slice(0, 200)); return 'Registrado.'; }
    if (nome === 'registrar_crm') {
      fs.appendFileSync(path.join(DADOS, 'eventos-crm.jsonl'), JSON.stringify({ rid: 'ep' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), ts: new Date().toISOString(), telefone: ctx.telefone ? formatoBR(ctx.telefone) : '', nome: ctx.nome || '', ...entrada }) + '\n');
      if (entrada.novoStatus && ctx.jid) aplicarEtiquetaStatus(ctx.jid, entrada.novoStatus).catch(() => { });
      return 'Registrado.';
    }
    return 'Ferramenta desconhecida.';
  } catch (e) { log('erro ferramenta', nome, e.message); return 'Erro: ' + e.message; }
}

// ---------- espelho (tudo o que entra e sai, para o painel) ----------
const CHATS_F = path.join(DADOS, 'chats.json');
const chats = lerJson(CHATS_F, {});      // jid -> { nome, telefone, ult, ultTexto, naoLidas }
let salvarChatsTimer = null;
const CONTATOS_F = path.join(DADOS, 'contatos.json');
const contatos = lerJson(CONTATOS_F, {});  // jid -> nome salvo na agenda / nome do perfil
let salvarContatosTimer = null;
function salvarContatos() { clearTimeout(salvarContatosTimer); salvarContatosTimer = setTimeout(() => gravarJson(CONTATOS_F, contatos), 1500); }
const LID_F = path.join(DADOS, 'lid-telefone.json');
const lidPn = lerJson(LID_F, {});           // 1234@lid -> 5547...@s.whatsapp.net
let salvarLidTimer = null;
function ligarLid(lid, pn) {
  if (!lid || !pn || !String(lid).endsWith('@lid') || !String(pn).endsWith('@s.whatsapp.net')) return;
  lid = String(lid).replace(/:\d+@/, '@'); pn = String(pn).replace(/:\d+@/, '@');
  if (lidPn[lid] === pn) return;
  lidPn[lid] = pn; clearTimeout(salvarLidTimer); salvarLidTimer = setTimeout(() => gravarJson(LID_F, lidPn), 1500);
  const c = chats[lid]; if (c && !c.telefone) { c.telefone = pn.split('@')[0]; salvarChats(); }
}
const ETQ_F = path.join(DADOS, 'etiquetas.json');
const etq = Object.assign({ labels: {}, chats: {} }, lerJson(ETQ_F, {}));   // labels: id -> {nome, cor}; chats: jid -> [ids]
let salvarEtqTimer = null;
function salvarEtq() { clearTimeout(salvarEtqTimer); salvarEtqTimer = setTimeout(() => gravarJson(ETQ_F, etq), 1000); }
function etiquetasDe(jid) { const pn = pnDe(jid); const ids = new Set([...(etq.chats[jid] || []), ...(pn ? etq.chats[pn] || [] : [])]); return [...ids].filter(i => etq.labels[i] && !etq.labels[i].apagada).map(i => ({ id: i, nome: etq.labels[i].nome, cor: etq.labels[i].cor })); }
function pnDe(jid) { return jid && jid.endsWith('@lid') ? (lidPn[jid] || '') : jid; }
function guardarContato(c) {
  if (!c || !c.id) return;
  if (c.lid && c.id.endsWith('@s.whatsapp.net')) ligarLid(c.lid, c.id);
  if (c.id.endsWith('@lid') && (c.phoneNumber || c.jid)) ligarLid(c.id, c.phoneNumber || c.jid);
  if (c.name) contatos[c.id] = c.name; else if (!contatos[c.id] && (c.notify || c.verifiedName)) contatos[c.id] = c.notify || c.verifiedName;
  if (c.lid && contatos[c.id]) contatos[c.lid] = contatos[c.lid] || contatos[c.id];
  salvarContatos();
}
function guardarChat(ch) {
  if (!ch || !jidValido(ch.id || '')) return;
  const c = chats[ch.id] || (chats[ch.id] = {});
  if (ch.pnJid) ligarLid(ch.lidJid || ch.id, ch.pnJid);
  if (ch.lidJid && ch.id.endsWith('@s.whatsapp.net')) ligarLid(ch.lidJid, ch.id);
  if (ch.name && !c.nome) c.nome = ch.name;
  if ('archived' in ch && ch.archived != null) c.arquivado = !!ch.archived;
  const ts = (Number(ch.conversationTimestamp && (ch.conversationTimestamp.low || ch.conversationTimestamp)) || 0) * 1000;
  if (ts > (c.ult || 0)) c.ult = ts;
  if (!c.telefone) { const pn = pnDe(ch.id); if (pn && pn.endsWith('@s.whatsapp.net')) c.telefone = pn.split('@')[0]; }
  if (typeof ch.unreadCount === 'number' && ch.unreadCount >= 0) c.naoLidas = ch.unreadCount;
  salvarChats();
}
function salvarChats() { clearTimeout(salvarChatsTimer); salvarChatsTimer = setTimeout(() => gravarJson(CHATS_F, chats), 800); }
function arqEsp(jid) { return path.join(ESPELHO, jid.replace(/[^0-9a-zA-Z@._-]/g, '_') + '.json'); }
function lerEsp(jid) { return lerJson(arqEsp(jid), []); }
// ---- Sinais da conversa para a pontuação "Quentes" do CRM: só o que aconteceu de fato na conversa (sem IA) ----
const RE_S_IMOVEL = /^\s*✨|💰\s*R\$/;
const RE_S_FLUXO = /financiamento pela caixa|entrada parcelada|complemento da entrada/i;
const RE_S_AGENDA = /hook\.us2\.make\.com|mc\.ht\/s\/|marque seu hor[aá]rio/i;
const RE_S_PAG = /entrada|parcel|financ|simul|minha casa|mcmv|fgts|pela caixa|nome limpo|score|forma de pagamento|formas de pagamento|quanto (?:fica|sai|custa|[ée]|d[aá]|tem que|precisa)|subs[ií]dio|aceita[mn]? (?:carro|moto)/i;
const RE_S_PENSAR = /\b(?:conversar|conversando|falar|falando|ver|verificar|mostrar)\b[^.?!]{0,12}\b(?:com|pr[ao]|para)\s+(?:o |a )?(?:meu|minha|ele|ela)\b|\besperar (?:o |a )?(?:meu|minha|ele|ela)\b|vou pensar|vamos pensar|pensar (?:melhor|com calma|um pouco)|te (?:aviso|retorno|dou (?:um )?retorno)|qualquer coisa (?:eu )?(?:te )?(?:chamo|aviso|falo|entro)|entro em contato/i;
const RE_S_ESCR = /escrit[oó]rio|visita|agend|marcar (?:um |uma )?(?:hor|visita|dia)|marquei|pessoalmente|pode ser (?:s[aá]bado|segunda|ter[cç]a|quarta|quinta|sexta|amanh[aã]|hoje|dia \d)|passar a[ií]|ir a[ií]/i;
const RE_S_DIA1 = /pode ser|teria como|d[aá] (?:pra|para)|consigo (?:ir|passar)|vou (?:ir|passar|a[ií])|agendei|marquei|[aà]s ?\d{1,2}/i;
const RE_S_DIA2 = /s[aá]bado|segunda|ter[cç]a|quarta|quinta|sexta|domingo|amanh[aã]|hoje|dia \d|\d{1,2}\s*(?:h\b|:\d\d|horas)|manh[aã]|tarde|agendei|marquei/i;
const RE_S_ADIOU = /mais pra frente|mais para frente|n[aã]o no momento|agora n[aã]o|ano que vem|(?:final|fim) do m[eê]s|s[oó] pesquisando|por enquanto (?:n[aã]o|s[oó])|deixa(?:r)? (?:pra|para) depois|outra hora|m[eê]s que vem/i;
const RE_S_PESADO = /pesad|n[aã]o tenho (?:ess|como|dinheiro|entrada|condi|esse)|n[aã]o d[aá]\b|muito caro|caro (?:demais|n[eé])|salgad|fora do (?:meu )?or[cç]amento|n[aã]o consigo/i;
const RE_S_NUM = /\b\d{1,3}(?:\.\d{3})+\b|\b\d+\s*mil\b|\b\d{4,6}\b|r\$\s*\d/i;
const RE_S_DADO = /renda|sal[aá]rio|ganh[oa]|fgts|sinal|entrada|por m[eê]s|carteira/i;
const RE_S_FIM = /n[aã]o (?:tenho|tem|temos) (?:mais )?interesse|j[aá] compr(?:ei|amos)|comprei (?:com|outro|em outra)|n[aã]o quero mais|eu n[aã]o busco|n[aã]o me (?:mande|chame)|pare de (?:me )?mandar/i;
function sinaisMsgs(ms) {
  const s = { n: 0 }; let nossa = false, tImv = 0, tFlx = 0, cliDesdeFlx = false, tPede = 0;
  for (const m of ms || []) {
    const tx = String(m.texto || '');
    if (m.autor === 'cliente') {
      if (!tx.trim() && (!m.tipo || m.tipo === 'text')) continue;
      s.n++; s.uc = m.ts; s.ua = 'c';
      if (nossa) s.r = 1;                                   // respondeu depois da nossa primeira mensagem
      if (tImv) s.ri = 1;                                   // continuou a conversa depois de receber imóvel
      if (RE_S_PAG.test(tx)) s.pg = 1;                      // perguntou de entrada, parcelas, financiamento
      if (tFlx) { s.rf = (s.rf || 0) + 1; s.rfu = 1; cliDesdeFlx = true; }   // falou depois do fluxo de pagamento
      if (RE_S_NUM.test(tx) && (RE_S_DADO.test(tx) || (tPede && m.ts - tPede < 6 * 3600e3))) s.dd = 1;   // passou renda, FGTS, sinal ou parcela
      if (nossa && RE_S_PENSAR.test(tx)) s.pe = 1;          // ficou de pensar ou de falar com a família
      if (nossa && RE_S_ESCR.test(tx) && !s.es) s.es = 1;   // falou em vir ao escritório, visita ou horário
      if ((s.es || s.lk) && RE_S_DIA1.test(tx) && RE_S_DIA2.test(tx)) s.es = 2;   // combinou dia ou hora para vir
      s.pd = (/[?❓]/.test(tx) || (m.tipo && m.tipo !== 'text')) ? 1 : (s.pd || 0);   // pergunta, áudio ou foto dele ainda sem resposta nossa
      if (RE_S_ADIOU.test(tx)) s.ad = 1; else if (s.ad && (RE_S_PAG.test(tx) || RE_S_ESCR.test(tx))) s.ad = 0;   // adiou; deixa de valer se depois ele retomou o assunto
      if (RE_S_PESADO.test(tx)) { s.ps = 1; s.psu = 1; }   // achou pesado (psu: ainda sem novo fluxo depois disso)
      if (RE_S_FIM.test(tx)) s.nf = 1;
    } else {
      nossa = true; s.un = m.ts; s.ua = 'n'; s.pd = 0;
      if (RE_S_IMOVEL.test(tx)) { s.im = (s.im || 0) + 1; if (!tImv) tImv = m.ts; }
      if (RE_S_FLUXO.test(tx) && /sinal/i.test(tx) && /r\$\s*\d/i.test(tx)) {
        if (tFlx && cliDesdeFlx) s.aj = (s.aj || 0) + 1;     // o cliente falou e recebeu outro fluxo: ajuste
        s.fx = (s.fx || 0) + 1; tFlx = m.ts; cliDesdeFlx = false; s.rfu = 0; s.psu = 0;
      }
      if (RE_S_AGENDA.test(tx)) s.lk = 1;
      if (/\?/.test(tx) && RE_S_DADO.test(tx)) tPede = m.ts;
    }
  }
  return s;
}
const sinaisCache = new Map();
function sinaisDe(j) {
  const c = chats[j] || {}, k = (c.ult || 0) + ':' + (c.ultCliente || 0), v = sinaisCache.get(j);
  if (v && v.k === k) return v.s;
  const s = sinaisMsgs(lerEsp(j)); sinaisCache.set(j, { k, s });
  return s;
}
const clientesSSE = new Set();
function emitir(tipo, dados) {
  const linha = `event: ${tipo}\ndata: ${JSON.stringify(dados)}\n\n`;
  for (const r of clientesSSE) { try { r.write(linha); } catch (e) { clientesSSE.delete(r); } }
}
function chatPublico(jid) {
  const c = chats[jid] || {};
  const cl = (estado.classes || {})[jid];
  const etqs = etiquetasDe(jid);
  const pn = pnDe(jid);
  return { jid, nome: c.nome || contatos[jid] || (pn && contatos[pn]) || '', telefone: c.telefone || (pn && pn.endsWith('@s.whatsapp.net') ? pn.split('@')[0] : ''), arquivado: !!c.arquivado, cat: cl ? cl.cat : '', catMotivo: cl ? cl.motivo : '', etiquetas: etqs, ult: c.ult || 0, ultTexto: c.ultTexto || '', ultAutor: c.ultAutor || '', naoLidas: c.naoLidas || 0, iaOff: (estado.pausas[jid] || 0) > Date.now() };
}
function resumoMsg(m) {
  const rot = { image: '📷 Foto', audio: '🎤 Áudio', video: '🎬 Vídeo', document: '📄 Arquivo', sticker: 'Figurinha', contact: '👤 Contato', location: '📍 Localização' }[m.tipo];
  return (rot ? rot + (m.texto ? ': ' : '') : '') + (m.texto || '');
}
// autor: cliente | ia | voce (painel) | celular (escrito no celular/outro aparelho)
function registrarEspelho(jid, m, { silencioso = false } = {}) {
  if (!jid) return;
  jid = acharJid(jid);
  const lista = lerEsp(jid);
  if (m.id) {
    const i = lista.findIndex(x => x.id === m.id);
    if (i >= 0) {   // já existe: se antes chegou vazia/cifrada e agora veio o conteúdo, atualiza
      const v = lista[i], vazio = !v.texto || /^🔒/.test(v.texto), novoTem = (m.texto && !/^🔒/.test(m.texto)) || (m.tipo && m.tipo !== 'text');
      if (vazio && novoTem) {
        lista[i] = Object.assign({}, v, m); gravarJson(arqEsp(jid), lista);
        const c = chats[jid]; if (c && c.ult === v.ts) { c.ultTexto = resumoMsg(lista[i]).slice(0, 120); salvarChats(); }
        emitir('msg', { jid, msg: lista[i], chat: chatPublico(jid) });
      }
      return;
    }
  }
  lista.push(m);
  lista.sort((a, b) => a.ts - b.ts);
  gravarJson(arqEsp(jid), lista.slice(-1000));
  const c = chats[jid] || (chats[jid] = {});
  if (m.nome && m.autor === 'cliente') c.nome = m.nome;
  if (m.telefone) c.telefone = m.telefone;
  if (m.id && (!c.ultKey || m.ts >= (c.ultKeyTs || 0))) { c.ultKey = { id: m.id, fromMe: m.autor !== 'cliente' }; c.ultKeyTs = m.ts; }
  if (!c.ult || m.ts >= c.ult) { c.ult = m.ts; c.ultTexto = resumoMsg(m).slice(0, 120); c.ultAutor = m.autor; }
  if (m.autor === 'cliente' && m.ts > (c.ultCliente || 0)) c.ultCliente = m.ts;
  if (m.autor === 'cliente' && !silencioso) c.naoLidas = (c.naoLidas || 0) + 1;
  salvarChats();
  if (!silencioso) emitir('msg', { jid, msg: m, chat: chatPublico(jid) });
}
function tipoDe(x) {
  if (x.imageMessage) return 'image'; if (x.audioMessage) return 'audio'; if (x.videoMessage) return 'video';
  if (x.documentMessage) return 'document'; if (x.stickerMessage) return 'sticker';
  if (x.contactMessage || x.contactsArrayMessage) return 'contact'; if (x.locationMessage) return 'location';
  return 'text';
}
const EXT_MIME = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'video/mp4': 'mp4', 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'application/pdf': 'pdf' };
async function guardarMidia(m, x, tipo) {
  const node = x[tipo + 'Message'];
  if (!node) return null;
  const tam = Number(node.fileLength && (node.fileLength.low || node.fileLength)) || 0;
  if (tam > 25e6) return null;
  try {
    const buf = await downloadMediaMessage(m, 'buffer', {}, { reuploadRequest: sock.updateMediaMessage });
    const mime = String(node.mimetype || '').split(';')[0];
    let ext = EXT_MIME[mime] || (node.fileName && path.extname(node.fileName).slice(1)) || 'bin';
    ext = String(ext).replace(/[^a-z0-9]/gi, '').slice(0, 5) || 'bin';
    const nome = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${ext}`;
    fs.writeFileSync(path.join(MIDIA, nome), buf);
    return { arquivo: 'm/' + nome, buf, mime };
  } catch (e) { log('falha ao baixar mídia', e.message); return null; }
}

// ---------- WhatsApp ----------
let sock = null, ultimoQR = null, conectado = false, meuNumero = '', iniciando = false;
const enviados = new Set();
function lembrarEnvio(r) { const id = r && r.key && r.key.id; if (id) { enviados.add(id); if (enviados.size > 5000) enviados.delete(enviados.values().next().value); } return id; }

// ---------- proteção contra banimento ----------
const LIM_MIN = Number(ENV.LIMITE_POR_MINUTO || 12), LIM_HORA = Number(ENV.LIMITE_POR_HORA || 180);
const envios = [];               // horários dos envios automáticos (assistente)
let ultimoEnvio = 0;
const dorme = (ms) => new Promise(r => setTimeout(r, ms));
const acaso = (a, b) => a + Math.floor(Math.random() * (b - a));
function tel8De(jid, tel) { return String(tel || (chats[jid] || {}).telefone || (pnDe(jid) || '').split('@')[0] || '').replace(/\D/g, '').slice(-8); }
function podeResponder(jid, tel) {   // ligada para todos, ou modo teste e é o número de teste; e não pausada nessa conversa
  if ((estado.pausas[jid] || 0) > Date.now()) return false;
  if (estado.teste && estado.teste.ativo) return ehNumeroTeste(jid, tel);
  return !!estado.ativo;
}
function ehNumeroTeste(jid, tel) { const t = tel8De(jid, tel); return t.length === 8 && ((estado.teste || {}).numeros || []).some(n => String(n).replace(/\D/g, '').slice(-8) === t); }
function ehDono(jid) { return String(jid || '').startsWith(DONO); }
async function guardaEnvio(jid, autor, texto, tipo, segundos) {
  if (autor !== 'ia' || ehDono(jid)) return;                 // você (painel/celular) e avisos ao dono não passam pelo freio
  const c = chats[jid] || {};
  // lembrete de visita marcada e ordem do Djhonata podem passar das 24h; o resto não puxa conversa
  if (!liberado24h.has(jid) && (!c.ultCliente || Date.now() - c.ultCliente > 24 * 3600e3)) throw new Error('bloqueado: o cliente não falou nas últimas 24h (a assistente não puxa conversa)');
  for (;;) {
    const agora = Date.now();
    while (envios.length && agora - envios[0] > 3600e3) envios.shift();
    const noMinuto = envios.filter(t => agora - t < 60e3).length;
    if (envios.length >= LIM_HORA) { pausarPorSeguranca(`limite de ${LIM_HORA} mensagens automáticas por hora atingido`); throw new Error('limite por hora atingido'); }
    if (noMinuto < LIM_MIN) break;
    await dorme(5000);
  }
  const desde = Date.now() - ultimoEnvio, intervalo = tipo === 'text' ? acaso(1500, 3500) : acaso(3000, 6000);
  if (desde < intervalo) await dorme(intervalo - desde);
  if (tipo === 'text') {                                     // "digitando…" proporcional ao tamanho, como uma pessoa
    try { await sock.sendPresenceUpdate('composing', jid); } catch (e) { }
    await dorme(Math.min(9000, 900 + String(texto || '').length * acaso(25, 45)));
  } else if (tipo === 'audio') {                             // "gravando áudio…" proporcional à duração
    try { await sock.sendPresenceUpdate('recording', jid); } catch (e) { }
    await dorme(Math.min(15000, 1500 + (Number(segundos) || 10) * acaso(300, 450)));
  }
  envios.push(Date.now()); ultimoEnvio = Date.now();
}
const liberado24h = new Set();   // conversas liberadas da regra das 24h durante um lembrete de visita ou uma ordem do Djhonata
const quedas = [];
function pausarPorSeguranca(motivo) {
  if (!estado.ativo) return;
  estado.ativo = false; estado.pausadaEm = Date.now(); salvarEstado(); log('ASSISTENTE PAUSADA POR SEGURANÇA:', motivo); emitir('estado', estadoPublico());
  setTimeout(() => { if (sock && conectado) sock.sendMessage(DONO + '@s.whatsapp.net', { text: `⚠️ Assistente pausada por segurança: ${motivo}. O WhatsApp continua conectado. Reative pelo CRM quando quiser.` }).then(lembrarEnvio).catch(() => { }); }, 3000);
}
// O Djhonata não manda joinha para cliente: se a IA escrever 👍, sai 🙏🏼 (o emoji de agradecer que ele usa).
function semJoinha(t) { return String(t || '').replace(/👍(?:\u{1F3FB}|\u{1F3FC}|\u{1F3FD}|\u{1F3FE}|\u{1F3FF})?/gu, '🙏🏼'); }
async function enviarTexto(jid, texto, autor = 'ia', extra) {
  if (!sock || !conectado || !String(texto || '').trim()) return null;
  if (autor === 'ia') texto = semJoinha(texto);
  try { await guardaEnvio(jid, autor, texto, 'text'); } catch (e) { log('envio barrado', jid, e.message); return null; }
  const r = await sock.sendMessage(jid, { text: String(texto).trim() });
  const id = lembrarEnvio(r);
  registrarEspelho(jid, Object.assign({ id, autor, tipo: 'text', texto: String(texto).trim(), ts: Date.now() }, extra || {}));
  return id;
}

// ---------- voz (ElevenLabs, voz do Djhonata) e transcrição dos áudios ----------
const voz = { feitas: 0, erros: 0, ultimoErro: '', modelo: '', formato: '' };
const ouvido = { feitas: 0, erros: 0, ultimoErro: '', servico: '' };
let FFMPEG = null;
function temFfmpeg() { if (FFMPEG === null) { try { require('child_process').execFileSync('ffmpeg', ['-version'], { stdio: 'ignore', timeout: 5000 }); FFMPEG = true; } catch (e) { FFMPEG = false; } } return FFMPEG; }
function paraOgg(buf) {   // mp3 -> ogg/opus (nota de voz), se o servidor tiver ffmpeg
  if (!temFfmpeg()) return null;
  try {
    const r = require('child_process').spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-vn', '-c:a', 'libopus', '-b:a', '48k', '-ar', '48000', '-ac', '1', '-f', 'ogg', 'pipe:1'], { input: buf, maxBuffer: 50e6, timeout: 30000 });
    return r.status === 0 && r.stdout && r.stdout.length > 100 ? r.stdout : null;
  } catch (e) { return null; }
}
function duracaoOgg(buf) {   // duração pela última página do Ogg (granule a 48 kHz, menos o pre-skip do OpusHead)
  try {
    const i = buf.lastIndexOf(Buffer.from('OggS')); if (i < 0 || i + 14 > buf.length) return 0;
    const gran = Number(buf.readBigUInt64LE(i + 6)); if (!isFinite(gran) || gran <= 0 || gran > 1e12) return 0;
    const h = buf.indexOf(Buffer.from('OpusHead')); const pre = h >= 0 && h + 12 <= buf.length ? buf.readUInt16LE(h + 10) : 0;
    return Math.max(1, Math.round((gran - pre) / 48000));
  } catch (e) { return 0; }
}
const estimarSeg = (t) => Math.max(2, Math.round(String(t || '').length / 14));
function ondaFake() { const a = new Uint8Array(64); let v = 35; for (let i = 0; i < 64; i++) { v = Math.max(6, Math.min(94, v + (Math.random() - 0.5) * 38)); a[i] = Math.round(v); } return a; }
function rodarFfmpeg(args, entrada, limiteMs = 45000) {   // sem travar o servidor enquanto o ffmpeg trabalha
  return new Promise((ok) => {
    let p; try { p = require('child_process').spawn('ffmpeg', args); } catch (e) { return ok({ status: -1, stdout: Buffer.alloc(0), stderr: e.message }); }
    const saida = [], erro = []; const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch (e) { } }, limiteMs);
    p.stdout.on('data', d => saida.push(d)); p.stderr.on('data', d => erro.push(d));
    p.on('error', e => { clearTimeout(t); ok({ status: -1, stdout: Buffer.alloc(0), stderr: e.message }); });
    p.on('close', (c) => { clearTimeout(t); ok({ status: c, stdout: Buffer.concat(saida), stderr: Buffer.concat(erro).toString() }); });
    p.stdin.on('error', () => { }); if (entrada) p.stdin.end(entrada); else p.stdin.end();
  });
}
async function ondaReal(ogg) {   // barrinhas da nota de voz a partir do som de verdade (64 valores de 0 a 100)
  if (!temFfmpeg()) return ondaFake();
  const r = await rodarFfmpeg(['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-ac', '1', '-ar', '8000', '-f', 's16le', 'pipe:1'], ogg, 20000);
  if (r.status !== 0 || r.stdout.length < 256) return ondaFake();
  const n = Math.floor(r.stdout.length / 2), passo = Math.max(1, Math.floor(n / 64)), v = [];
  for (let b = 0; b < 64; b++) { let s = 0, k = 0; for (let i = b * passo; i < Math.min(n, (b + 1) * passo); i++) { s += Math.abs(r.stdout.readInt16LE(i * 2)); k++; } v.push(k ? s / k : 0); }
  const max = Math.max(...v) || 1; return Uint8Array.from(v.map(x => Math.round(Math.max(3, Math.min(100, (x / max) * 100)))));
}
// ---------- fundo do áudio: um barulhinho de ambiente bem baixo atrás da voz, como o Djhonata faz nos áudios dele ----------
// Ordem: arquivo dele na pasta _ponte (fundo-audio.mp3/.wav/.m4a/.ogg), senão um ambiente criado uma vez pela ElevenLabs
// (efeitos sonoros), senão um ruído suave de sala feito aqui mesmo. FUNDO_AUDIO=0 no .env desliga; FUNDO_DB muda o volume.
const FUNDO = ENV.FUNDO_AUDIO !== '0';
const FUNDO_DB = Number(ENV.FUNDO_DB || -44);
const FUNDO_PROMPT = ENV.FUNDO_PROMPT || 'Very quiet indoor room tone of a small office: soft air conditioner hum and faint distant street traffic through a closed window. No voices, no music, steady and constant.';
let fundoGerando = null; const ganhoFundoCache = {};
function arquivoFundo() {
  try { const p = path.join(CATALOGO, '_ponte'); const f = fs.readdirSync(p).find(n => /^fundo-audio\.(mp3|wav|m4a|ogg|opus|aac)$/i.test(n)); if (f) return path.join(p, f); } catch (e) { }
  const g = path.join(DADOS, 'fundo-gerado.mp3'); try { if (fs.statSync(g).size > 1000) return g; } catch (e) { }
  return '';
}
function gerarFundo() {   // pede à ElevenLabs um som de ambiente (uma vez) e guarda no servidor
  if (!fundoGerando) fundoGerando = (async () => {
    const r = await fetch('https://api.elevenlabs.io/v1/sound-generation', { method: 'POST', headers: { 'xi-api-key': ELEVEN_KEY, 'content-type': 'application/json' }, body: JSON.stringify({ text: FUNDO_PROMPT, duration_seconds: 20, prompt_influence: 0.6 }) });
    if (!r.ok) throw new Error('efeito sonoro ' + r.status + ' ' + (await r.text()).slice(0, 200));
    const buf = Buffer.from(await r.arrayBuffer()); if (buf.length < 1000) throw new Error('efeito sonoro vazio');
    fs.writeFileSync(path.join(DADOS, 'fundo-gerado.mp3'), buf); log('fundo do áudio criado pela ElevenLabs');
  })().catch(e => { voz.fundoErro = e.message; estado.fundoFalhou = Date.now(); salvarEstado(); log('fundo do áudio:', e.message); }).finally(() => { fundoGerando = null; });
  return fundoGerando;
}
async function ganhoFundo(f) {   // volume do fundo: mede uma vez e ajusta para FUNDO_DB
  let st; try { st = fs.statSync(f); } catch (e) { return -27; }
  const k = f + '|' + st.mtimeMs + '|' + FUNDO_DB;
  if (ganhoFundoCache[k] === undefined) {
    const r = await rodarFfmpeg(['-hide_banner', '-nostats', '-t', '20', '-i', f, '-af', 'volumedetect', '-f', 'null', '-'], null, 30000);
    const m = /mean_volume:\s*(-?[\d.]+) dB/.exec(r.stderr || '');
    ganhoFundoCache[k] = m ? Math.max(-60, Math.min(20, FUNDO_DB - Number(m[1]))) : -27;
  }
  return ganhoFundoCache[k];
}
async function comFundo(audio) {   // devolve ogg/opus com o fundo, ou null (sem ffmpeg ou deu erro: vai sem fundo)
  if (!FUNDO || !temFfmpeg()) return null;
  let f = arquivoFundo();
  if (!f && ELEVEN_KEY && !(estado.fundoFalhou && Date.now() - estado.fundoFalhou < 6 * 3600e3)) { await gerarFundo(); f = arquivoFundo(); }
  const args = ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0'];
  let ganho;
  if (f) { args.push('-stream_loop', '-1', '-i', f); ganho = await ganhoFundo(f); }
  else { args.push('-f', 'lavfi', '-i', 'anoisesrc=color=brown:amplitude=0.6:sample_rate=48000,lowpass=f=700'); ganho = FUNDO_DB + 19; }   // esse ruído mede -19 dB
  const graph = `[0:a]aformat=channel_layouts=mono,aresample=48000,adelay=300,apad=pad_len=19200[v];[1:a]aformat=channel_layouts=mono,aresample=48000,volume=${ganho.toFixed(1)}dB[bg];[v][bg]amix=inputs=2:duration=first:dropout_transition=0,volume=2,afade=t=in:d=0.25,areverse,afade=t=in:d=0.4,areverse[o]`;
  args.push('-filter_complex', graph, '-map', '[o]', '-ac', '1', '-ar', '48000', '-c:a', 'libopus', '-b:a', '48k', '-f', 'ogg', 'pipe:1');
  const r = await rodarFfmpeg(args, audio);
  if (r.status === 0 && r.stdout.length > 200 && r.stdout.slice(0, 4).toString('latin1') === 'OggS') { voz.fundo = f ? path.basename(f) : 'ruído de sala'; return r.stdout; }
  log('fundo do áudio: ffmpeg falhou', String(r.stderr || '').slice(0, 200)); return null;
}
// ---------- jeito da voz: muda pelo CRM/Claude (voz_config) sem subir arquivo ----------
const VOZ_PADRAO = { voz: ELEVEN_VOZ, modelo: ELEVEN_MODELO, stability: 0.5, similarity: 0.8 };
function vozCfg() { return Object.assign({}, VOZ_PADRAO, estado.vozCfg || {}); }
const temValor = (v) => v !== undefined && v !== null && v !== '' && !isNaN(Number(v));
function ajustesVoz(cfg, modelo) {   // só manda o que cada modelo aceita (no v3/v4 não existe estilo nem velocidade)
  const v = {};
  if (temValor(cfg.stability)) { let st = Math.max(0, Math.min(1, Number(cfg.stability))); if (/^eleven_v3/.test(modelo)) st = [0, 0.5, 1].reduce((a, b) => Math.abs(b - st) < Math.abs(a - st) ? b : a); v.stability = st; }
  if (temValor(cfg.similarity)) v.similarity_boost = Math.max(0, Math.min(1, Number(cfg.similarity)));
  if (!/^eleven_v[34]/.test(modelo)) {
    if (temValor(cfg.style)) v.style = Math.max(0, Math.min(1, Number(cfg.style)));
    if (temValor(cfg.speed)) v.speed = Math.max(0.7, Math.min(1.2, Number(cfg.speed)));
    if (cfg.boost !== undefined && cfg.boost !== null) v.use_speaker_boost = !!cfg.boost;
  }
  return v;
}
// números por extenso (a voz lê "380.000" melhor como "trezentos e oitenta mil")
const UNI_EXT = ['zero', 'um', 'dois', 'três', 'quatro', 'cinco', 'seis', 'sete', 'oito', 'nove', 'dez', 'onze', 'doze', 'treze', 'catorze', 'quinze', 'dezesseis', 'dezessete', 'dezoito', 'dezenove'];
const DEZ_EXT = ['', '', 'vinte', 'trinta', 'quarenta', 'cinquenta', 'sessenta', 'setenta', 'oitenta', 'noventa'];
const CEN_EXT = ['', 'cento', 'duzentos', 'trezentos', 'quatrocentos', 'quinhentos', 'seiscentos', 'setecentos', 'oitocentos', 'novecentos'];
const unidadeExt = (u, fem) => fem && u === 1 ? 'uma' : fem && u === 2 ? 'duas' : UNI_EXT[u];
function ate999(n, fem) {
  if (n === 100) return 'cem';
  const c = Math.floor(n / 100), r = n % 100, p = [];
  if (c) p.push(fem && c > 1 ? CEN_EXT[c].replace(/os$/, 'as') : CEN_EXT[c]);
  if (r) p.push(r < 20 ? unidadeExt(r, fem) : DEZ_EXT[Math.floor(r / 10)] + (r % 10 ? ' e ' + unidadeExt(r % 10, fem) : ''));
  return p.join(' e ');
}
function porExtenso(n, fem) {
  n = Math.floor(Number(n)); if (!isFinite(n) || n < 0 || n >= 1e9) return String(n); if (n === 0) return 'zero';
  const g = [[Math.floor(n / 1e6), 'mi'], [Math.floor(n / 1e3) % 1000, 'mil'], [n % 1000, '']].filter(x => x[0]);
  const t = g.map(([v, k]) => k === 'mi' ? (v === 1 ? 'um milhão' : ate999(v) + ' milhões') : k === 'mil' ? (v === 1 ? 'mil' : ate999(v, fem) + ' mil') : ate999(v, fem));
  const ult = g[g.length - 1][0];
  return t.length > 1 && (ult < 100 || ult % 100 === 0) ? t.slice(0, -1).join(' ') + ' e ' + t[t.length - 1] : t.join(' ');
}
const MESES_EXT = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
const FEM_DEPOIS = /^\s*(suítes?|vagas?|casas?|unidades?|parcelas?|presta[cç](ão|ões)|horas?|semanas?|pessoas?|op[cç](ão|ões)|salas?|garagens?|entradas?|vezes|vez|crianças?|fotos?|plantas?|ruas?|quadras?|mensalidades?|semanas?|noites?|torres?)\b/i;
const numeroLido = (txt, depois) => { const n = Number(String(txt).replace(/\./g, '')); return isFinite(n) ? porExtenso(n, FEM_DEPOIS.test(depois || '')) : txt; };
// Deixa o texto do jeito que se fala: sem emoji, valores, metragem, horas, datas e números por extenso
// Siglas no áudio (pedido do Djhonata, 13/11/2026): nunca soletrar; falar o nome de verdade. Uma cliente estranhou o "FGTS" soletrado e desconfiou que era IA.
const SIGLAS_FALA = [
  [/\bF\.?G\.?T\.?S\b\.?/gi, 'Fundo de Garantia'], [/\bM\.?C\.?M\.?V\b\.?/gi, 'Minha Casa Minha Vida'], [/\bI\.?T\.?B\.?I\b\.?/gi, 'Imposto de Transmissão de Bens Imóveis'],
  [/\bF\.?R\.?J\b\.?/gi, 'Fundo de Reaparelhamento da Justiça'], [/\bI\.?P\.?T\.?U\b\.?/gi, 'Imposto Predial e Territorial Urbano'], [/\bCEF\b/g, 'Caixa Econômica Federal']
];
function falaHumana(texto) {
  let t = String(texto || '');
  t = t.replace(/https?:\/\/\S+/g, '').replace(/[*_~`#>]/g, '');
  t = t.replace(/\p{Extended_Pictographic}/gu, '').replace(/[\u{1F3FB}-\u{1F3FF}\u{FE0F}‍]/gu, '');
  t = t.replace(/^\s*(?:[-•]|\d+[.)])\s+/gm, '');                                         // listas viram frases
  t = t.replace(/([^\s.,!?…:;])\s*\n+\s*(?=\p{Ll})/gu, '$1, ').replace(/([^\s.,!?…:;])\s*\n+\s*/g, '$1. ').replace(/\s*\n+\s*/g, ' ');   // quebra de linha = pausa
  for (const [re, nome] of SIGLAS_FALA) t = t.replace(re, nome);   // sigla no áudio sai sempre por extenso
  t = t.replace(/\bn[º°]\s?/gi, 'número ');
  t = t.replace(/R\$\s?(\d{1,3}(?:\.\d{3})+|\d+)(?:,(\d{1,2}))?(\s*(?:mil\b|milh(?:ão|ões)\b))?/gi, (m0, int, dec, suf) => {
    let v = Number(int.replace(/\./g, '')), cent = dec ? Number(dec.padEnd(2, '0')) : 0;
    if (suf && /mil\b/i.test(suf)) { v = Math.round((v + cent / 100) * 1000); cent = 0; }
    else if (suf) { v = Math.round((v + cent / 100) * 1e6); cent = 0; }
    const ext = porExtenso(v);
    return ext + (/milh(ão|ões)$/.test(ext) ? ' de reais' : v === 1 ? ' real' : ' reais') + (cent ? ' e ' + porExtenso(cent) + (cent === 1 ? ' centavo' : ' centavos') : '');
  });
  t = t.replace(/(\d+)(?:,(\d+))?\s?(?:m²|m2(?![\w]))/gi, (m0, i, d) => porExtenso(i) + (d && Number(d) ? ' vírgula ' + porExtenso(d) : '') + ' metros quadrados');
  t = t.replace(/(\d+)(?:,(\d+))?\s?%/g, (m0, i, d) => porExtenso(i) + (d ? ' vírgula ' + porExtenso(d) : '') + ' por cento');
  t = t.replace(/\b(\d{1,2})\s?(?:h|:)\s?(\d{2})\b/gi, (m0, h, mi) => Number(h) > 23 || Number(mi) > 59 ? m0 : porExtenso(h, true) + (Number(mi) ? ' e ' + porExtenso(mi) : Number(h) === 1 ? ' hora' : ' horas'));
  t = t.replace(/\b(\d{1,2})\s?h\b/gi, (m0, h) => Number(h) > 23 ? m0 : porExtenso(h, true) + (Number(h) === 1 ? ' hora' : ' horas'));
  t = t.replace(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?\b/g, (m0, d, m, a) => { const di = Number(d), me = Number(m); if (di < 1 || di > 31 || me < 1 || me > 12) return m0; return (di === 1 ? 'primeiro' : porExtenso(di)) + ' de ' + MESES_EXT[me - 1] + (a ? ' de ' + porExtenso(a.length === 2 ? 2000 + Number(a) : a) : ''); });
  t = t.replace(/\b(\d+)\s?x\b/gi, (m0, n) => porExtenso(n, true) + ' vezes');
  t = t.replace(/\b(\d+),(\d+)\b/g, (m0, i, d) => porExtenso(i) + ' vírgula ' + porExtenso(d));
  t = t.replace(/\b(\d{1,3}(?:\.\d{3})+|\d{1,7})\b(?=([^\d]{0,30}))/g, (m0, n, depois) => numeroLido(n, depois));   // telefone e códigos grandes ficam como estão
  t = t.replace(/\b([A-ZÁÉÍÓÚÂÊÔÃÕÇ]{4,})\b/g, (m0) => m0.toLowerCase());                       // CAIXA ALTA não vira grito
  return t.replace(/\s+([,.!?…])/g, '$1').replace(/([.!?…])\1+/g, '$1').replace(/\s+/g, ' ').trim();
}
async function falar(texto, ajustes) {   // ajustes: { voz, modelo, stability, similarity, style, speed, boost, tag } (o teste de voz manda os dele)
  const cfg = Object.assign(vozCfg(), ajustes || {});
  const limpo = falaHumana(texto).slice(0, 2500);
  if (!limpo) throw new Error('texto vazio');
  let erro = '';
  for (const modelo of [...new Set([cfg.modelo || ELEVEN_MODELO, 'eleven_v3', 'eleven_multilingual_v2'])]) {
    let trocarModelo = false;
    const corpo = { text: cfg.tag && /^eleven_v[34]/.test(modelo) ? String(cfg.tag).trim() + ' ' + limpo : limpo, model_id: modelo };
    const vs = ajustesVoz(cfg, modelo); if (Object.keys(vs).length) corpo.voice_settings = vs;
    for (const fmt of ['opus_48000_64', 'mp3_44100_128']) {
      let r;
      try { r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(cfg.voz || ELEVEN_VOZ)}?output_format=${fmt}`, { method: 'POST', headers: { 'xi-api-key': ELEVEN_KEY, 'content-type': 'application/json' }, body: JSON.stringify(corpo) }); }
      catch (e) { throw new Error('ElevenLabs fora do ar: ' + e.message); }
      if (r.ok) {
        const buf = Buffer.from(await r.arrayBuffer());
        voz.modelo = modelo; voz.formato = fmt;
        const misturado = await comFundo(buf).catch(() => null);   // voz + barulhinho de ambiente
        if (misturado) return { buf: misturado, mime: 'audio/ogg; codecs=opus', ptt: true, ext: 'ogg', seg: duracaoOgg(misturado) || estimarSeg(limpo), modelo, fala: limpo };
        if (buf.slice(0, 4).toString('latin1') === 'OggS') return { buf, mime: 'audio/ogg; codecs=opus', ptt: true, ext: 'ogg', seg: duracaoOgg(buf) || estimarSeg(limpo), modelo, fala: limpo };
        const ogg = paraOgg(buf);
        if (ogg) return { buf: ogg, mime: 'audio/ogg; codecs=opus', ptt: true, ext: 'ogg', seg: duracaoOgg(ogg) || estimarSeg(limpo), modelo, fala: limpo };
        if (fmt.startsWith('mp3')) return { buf, mime: 'audio/mpeg', ptt: false, ext: 'mp3', seg: estimarSeg(limpo), modelo, fala: limpo };
        continue;   // o opus veio num formato inesperado: tenta mp3
      }
      const t = (await r.text()).slice(0, 300); erro = 'ElevenLabs ' + r.status + ' ' + t;
      if (r.status === 401 || r.status === 403 || r.status === 429 || /quota|credit|limit/i.test(t)) throw new Error(erro);
      if (/output_format|format/i.test(t) && fmt.startsWith('opus')) continue;   // formato não liberado no plano: tenta mp3
      trocarModelo = true; break;                                                // modelo (ou ajuste) não aceito: tenta o próximo
    }
    if (!trocarModelo) break;
  }
  throw new Error(erro || 'não consegui gerar o áudio');
}
async function mandarAudio(jid, a, fala, autor, extra) {   // manda o áudio pronto e guarda no espelho
  const msg = { audio: a.buf, mimetype: a.mime, ptt: a.ptt, seconds: a.seg };
  if (a.ptt) msg.waveform = await ondaReal(a.buf).catch(() => ondaFake());
  const r = await sock.sendMessage(jid, msg);
  const id = lembrarEnvio(r);
  const nome = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${a.ext}`;
  try { fs.writeFileSync(path.join(MIDIA, nome), a.buf); } catch (e) { }
  registrarEspelho(jid, Object.assign({ id, autor, tipo: 'audio', texto: String(fala).trim(), arquivo: 'm/' + nome, voz: true, ts: Date.now() }, extra || {}));
  return id;
}
// ---------- teste de voz (manda versões no WhatsApp do Djhonata) e voz nova treinada com os áudios dele ----------
const FALA_TESTE = 'Oi, tudo bem? Aqui é o Djhonata, da Euro. Olha, sobre a simulação: a entrada dá pra parcelar, e o restante a gente financia pela Caixa. Pra eu te passar o valor certinho, eu preciso ver a sua renda... então o ideal é você vir aqui no escritório, sem compromisso, tá? Me fala qual dia fica melhor pra você.';
function versoesVoz() {
  const v = [
    { nome: 'A', desc: 'natural', modelo: 'eleven_v4', stability: 0.5, similarity: 0.8 },
    { nome: 'B', desc: 'mais solta', modelo: 'eleven_v4', stability: 0, similarity: 0.8 },
    { nome: 'C', desc: 'clássica', modelo: 'eleven_multilingual_v2', stability: 0.4, similarity: 0.8, style: 0.3, speed: 0.97, boost: true }
  ];
  if (estado.vozNova && estado.vozNova.id) v.push({ nome: 'D', desc: 'voz nova, treinada com os seus áudios', voz: estado.vozNova.id, modelo: 'eleven_v4', stability: 0.5, similarity: 0.85 });
  return v;
}
let testandoVoz = false;
async function testarVoz(fala, versoes) {
  if (testandoVoz) throw new Error('já tem um teste de voz rodando');
  testandoVoz = true;
  const dono = DONO + '@s.whatsapp.net', res = [];
  try {
    const letras = versoes.map(v => v.nome);
    await enviarTexto(dono, `🎧 Teste de voz da assistente: o mesmo áudio em ${versoes.length} jeitos. Ouça e me diga qual ficou mais parecido com você (${letras.length > 1 ? letras.slice(0, -1).join(', ') + ' ou ' : ''}${letras[letras.length - 1]}).`, 'aviso');
    for (const v of versoes) {
      try {
        const a = await falar(fala, Object.assign({ voz: ELEVEN_VOZ, tag: '', stability: null, similarity: null, style: null, speed: null, boost: null }, v));   // cada versão só com os ajustes dela
        await enviarTexto(dono, `Versão ${v.nome}${v.desc ? ': ' + v.desc : ''}`, 'aviso');
        await mandarAudio(dono, a, fala, 'aviso');
        res.push({ nome: v.nome, ok: true, modelo: a.modelo, seg: a.seg });
      } catch (e) { res.push({ nome: v.nome, ok: false, erro: String(e.message).slice(0, 200) }); }
    }
  } finally { testandoVoz = false; estado.vozTeste = { em: Date.now(), fala, versoes, res }; salvarEstado(); }
  return res;
}
function audiosDoDono() {   // áudios que o próprio Djhonata gravou no celular para clientes (mais novos primeiro)
  const out = [];
  for (const jid of Object.keys(chats)) {
    if (ehDono(jid) || jid.endsWith('@g.us')) continue;
    for (const m of lerEsp(jid)) {
      if (m.autor !== 'celular' || m.tipo !== 'audio' || !m.arquivo) continue;
      const f = path.join(MIDIA, path.basename(m.arquivo));
      let seg = 0; try { seg = duracaoOgg(fs.readFileSync(f)); } catch (e) { continue; }
      if (seg >= 4 && seg <= 180) out.push({ f, seg, ts: m.ts || 0 });
    }
  }
  return out.sort((a, b) => b.ts - a.ts);
}
async function clonarVoz() {
  if (!temFfmpeg()) throw new Error('o servidor não tem ffmpeg para juntar os áudios');
  const escolhidos = []; let total = 0;
  for (const a of audiosDoDono()) { if (total >= 180 || escolhidos.length >= 25) break; escolhidos.push(a); total += a.seg; }
  if (total < 45) throw new Error(`achei só ${total} segundos de áudios gravados por você (preciso de pelo menos 45)`);
  const args = ['-hide_banner', '-loglevel', 'error'];
  escolhidos.forEach(a => args.push('-i', a.f));
  args.push('-filter_complex', escolhidos.map((_, i) => `[${i}:a]`).join('') + `concat=n=${escolhidos.length}:v=0:a=1[s]`, '-map', '[s]', '-ac', '1', '-ar', '44100', '-c:a', 'libmp3lame', '-b:a', '128k', '-f', 'mp3', 'pipe:1');
  const r = require('child_process').spawnSync('ffmpeg', args, { maxBuffer: 80e6, timeout: 120000 });
  if (r.status !== 0 || !r.stdout || r.stdout.length < 10000) throw new Error('não consegui juntar os áudios: ' + String(r.stderr || '').slice(0, 200));
  const fd = new FormData();
  fd.append('name', 'Djhonata (áudios do WhatsApp)');
  fd.append('description', 'Voz treinada com áudios reais do Djhonata no WhatsApp, para a assistente da Euro');
  fd.append('remove_background_noise', 'true');
  fd.append('files', new Blob([r.stdout], { type: 'audio/mpeg' }), 'djhonata-whatsapp.mp3');
  const resp = await fetch('https://api.elevenlabs.io/v1/voices/add', { method: 'POST', headers: { 'xi-api-key': ELEVEN_KEY }, body: fd });
  const txt = await resp.text();
  if (!resp.ok) throw new Error(resp.status === 401 || /permission/i.test(txt) ? 'a chave da ElevenLabs precisa da permissão Vozes → Escrita' : 'ElevenLabs ' + resp.status + ' ' + txt.slice(0, 200));
  let j = {}; try { j = JSON.parse(txt); } catch (e) { }
  if (!j.voice_id) throw new Error('a ElevenLabs não devolveu a voz nova');
  estado.vozNova = { id: j.voice_id, segundos: Math.round(total), audios: escolhidos.length, em: Date.now(), verificar: !!j.requires_verification };
  salvarEstado(); log('voz nova criada com', escolhidos.length, 'áudios do Djhonata,', Math.round(total), 's');
  return estado.vozNova;
}
async function enviarAudio(jid, fala, autor = 'ia', extra) {   // true = enviado; false = sem voz (manda texto); 'barrado' = freio de segurança
  if (!ELEVEN_KEY || !sock || !conectado) return false;
  let a;
  try { a = await falar(fala); } catch (e) { voz.erros++; voz.ultimoErro = e.message; log('voz:', e.message); return false; }
  try { await guardaEnvio(jid, autor, fala, 'audio', a.seg); } catch (e) { log('envio barrado', jid, e.message); return 'barrado'; }
  await mandarAudio(jid, a, fala, autor, extra);
  voz.feitas++;
  return true;
}
// Resposta da IA -> mensagens: texto (--- separa), [[tts:...]] vira áudio com a voz do Djhonata
const RE_TTS = /\[\[\s*tts\s*:([\s\S]*?)\]\]|\[\[\s*tts\s*\]\]([\s\S]*?)\[\[\s*\/\s*tts\s*\]\]/gi;
// Correção de 12/11/2026: às vezes a IA escreve "[áudio] fala" (era assim que a memória guardava os áudios) em vez de [[tts:...]].
// Antes isso saía como TEXTO, com "[áudio]" na frente. Agora vira áudio do mesmo jeito.
const RE_AUDIO_SOLTO = /^\s*[\[(]\s*[áa]udio\s*[\])]\s*:?\s*/i, RE_AUDIO_LINHA = /(^|\n)\s*[\[(]\s*[áa]udio\s*[\])]/i;
function partesTexto(s, out) {
  if (!RE_AUDIO_LINHA.test(s)) { out.push({ tipo: 'texto', t: s }); return; }
  let buf = [], fala = null;
  const fechaTexto = () => { if (buf.join('\n').trim()) out.push({ tipo: 'texto', t: buf.join('\n') }); buf = []; };
  const fechaFala = () => { if (fala !== null) { const f = fala.join(' ').trim(); if (f) out.push({ tipo: 'audio', t: f }); fala = null; } };
  for (const l of String(s).split('\n')) {
    if (RE_AUDIO_SOLTO.test(l)) { fechaFala(); fechaTexto(); fala = [l.replace(RE_AUDIO_SOLTO, '')]; }
    else if (fala !== null && l.trim() && !/^\s*---\s*$/.test(l)) fala.push(l.trim());   // a fala continua na linha de baixo
    else { fechaFala(); buf.push(l); }
  }
  fechaFala(); fechaTexto();
}
function partesResposta(t) {
  const out = []; let i = 0, m; RE_TTS.lastIndex = 0;
  while ((m = RE_TTS.exec(t))) {
    const antes = t.slice(i, m.index); if (antes.trim()) partesTexto(antes, out);
    const fala = String(m[1] || m[2] || '').trim(); if (fala) out.push({ tipo: 'audio', t: fala });
    i = RE_TTS.lastIndex;
  }
  const resto = t.slice(i); if (resto.trim()) partesTexto(resto, out);
  return out;
}
// A agenda (Escolha seu dia / Escolha seu horário / link) sai SEMPRE numa mensagem separada, no formato fixo do AGENTS.md (regra do Djhonata, 10/11/2026)
const RE_LINK_AGENDA = /hook\.us2\.make\.com\/\S+/i;
const linhaDaAgenda = (l) => /^(escolha (o )?seu (dia|hor[aá]rio)|marque (o )?seu hor[aá]rio)/i.test(String(l).trim());
function inicioAgenda(linhas, iLink) { let ini = iLink; for (let i = iLink - 1; i >= 0; i--) { const l = linhas[i].trim(); if (!l) continue; if (linhaDaAgenda(l)) { ini = i; continue; } break; } return ini; }
function agendaFixa() {   // o "Bloco fixo da agenda" do AGENTS.md, do jeito que está lá
  const t = lerTexto('AGENTS.md').replace(/\r/g, ''), i = t.search(/###\s*Bloco fixo da agenda/i); if (i < 0) return '';
  const linhas = t.slice(i).split('\n'), iLink = linhas.findIndex(l => RE_LINK_AGENDA.test(l)); if (iLink < 0) return '';
  return linhas.slice(inicioAgenda(linhas, iLink), iLink + 1).join('\n').trim();
}
// Fluxo de pagamento: vai sozinho numa mensagem (o cliente encaminha para a família); perguntas e comentários vão em outra.
function separarFluxo(t) {   // -> [texto antes, bloco da simulação, texto depois], só os que existem
  const linhas = String(t).split('\n'), ini = linhas.findIndex(l => /^\s*📋/.test(l));
  if (ini < 0) return [t];
  const doBloco = (l) => /^\s*(📋|💰|✅|🏦|💵)/.test(l) || /^\s*(Sem reforço, a parcela|Se preferir sem reforço|O pós-chaves depende|Simulação inicial, sujeita|É uma simulação inicial)/i.test(l);
  let fim = ini;
  for (let i = ini + 1; i < linhas.length; i++) { if (doBloco(linhas[i])) fim = i; else if (linhas[i].trim() && !doBloco(linhas[i])) break; }
  return [linhas.slice(0, ini).join('\n').trim(), linhas.slice(ini, fim + 1).join('\n').trim(), linhas.slice(fim + 1).join('\n').trim()].filter(Boolean);
}
function separarAgenda(t) {   // -> [texto antes, agenda, texto depois], só os que existem
  const linhas = String(t).split('\n'), iLink = linhas.findIndex(l => RE_LINK_AGENDA.test(l));
  if (iLink < 0) return [t];
  const ini = inicioAgenda(linhas, iLink);
  const bloco = agendaFixa() || linhas.slice(ini, iLink + 1).join('\n').trim();
  return [linhas.slice(0, ini).join('\n').trim(), bloco, linhas.slice(iLink + 1).join('\n').trim()].filter(Boolean);
}
// Convite para o escritório (regra do Djhonata, 10/11/2026): a agenda, a foto do escritório e o endereço com a localização vão no
// PRIMEIRO convite. Depois a assistente só lembra de marcar na agenda que já mandou. A agenda volta só se o cliente pedir (não achou,
// quer remarcar), numa retomada (se a última foi há mais de 1 dia), a pedido do Djhonata, ou depois de 7 dias (aí é um convite novo).
const FOTO_ESCRITORIO = 'escritorio/fachada.jpg';
const ENDERECO_ESCRITORIO = ENV.ENDERECO_ESCRITORIO || 'O endereço é Rua Dona Francisca, 1222 - Saguaçu, Joinville. Aqui a localização: https://share.google/rJ6TI7xChk5JvpKEN';
const ehEnderecoEscritorio = (t) => /dona francisca/i.test(t || '') && /(share\.google|maps|localiza)/i.test(t || '');
const AGENDA_VALE = 7 * 864e5;
const RE_PEDE_AGENDA = /\b(agenda|link|hor[aá]rios?|remarc\w*|desmarc\w*|cancel\w*)\b|outr[oa]s? (dia|data|hor[aá]rio)|n[aã]o (vou|vai|vamos) (poder|conseguir|dar)|n[aã]o (consigo|posso|consegui) ir|n[aã]o (achei|acho|encontr\w*|abr\w*)\b/i;
const LEMBRA_AGENDA = 'Me fala o dia e o horário que fica bom pra você que eu já marco aqui ✅';
function mandouHaPouco(jid, teste, ms) { const lim = Date.now() - ms; return lerEsp(jid).some(m => (m.ts || 0) >= lim && m.autor !== 'cliente' && teste(m)); }
function agendaEnviadaEm(jid) {   // última vez que a agenda saiu nesta conversa (desde o começo da memória da IA, para o teste "do zero" valer)
  const ini = (lerConv(jid)[0] || {}).ts || 0; let ult = 0;
  for (const m of lerEsp(jid)) if (m.autor !== 'cliente' && (m.ts || 0) >= ini && (m.ts || 0) > ult && RE_LINK_AGENDA.test(m.texto || '')) ult = m.ts;
  return ult;
}
function podeMandarAgenda(jid, extra) {
  const ult = agendaEnviadaEm(jid);
  if (!ult || Date.now() - ult > AGENDA_VALE) return true;                       // primeiro convite
  if (extra && extra.ordem) return true;                                          // o Djhonata pediu
  if (extra && extra.rotina) return extra.rotina === 'retomada' && Date.now() - ult > 24 * 3600e3;   // lembrete de visita vai sem agenda
  return RE_PEDE_AGENDA.test(textoRecenteCliente(jid));                          // o cliente pediu de novo (ou quer remarcar)
}
async function pacoteEscritorio(jid, autor, extra) {   // foto e endereço só no primeiro convite (não repete por 7 dias)
  const feitos = [];
  if (!mandouHaPouco(jid, m => m.arquivo === 'c/' + FOTO_ESCRITORIO, AGENDA_VALE) && fs.existsSync(path.join(CATALOGO, FOTO_ESCRITORIO))) {
    if (await enviarArquivo(jid, FOTO_ESCRITORIO, '', autor, extra) === 'Enviado.') feitos.push('[foto do escritório]');
  }
  if (!mandouHaPouco(jid, m => ehEnderecoEscritorio(m.texto), AGENDA_VALE) && await enviarTexto(jid, ENDERECO_ESCRITORIO, autor, extra)) feitos.push(ENDERECO_ESCRITORIO);
  return feitos;
}
async function enviarSaida(jid, texto, autor = 'ia', extra) {   // devolve o que saiu (para a memória da conversa)
  const feitos = [];
  if (autor === 'ia') texto = generoDoDono(texto);
  const proprio = String(texto || '').split('\n').filter(l => !RE_LINK_AGENDA.test(l) && !linhaDaAgenda(l)).join('\n');   // o texto da IA sem o bloco da agenda
  for (const p of partesResposta(String(texto || ''))) {
    if (p.tipo === 'audio') {
      const ok = await enviarAudio(jid, p.t, autor, extra);
      if (ok === true) { feitos.push('[[tts:' + p.t + ']]'); continue; }   // na memória fica com a marcação certa, para a IA não aprender outra
      if (ok === 'barrado') continue;
    }
    for (const parte of p.t.split(/\n\s*---\s*\n/)) for (const sub0 of separarFluxo(parte)) for (const sub of separarAgenda(sub0)) {
      let s = sub.replace(/^\s*---\s*$/gm, '').trim(); if (!s) continue;
      if (autor === 'ia' && ehEnderecoEscritorio(s) && mandouHaPouco(jid, m => ehEnderecoEscritorio(m.texto), 10 * 60e3)) continue;   // o endereço já foi junto com a agenda
      if (autor === 'ia' && RE_LINK_AGENDA.test(s) && !podeMandarAgenda(jid, extra)) {
        log('agenda não reenviada (já foi mandada e o cliente não pediu)', jid);
        // no lugar da agenda vai só o lembrete de marcar, se a própria resposta ainda não lembra da agenda que já foi
        if (feitos.includes(LEMBRA_AGENDA) || /(te (passei|mandei|enviei)|ali em cima|l[aá] em cima|acima)/i.test(proprio)) continue;
        s = LEMBRA_AGENDA;
      }
      if (await enviarTexto(jid, s, autor, extra)) { feitos.push(s); if (autor === 'ia' && RE_LINK_AGENDA.test(s)) feitos.push(...await pacoteEscritorio(jid, autor, extra)); }
    }
  }
  return feitos;
}
async function transcrever(buf, mime) {
  if (!buf || !buf.length) return '';
  const tipo = String(mime || 'audio/ogg').split(';')[0].trim() || 'audio/ogg';
  const ext = EXT_MIME[tipo] || 'ogg';
  let erro = '';
  if (ELEVEN_KEY) {
    for (const modelo of [...new Set([ENV.ELEVEN_STT || 'scribe_v2', 'scribe_v1'])]) {
      try {
        const fd = new FormData();
        fd.append('model_id', modelo); fd.append('language_code', 'pt'); fd.append('tag_audio_events', 'false');
        fd.append('file', new Blob([buf], { type: tipo }), 'audio.' + ext);
        const r = await fetch('https://api.elevenlabs.io/v1/speech-to-text', { method: 'POST', headers: { 'xi-api-key': ELEVEN_KEY }, body: fd });
        if (r.ok) { const j = await r.json(); ouvido.feitas++; ouvido.servico = 'ElevenLabs ' + modelo; return String(j.text || '').trim(); }
        erro = 'ElevenLabs ' + r.status + ' ' + (await r.text()).slice(0, 300);
        if (r.status === 401 || r.status === 403 || r.status === 429) break;
      } catch (e) { erro = 'ElevenLabs ' + e.message; break; }
    }
  }
  if (GEMINI_KEY) {
    for (const modelo of [...new Set([ENV.GEMINI_MODELO || 'gemini-3-flash-preview', 'gemini-2.5-flash'])]) {
      try {
        const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent`, { method: 'POST', headers: { 'x-goog-api-key': GEMINI_KEY, 'content-type': 'application/json' }, body: JSON.stringify({ contents: [{ parts: [{ inline_data: { mime_type: tipo, data: buf.toString('base64') } }, { text: 'Transcreva este áudio de WhatsApp em português do Brasil, palavra por palavra, sem comentários. Se não houver fala, responda vazio.' }] }] }) });
        if (r.ok) { const j = await r.json(); const c = ((j.candidates || [])[0] || {}).content; ouvido.feitas++; ouvido.servico = 'Gemini ' + modelo; return ((c && c.parts) || []).map(p => p.text || '').join('').trim(); }
        erro = 'Gemini ' + r.status + ' ' + (await r.text()).slice(0, 300);
        if (r.status === 401 || r.status === 403 || r.status === 429) break;
      } catch (e) { erro = 'Gemini ' + e.message; break; }
    }
  }
  if (erro) { ouvido.erros++; ouvido.ultimoErro = erro; log('transcrição falhou:', erro); }
  return '';
}
const ARQ_PODE_SAIR = /\.(jpe?g|png|webp|mp4|pdf)$/i;
async function enviarArquivo(jid, caminho, legenda, autor = 'ia', extra) {
  if (!sock || !conectado) return 'WhatsApp desconectado.';
  let conteudo, tipo, ref = '';
  if (/^https?:\/\//i.test(caminho)) { conteudo = { url: caminho }; tipo = EXT_VID.test(caminho) ? 'video' : 'image'; ref = caminho; }
  else {
    const rel = caminho.replace(/\\/g, '/').replace(/^[a-z]:\/+users\/+public\/+catalogo\/+/i, '').replace(/^\/+/, '');
    const abs = path.resolve(CATALOGO, rel);
    if (!abs.startsWith(CATALOGO + path.sep) || !fs.existsSync(abs)) return 'Arquivo não encontrado: ' + caminho;
    // Só foto, vídeo e PDF saem do catálogo. A ficha (ficha.md) e os arquivos de regras têm anotações internas: nunca vão para o WhatsApp (pedido do Djhonata, 13/11/2026;
    // a ficha foi para clientes 5 vezes em 11 e 12/11). O que o cliente precisa saber do imóvel vai por texto, com as palavras da assistente.
    if (!ARQ_PODE_SAIR.test(abs)) { log('arquivo interno barrado', jid, rel); return 'Não enviado: esse arquivo é interno (anotações da ficha) e não vai para o cliente. Não diga isso a ele. Se ele pediu informações do imóvel, responda por texto com os dados da ficha; se pediu a planta ou o projeto, mande o PDF do projeto, se a ficha tiver.'; }
    conteudo = fs.readFileSync(abs);
    tipo = EXT_IMG.test(abs) ? 'image' : EXT_VID.test(abs) ? 'video' : 'document';
    ref = 'c/' + rel;
  }
  try { await guardaEnvio(jid, autor, legenda, tipo); } catch (e) { return 'Não enviado: ' + e.message; }
  const msg = tipo === 'image' ? { image: conteudo, caption: legenda || undefined }
    : tipo === 'video' ? { video: conteudo, caption: legenda || undefined, mimetype: 'video/mp4' }
      : { document: conteudo, fileName: path.basename(caminho), caption: legenda || undefined, mimetype: /\.pdf$/i.test(caminho) ? 'application/pdf' : 'application/octet-stream' };
  const r = await sock.sendMessage(jid, msg);
  const id = lembrarEnvio(r);
  registrarEspelho(jid, Object.assign({ id, autor, tipo, texto: legenda || '', arquivo: ref, nomeArquivo: tipo === 'document' ? path.basename(caminho) : undefined, ts: Date.now() }, extra || {}));
  return 'Enviado.';
}
async function enviarFotoPainel(jid, buf, mime, legenda) {
  if (!sock || !conectado) throw new Error('WhatsApp desconectado');
  const ext = EXT_MIME[mime] || 'jpg';
  const nome = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(MIDIA, nome), buf);
  const r = await sock.sendMessage(jid, { image: buf, caption: legenda || undefined });
  const id = lembrarEnvio(r);
  registrarEspelho(jid, { id, autor: 'voce', tipo: 'image', texto: legenda || '', arquivo: 'm/' + nome, ts: Date.now() });
  anotar(jid, 'assistant', `(Djhonata escreveu) [mandou uma foto]${legenda ? ' ' + legenda : ''}`);
}

function desembrulhar(m) {
  let x = m.message || {};
  for (let i = 0; i < 4; i++) {
    const inner = x.ephemeralMessage || x.viewOnceMessage || x.viewOnceMessageV2 || x.viewOnceMessageV2Extension || x.documentWithCaptionMessage || x.editedMessage || x.deviceSentMessage || x.futureProofMessage || x.associatedChildMessage || x.botInvokeMessage || x.groupMentionedMessage;
    if (inner && inner.message) x = inner.message; else break;
  }
  return x;
}
function textoDe(x) {
  return x.conversation || (x.extendedTextMessage && x.extendedTextMessage.text) || (x.imageMessage && x.imageMessage.caption) ||
    (x.videoMessage && x.videoMessage.caption) || (x.documentMessage && x.documentMessage.caption) ||
    (x.buttonsResponseMessage && x.buttonsResponseMessage.selectedDisplayText) || (x.listResponseMessage && x.listResponseMessage.title) ||
    (x.contactMessage && x.contactMessage.displayName) || (x.locationMessage && [x.locationMessage.name, x.locationMessage.address].filter(Boolean).join(' · ')) || '';
}
function jidValido(jid) { return jid && !jid.endsWith('@g.us') && !jid.endsWith('@broadcast') && !jid.endsWith('@newsletter') && jid !== 'status@broadcast'; }
function tsDe(m) { return (Number(m.messageTimestamp && (m.messageTimestamp.low || m.messageTimestamp)) || Math.floor(Date.now() / 1000)) * 1000; }

// fila por conversa: junta as mensagens do cliente e responde depois de alguns segundos de silêncio
const filas = new Map();

async function aoReceber(m, tipoUpsert) {
  const jid = m.key.remoteJid || '';
  if (!jidValido(jid)) return;
  const cifrada = !m.message && m.messageStubType === 2;   // chegou cifrada e ainda não foi decifrada
  const x = desembrulhar(m);
  if (x.protocolMessage || x.reactionMessage || (x.senderKeyDistributionMessage && Object.keys(x).length === 1)) return;
  const texto = cifrada ? '🔒 (mensagem ainda não decifrada — veja no celular)' : textoDe(x);
  const tipo = tipoDe(x);
  const ts = tsDe(m);
  // "append" = o WhatsApp entregou atrasado o que chegou enquanto a conexão caía e voltava (ou o servidor reiniciava)
  const atrasada = tipoUpsert === 'append';
  const recente = Date.now() - ts < (atrasada ? JANELA_ATRASADA : 180e3);
  const telefone = telefoneDe(m);
  if (!m.key.fromMe && !cifrada && tipoUpsert !== 'historico') marcarOrigem(jid, x, texto, ts);

  // espelho: grava tudo (menos o que a própria ponte já gravou ao enviar)
  if (!(m.key.fromMe && enviados.has(m.key.id))) {
    let midia = null;
    if (tipo !== 'text' && tipo !== 'contact' && tipo !== 'location' && recente) midia = await guardarMidia(m, x, tipo);
    m._midia = midia;
    registrarEspelho(jid, {
      id: m.key.id, autor: m.key.fromMe ? 'celular' : 'cliente', tipo, texto,
      arquivo: midia ? midia.arquivo : undefined, nomeArquivo: x.documentMessage ? x.documentMessage.fileName : undefined,
      nome: m.key.fromMe ? undefined : (m.pushName || undefined), telefone: telefone || undefined, ts
    }, { silencioso: tipoUpsert === 'historico' });
    // áudio recebido (do cliente ou mandado pelo celular): transcreve e mostra o texto no CRM
    if (tipo === 'audio' && midia && midia.buf && (ELEVEN_KEY || GEMINI_KEY)) {
      const seg = Number((x.audioMessage && x.audioMessage.seconds) || 0);
      if (!seg || seg <= 600) {
        m._transc = await transcrever(midia.buf, midia.mime).catch(() => '');
        if (m._transc) registrarEspelho(jid, { id: m.key.id, autor: m.key.fromMe ? 'celular' : 'cliente', tipo: 'audio', texto: m._transc, transc: true, ts }, { silencioso: true });
      }
    }
  }
  if (cifrada && !m.key.fromMe && recente && (tipoUpsert === 'notify' || atrasada)) agendarSemDecifrar(m, jid, ts, telefone);
  if (cifrada) return;   // sem conteúdo ainda: quando o WhatsApp reenviar decifrada, ela passa por aqui de novo
  if (!recente) return; // mensagem antiga (sincronização do histórico): só espelho

  if (m.key.fromMe) {
    if (enviados.has(m.key.id)) return; // foi a ponte (assistente ou painel)
    // escrito no celular ou em outro aparelho conectado
    if (/^#bot\b/i.test(texto.trim())) { delete estado.pausas[jid]; salvarEstado(); emitir('chat', chatPublico(jid)); log('assistente reativada em', jid); return; }
    if (/^#pausa\b/i.test(texto.trim())) { estado.pausas[jid] = Date.now() + 3650 * 864e5; salvarEstado(); emitir('chat', chatPublico(jid)); return; }
    if (texto || tipo !== 'text') anotar(jid, 'assistant', `(Djhonata escreveu) ${texto || (m._transc ? '[mandou um áudio] ' + m._transc : '[' + tipo + ']')}`);
    if (PAUSA_HORAS > 0) { estado.pausas[jid] = Date.now() + PAUSA_HORAS * 3600e3; salvarEstado(); filas.delete(jid); emitir('chat', chatPublico(jid)); }
    return;
  }
  if (tipoUpsert !== 'notify' && !atrasada) return;

  const dono = telefone && normal(telefone) === normal(DONO);
  if (!dono && telefone && lerBloqueados().has(normal(telefone))) { log('bloqueado, ignorado', telefone); return; }
  if (!dono) { try { fuClienteFalou(jid, telefone, ts); } catch (e) { } }

  let entrada = texto;
  let imagem = null;
  const quemFala = dono && !(estado.teste && estado.teste.ativo) ? 'do Djhonata' : 'do cliente';
  if (x.audioMessage) entrada = (entrada ? entrada + '\n' : '') + (m._transc ? `[áudio ${quemFala}, transcrito]: "${m._transc}"` : `[o ${quemFala === 'do cliente' ? 'cliente' : 'Djhonata'} mandou um áudio que não deu para transcrever]`);
  if (x.imageMessage) {
    const buf = m._midia && m._midia.buf;
    if (buf && buf.length < 4.5e6) imagem = { data: buf.toString('base64'), mime: m._midia.mime || 'image/jpeg' };
    entrada = (entrada ? entrada + '\n' : '') + '[o cliente mandou uma imagem]';
  }
  if (x.videoMessage) entrada = (entrada ? entrada + '\n' : '') + '[o cliente mandou um vídeo]';
  if (x.documentMessage) entrada = (entrada ? entrada + '\n' : '') + `[o cliente mandou um arquivo: ${x.documentMessage.fileName || ''}]`;
  if (x.contactMessage || x.contactsArrayMessage) entrada = (entrada ? entrada + '\n' : '') + textoDoContato(x);
  if (x.locationMessage) entrada = (entrada ? entrada + '\n' : '') + '[o cliente mandou uma localização]';
  if (x.stickerMessage) entrada = (entrada ? entrada + '\n' : '') + '[figurinha]';
  if (!entrada) return;
  if (m.key.id && lerConv(jid).some(e => e.mid === m.key.id)) return;   // o WhatsApp reentregou: a IA já leu essa
  if (atrasada) log('mensagem atrasada (chegou na reconexão) entrou na fila', telefone || jid);
  if (Date.now() - ts > 20 * 60e3) entrada = avisoDemora(ts) + entrada;

  anotar(jid, 'user', entrada, m.key.id);
  // preferência de áudio do cliente: pediu áudio / pediu para não mandar áudio (vale para as próximas respostas)
  const falou = (texto || '') + ' ' + (m._transc || '');
  if (/n[ãa]o\s+(consigo|posso|d[áa]\s+pra|tenho\s+como)\s+(ouvir|escutar)|n[ãa]o\s+(me\s+)?(mand[ae]|envi[ae])\s+([áa]udio)|s[óo]\s+(por\s+)?(texto|escrito|mensagem)/i.test(falou)) { estado.prefAudio = estado.prefAudio || {}; estado.prefAudio[jid] = -Date.now(); salvarEstado(); }
  else if (/(mand[ae]|manda\s+um|fala|explica|responde|envia|pode\s+mandar|conversar|me\s+explica)[^.?!]{0,25}\b(em|por|no|um|de)?\s*[áa]udio/i.test(falou)) { estado.prefAudio = estado.prefAudio || {}; estado.prefAudio[jid] = Date.now(); salvarEstado(); }
  let f = filas.get(jid);
  if (!f) { f = { jid, telefone, nome: m.pushName || '', dono, imagens: [], timer: null }; filas.set(jid, f); }
  if (m.pushName) f.nome = m.pushName;
  if (imagem) f.imagens.push(imagem);
  if (x.audioMessage) f.audio = true;
  f.ultTs = Math.max(f.ultTs || 0, ts);
  deverResposta(jid, ts);
  clearTimeout(f.timer);
  // cada mensagem nova zera a espera; assim a assistente lê tudo que ele mandou antes de responder uma vez só
  const txtAgora = String(x.conversation || (x.extendedTextMessage && x.extendedTextMessage.text) || '').trim();
  const curta = !dono && txtAgora && txtAgora.length <= 22 && !/[?]/.test(txtAgora);
  f.timer = setTimeout(() => processar(jid).catch(e => log('erro processar', e.message)), dono ? Math.min(ESPERA_MS, 9000) : (curta ? ESPERA_CURTA_MS : ESPERA_MS));
}

// ---------- anúncio -> imóvel (pedido do Djhonata, 12/11/2026) ----------
// O WhatsApp manda o código do anúncio junto da 1ª mensagem. O CRM diz de qual imóvel é cada anúncio (ou se é genérico)
// e a assistente já abre o atendimento com o imóvel certo, sem mexer nos anúncios.
const ADS_ARQ = path.join(DADOS, 'anuncios-imoveis.json');
let adsMapa = lerJson(ADS_ARQ, null) || {};   // { código do anúncio: { nome, pasta, generico, em } }
function adsVistos() {   // anúncios que já trouxeram cliente (pelo que está guardado nas conversas), do mais recente para o mais antigo
  const v = {}; let semCodigo = 0;
  for (const c of Object.values(chats)) {
    const a = c && c.anuncio; if (!a || a.pelaMensagem) continue;
    if (!a.anuncioId) { semCodigo++; continue; }
    const x = v[a.anuncioId] || (v[a.anuncioId] = { id: a.anuncioId, titulo: '', link: '', n: 0, ult: 0 });
    x.n++; if ((a.em || 0) >= x.ult) { x.ult = a.em || 0; x.titulo = a.titulo || x.titulo; x.link = a.link || x.link; }
  }
  return { lista: Object.values(v).sort((a, b) => b.ult - a.ult).slice(0, 80), semCodigo };
}
function adsDoChat(jid) {   // { id, titulo, pasta, generico } do anúncio que trouxe este cliente, ou null
  const a = (chats[jid] || {}).anuncio; if (!a || a.pelaMensagem) return null;
  const m = a.anuncioId ? adsMapa[a.anuncioId] : null;
  return { id: a.anuncioId || '', titulo: a.titulo || '', em: a.em || 0, pasta: m && m.pasta && pastasImoveis().includes(m.pasta) ? m.pasta : '', generico: !!(m && m.generico) };
}
function adsContexto(jid, jaFalou) {   // linha que entra nas instruções da conversa nos 3 primeiros dias depois do clique
  const c = chats[jid] || {}, novo = c.anuncioAtual && c.anuncioAtual.em > ((c.anuncio || {}).em || 0) && Date.now() - c.anuncioAtual.em < 3 * 864e5 ? c.anuncioAtual : null;
  if (novo) {   // já estava em atendimento e clicou em outro anúncio
    const m = novo.anuncioId ? adsMapa[novo.anuncioId] : null, pasta = m && m.pasta && pastasImoveis().includes(m.pasta) ? m.pasta : '';
    if (pasta) return `\nANÚNCIO NOVO: este cliente já estava em atendimento e clicou agora (${quandoFoi(novo.em)}) no anúncio do imóvel ${dadosDaFicha(pasta).nome} (pasta "${pasta}"). Não se apresente de novo e não pergunte qual imóvel é: se você ainda não mandou esse imóvel nesta conversa, mande ele (ler_ficha, o vídeo ou a foto e a descrição) e pergunte se foi esse que chamou a atenção.`;
    if (novo.titulo && !(m && m.generico)) return `\nANÚNCIO NOVO: este cliente já estava em atendimento e clicou agora (${quandoFoi(novo.em)}) em outro anúncio, de título "${novo.titulo}". Não se apresente de novo; use o título para saber de qual imóvel ele está falando.`;
  }
  const a = adsDoChat(jid); if (!a || !a.em || Date.now() - a.em > 3 * 864e5) return '';
  if (a.pasta) return `\nANÚNCIO: este cliente chegou pelo anúncio do imóvel ${dadosDaFicha(a.pasta).nome} (pasta "${a.pasta}"). Se você ainda não mandou esse imóvel nesta conversa, ${jaFalou ? 'mande ele, sem se apresentar de novo' : 'apresente-se e já mande ele'} (ler_ficha, o vídeo ou a foto e a descrição), perguntando se foi esse que ele viu no anúncio. Não pergunte o bairro antes. Se ele disser que viu outro, pergunte qual ou o bairro e siga normalmente.`;
  if (a.generico) return jaFalou ? '' : `\nANÚNCIO: este cliente chegou por um anúncio genérico, que não é de um imóvel específico. Faça a abertura normal e pergunte o bairro.`;
  if (a.titulo) return `\nANÚNCIO: este cliente chegou pelo anúncio de título "${a.titulo}", que ainda não está ligado a um imóvel. Se o título disser o bairro ou o imóvel, use isso na abertura; se for um título geral, pergunte o bairro.`;
  return '';
}

// ---------- 1ª mensagem que o WhatsApp não decifrou (decisão do Djhonata, 12/11/2026) ----------
// Se em 2 minutos o conteúdo não chegar e ninguém respondeu, a assistente faz a abertura normal, como com qualquer lead novo.
const SEM_DECIFRAR_MS = Number(ENV.SEM_DECIFRAR_MS || 120e3), semDecifrarVistas = new Set();
function agendarSemDecifrar(m, jid, ts, telefone) {
  const id = m.key.id; if (!id || semDecifrarVistas.has(id)) return; semDecifrarVistas.add(id);
  if (semDecifrarVistas.size > 2000) semDecifrarVistas.clear();
  setTimeout(() => {
    try {
      if (lerConv(jid).length) return;                               // a mensagem abriu nesse meio tempo, ou não era o primeiro contato
      if (lerEsp(jid).some(e => e.autor !== 'cliente')) return;      // alguém já respondeu (assistente, celular ou painel)
      if (filas.has(jid) || ocupado.has(jid)) return;
      if (telefone && (normal(telefone) === normal(DONO) || lerBloqueados().has(normal(telefone)))) return;
      anotar(jid, 'user', '[O cliente mandou a primeira mensagem, mas o WhatsApp não entregou o conteúdo dela para você. Trate como o primeiro contato de um lead novo: faça a abertura normal. Não diga que a mensagem não abriu.]', id + ':sem-decifrar');
      const c = chatPublico(jid);
      filas.set(jid, { jid, telefone: telefone || c.telefone, nome: m.pushName || c.nome || '', dono: false, imagens: [], timer: null, ultTs: ts });
      deverResposta(jid, ts);
      log('primeira mensagem não decifrada: a assistente faz a abertura', telefone || jid);
      processar(jid).catch(e => log('erro processar', e.message));
    } catch (e) { log('sem decifrar', e.message); }
  }, SEM_DECIFRAR_MS);
}

// ---------- de onde veio o lead: anúncio de WhatsApp da Meta (clique no anúncio) ----------
// O WhatsApp manda junto da 1ª mensagem os dados do anúncio (externalAdReply / conversionSource). Se não vier, a mensagem
// pronta do anúncio ("Olá! Posso ter mais informações sobre isso?") também indica o anúncio.
const RE_MSG_ANUNCIO = /^\s*ol[áa]!?\s*(posso ter mais informa[çc][õo]es|tenho interesse e queria mais informa[çc][õo]es|quero mais informa[çc][õo]es|gostaria de (saber )?mais informa[çc][õo]es)/i;
function dadosAnuncio(x) {
  for (const k of Object.keys(x || {})) {
    const ci = x[k] && typeof x[k] === 'object' ? x[k].contextInfo : null; if (!ci) continue;
    const ad = ci.externalAdReply || null, fonte = String(ci.conversionSource || ci.entryPointConversionSource || '');
    if ((ad && (ad.sourceType === 'ad' || ad.ctwaClid || ad.sourceId)) || /ad|ctwa/i.test(fonte)) return { titulo: String((ad && (ad.title || ad.body)) || '').slice(0, 120), link: String((ad && ad.sourceUrl) || ''), anuncioId: String((ad && ad.sourceId) || ''), app: String(ci.entryPointConversionApp || '') };
  }
  return null;
}
// Cartão de contato (ex.: indicação): passa para a assistente o nome e o número que vieram no cartão.
function textoDoContato(x) {
  try {
    const cs = x.contactMessage ? [x.contactMessage] : ((x.contactsArrayMessage && x.contactsArrayMessage.contacts) || []);
    const lista = cs.slice(0, 5).map(c => { const v = String(c.vcard || ''); const tel = ((v.match(/waid=(\d{8,15})/) || [])[1] ? '+' + v.match(/waid=(\d{8,15})/)[1] : ((v.match(/TEL[^:\n]*:([+\d\s().-]{8,})/) || [])[1] || '').trim()); return `${String(c.displayName || '').trim() || 'sem nome'}${tel ? ', número ' + tel : ''}`; }).filter(Boolean).join('; ');
    return lista ? `[o cliente mandou um cartão de contato: ${lista}]` : '[o cliente mandou um contato]';
  } catch (e) { return '[o cliente mandou um contato]'; }
}
function marcarOrigem(jid, x, texto, ts) {
  const c = chats[jid] || (chats[jid] = {}); let mudou = false;
  if (!c.primeira || ts < c.primeira) { c.primeira = ts; mudou = true; }
  const ad = dadosAnuncio(x);
  if (c.anuncio && ad && ad.anuncioId && ts > (c.anuncio.em || 0) + 60e3) {   // cliente que já estava aqui clicou em outro anúncio: a origem (c.anuncio) fica, o mais recente vai à parte
    const ult = c.anuncioAtual || c.anuncio;
    if (ad.anuncioId !== ult.anuncioId || ts > (ult.em || 0) + 6 * 3600e3) { c.anuncioAtual = Object.assign({ em: ts }, ad); mudou = true; log('novo clique em anúncio', c.telefone || jid, ad.titulo || ''); }
  }
  if (!c.anuncio) {
    if (ad) { c.anuncio = Object.assign({ em: ts }, ad); mudou = true; log('lead do anúncio', c.telefone || jid, ad.titulo || ''); }
    else if (RE_MSG_ANUNCIO.test(String(texto || '')) && Math.abs(ts - c.primeira) < 6 * 3600e3) { c.anuncio = { em: ts, titulo: '', pelaMensagem: true }; mudou = true; }
  }
  if (mudou) salvarChats();
}
const ocupado = new Set();
async function processar(jid) {
  const f = filas.get(jid);
  if (!f) return;
  f.timer = null;
  const emTeste = !!(estado.teste && estado.teste.ativo);
  if (emTeste) {                                                             // modo teste: responde SÓ os números de teste, como se fossem clientes
    if (!ehNumeroTeste(jid, f.telefone)) { filas.delete(jid); return; }   // cliente de verdade: fica devendo e é respondido quando o teste acabar
    f.dono = false;
  } else if (!estado.ativo) { filas.delete(jid); quitarResposta(jid); return; }                  // assistente pausada: só espelha
  if ((estado.pausas[jid] || 0) > Date.now()) { filas.delete(jid); quitarResposta(jid); return; } // assistente desligada nessa conversa
  if (!dentroDoHorario() && !f.dono && !emTeste) { return; }                // fica na fila até abrir o horário
  if (ocupado.has(jid)) { f.timer = setTimeout(() => processar(jid).catch(e => log('erro processar', e.message)), 3000); return; }
  if (!sock || !conectado) { f.timer = setTimeout(() => processar(jid).catch(e => log('erro processar', e.message)), 15e3); return; }   // WhatsApp caindo: espera voltar
  // o Djhonata respondeu (celular ou CRM) depois da última mensagem do cliente: a conversa é dele agora
  const conv = lerConv(jid), ultConv = conv[conv.length - 1];
  if (!f.dono && ultConv && ultConv.role === 'assistant' && /^\(Djhonata escreveu\)/.test(ultConv.texto || '')) {
    filas.delete(jid); quitarResposta(jid, f.ultTs); log('o Djhonata já respondeu; a assistente fica quieta', f.telefone || jid); return;
  }
  filas.delete(jid);
  ocupado.add(jid);
  if (f.liberar24h) liberado24h.add(jid);   // "responder agora" pedido pelo Djhonata
  emitir('digitando', { jid, on: true });
  try { await responder(f); if (!f.refazer) quitarResposta(jid, f.ultTs); }
  catch (e) { falhouResposta(jid, f, e); throw e; }
  finally { if (f.liberar24h) liberado24h.delete(jid); ocupado.delete(jid); emitir('digitando', { jid, on: false }); }
}
setInterval(() => { if (dentroDoHorario()) for (const [jid, f] of filas) { if (!f.timer) processar(jid).catch(e => log('erro processar', e.message)); } }, 60e3);

// ---------- respostas devidas: o que o cliente mandou e a assistente ainda não respondeu ----------
// Fica gravado no estado, então sobrevive a queda do WhatsApp, reinício do servidor e erro da IA (tenta até 3 vezes).
function deverResposta(jid, ts, extra) {
  const d = estado.devendo || (estado.devendo = {}); const v = d[jid];
  d[jid] = Object.assign({ ts: Math.max(ts || 0, v ? v.ts || 0 : 0), tent: v ? v.tent || 0 : 0, em: v ? v.em || 0 : 0 }, v && v.liberar24h ? { liberar24h: true } : {}, extra || {});
  salvarEstado();
}
function quitarResposta(jid, ate) {   // respondeu (ou não era para responder): apaga, a não ser que já tenha chegado mensagem mais nova
  const d = estado.devendo || {}, v = d[jid]; if (!v) return;
  if (ate && (v.ts || 0) > ate) return;
  delete d[jid]; salvarEstado();
}
function falhouResposta(jid, f, e) {
  const d = estado.devendo || {}, v = d[jid]; if (!v) return;
  const erro = String((e && e.message) || e || 'erro').slice(0, 160);
  v.tent = (v.tent || 0) + 1; v.erro = erro;
  v.em = /WhatsApp/.test(erro) ? 0 : Date.now();   // caiu o WhatsApp: tenta assim que voltar; erro da IA: espera uns minutos
  if (v.tent >= 3) {
    delete d[jid];
    const c = chatPublico(jid);
    log('desisti de responder depois de 3 tentativas', c.telefone || jid, erro);
    if (!f.dono) enviarTexto(DONO + '@s.whatsapp.net', `⚠️ Não consegui responder ${c.nome || 'um cliente'} (${c.telefone ? formatoBR(c.telefone) : 'sem número'}) depois de 3 tentativas (${erro}). Responda pelo celular, por favor.`, 'aviso').catch(() => { });
  } else log('a resposta falhou; tento de novo', f.telefone || jid, v.tent + '/3', erro);
  salvarEstado();
}
async function retomarPendentes(motivo) {   // põe de volta na fila quem ficou sem resposta (queda, reinício, erro)
  if (!sock || !conectado) return 0;
  const d = estado.devendo || {}; let n = 0;
  for (const [jid, v] of Object.entries(d)) {
    if (filas.has(jid) || ocupado.has(jid)) continue;
    if (Date.now() - (v.ts || 0) > JANELA_ATRASADA) { delete d[jid]; salvarEstado(); continue; }   // velha demais: não responde mais
    if (v.em && Date.now() - v.em < 4 * 60e3) continue;   // falhou agora há pouco: espera um pouco
    const c = chatPublico(jid);
    if (estado.teste && estado.teste.ativo && !ehNumeroTeste(jid, c.telefone)) continue;   // em teste: guarda para quando o teste acabar
    if (!(estado.teste && estado.teste.ativo) && !estado.ativo) continue;                     // assistente pausada: não responde
    const conv = lerConv(jid), ultC = conv[conv.length - 1];
    if (Date.now() - (v.ts || 0) > 20 * 60e3 && ultC && ultC.role === 'user' && !/ficou sem resposta até agora/.test(ultC.texto || '')) anotar(jid, 'user', avisoDemora(v.ts).trim());
    const f = { jid, telefone: c.telefone, nome: c.nome, dono: !!c.telefone && normal(c.telefone) === normal(DONO), imagens: [], timer: null, ultTs: v.ts, liberar24h: !!v.liberar24h };
    filas.set(jid, f); n++;
    log('retomando resposta pendente (' + motivo + ')', c.telefone || jid);
    if (f.dono || dentroDoHorario()) processar(jid).catch(e => log('erro processar', e.message));   // fora do horário: espera abrir
  }
  return n;
}
setInterval(() => retomarPendentes('varredura').catch(e => log('pendentes', e.message)), 5 * 60e3);

// Mensagens do cliente que estão no espelho e nunca entraram na fila (ex.: chegaram antes desta correção): o CRM pede e a IA responde.
function entradaDoEspelho(m) {
  const t = String(m.texto || '').trim();
  if (/^🔒/.test(t)) return '';
  if (m.tipo === 'audio') return t ? `[áudio do cliente, transcrito]: "${t}"` : '[o cliente mandou um áudio que não deu para transcrever]';
  const rot = { image: '[o cliente mandou uma imagem]', video: '[o cliente mandou um vídeo]', document: `[o cliente mandou um arquivo: ${m.nomeArquivo || ''}]`, sticker: '[figurinha]', contact: '[o cliente mandou um contato]', location: '[o cliente mandou uma localização]' }[m.tipo];
  return rot ? (t && m.tipo !== 'sticker' ? t + '\n' : '') + rot : t;
}
function reenfileirar(jid, motivo, orientacao) {   // orientacao = o que o Djhonata quer nessa resposta (opcional)
  if (!jidValido(jid) || !chats[jid]) return { erro: 'conversa não encontrada' };
  if (filas.has(jid) || ocupado.has(jid)) return { erro: 'essa conversa já está na fila da assistente' };
  const c = chatPublico(jid);
  if (c.telefone && normal(c.telefone) === normal(DONO)) return { erro: 'essa é a conversa do Djhonata' };
  if (!podeResponder(jid, c.telefone)) return { erro: 'a assistente está desligada, em teste ou pausada nessa conversa' };
  if (c.telefone && lerBloqueados().has(normal(c.telefone))) return { erro: 'número bloqueado para a assistente' };
  const l = lerEsp(jid), pend = [];
  for (let i = l.length - 1; i >= 0; i--) { const m = l[i]; if (m.autor === 'aviso') continue; if (m.autor !== 'cliente') break; pend.unshift(m); }
  // sem mensagem nova do cliente: só vale como ordem do Djhonata (com orientação), e dentro de 24h da última mensagem dele
  const ultCliMsg = pend.length ? pend[pend.length - 1] : [...l].reverse().find(m => m.autor === 'cliente');
  if (!pend.length && !orientacao) return { erro: 'a última mensagem não é do cliente: não há o que responder' };
  if (!ultCliMsg) return { erro: 'o cliente ainda não mandou mensagem nessa conversa' };
  if (!pend.length && Date.now() - ultCliMsg.ts > 24 * 3600e3) return { erro: 'o cliente não fala há mais de 24h: a assistente não puxa conversa' };
  const ult = ultCliMsg;
  if (Date.now() - ult.ts > 7 * 864e5) return { erro: 'a última mensagem do cliente tem mais de 7 dias' };
  const conv = lerConv(jid), ja = new Set(conv.map(e => e.mid).filter(Boolean));
  const ultUser = conv.reduce((t, e) => e.role === 'user' ? Math.max(t, e.ts || 0) : t, 0);
  const ultAssist = conv.reduce((t, e) => e.role === 'assistant' ? Math.max(t, e.ts || 0) : t, 0);
  // a IA não tem o começo desta conversa (foi atendida antes pelo celular/OpenClaw): leva as últimas mensagens do WhatsApp
  const corte = pend.length ? pend[0].ts : Infinity;
  const antes = l.filter(m => m.ts < corte && m.autor !== 'aviso' && (String(m.texto || '').trim() || m.tipo !== 'text')).slice(-12);
  const ultEuro = antes.filter(m => m.autor !== 'cliente').pop();
  if (ultEuro && ultAssist < ultEuro.ts - 60e3) {
    const linhas = antes.map(m => `${quandoFoi(m.ts)} ${m.autor === 'cliente' ? 'Cliente' : 'Euro'}: ${resumoMsg(m).replace(/\s+/g, ' ').slice(0, 500)}`);
    anotar(jid, 'user', '[conversa anterior neste WhatsApp, só para você saber o que já foi falado e oferecido (não responda a isto):\n' + linhas.join('\n') + ']');
  }
  let novas = 0, avisou = false;
  for (const m of pend) {
    if (ja.has(m.id) || m.ts <= ultUser) continue;   // essa a IA já tem na conversa
    let e = entradaDoEspelho(m); if (!e) continue;
    if (!avisou && Date.now() - m.ts > 20 * 60e3) { e = avisoDemora(m.ts) + e; avisou = true; }
    anotar(jid, 'user', e, m.id); novas++;
  }
  if (pend.length && !avisou && Date.now() - ult.ts > 20 * 60e3) anotar(jid, 'user', avisoDemora(ult.ts).trim());
  if (orientacao) anotar(jid, 'user', pend.length ? `[orientação do Djhonata para esta resposta (o cliente não vê isto): ${String(orientacao).slice(0, 1500)}]` : `[ORDEM DO DJHONATA — não é mensagem do cliente, ele não mandou nada novo. Mande agora o que o Djhonata pediu, continuando a conversa de forma natural (o cliente não vê isto): ${String(orientacao).slice(0, 1500)}]`);
  // pedido do Djhonata vale como ordem dele: passa pela regra das 24h (a assistente não puxa conversa sozinha)
  const f = { jid, telefone: c.telefone, nome: c.nome, dono: false, imagens: [], timer: null, ultTs: ult.ts, audio: pend.some(m => m.tipo === 'audio'), liberar24h: true };
  filas.set(jid, f); deverResposta(jid, ult.ts, { liberar24h: true });
  log('responder agora (' + motivo + ')', c.telefone || jid, pend.length, 'mensagem(ns) do cliente', orientacao ? 'com orientação' : '');
  if (dentroDoHorario()) f.timer = setTimeout(() => processar(jid).catch(e => log('erro processar', e.message)), 1500);
  return { ok: true, mensagens: pend.length, novas, orientacao: !!orientacao, agora: dentroDoHorario() };
}

// Quem escreveu enquanto a assistente estava pausada: ao religar, entra na fila (um a cada ~25 s, com o aviso de demora).
function responderPausados(desde, motivo) {
  desde = Math.max(Number(desde) || 0, Date.now() - 24 * 3600e3);
  const feitos = [], pulados = [];
  for (const jid of Object.keys(chats)) {
    if (!jidValido(jid)) continue;
    const c = chats[jid]; if (!c || c.arquivado || (c.ultCliente || 0) < desde) continue;
    const l = lerEsp(jid); let ult = null;
    for (let i = l.length - 1; i >= 0; i--) { if (l[i].autor === 'aviso') continue; ult = l[i]; break; }
    if (!ult || ult.autor !== 'cliente' || ult.ts < desde) continue;
    const p = chatPublico(jid), r = reenfileirar(jid, motivo);
    if (r.erro) { pulados.push((p.telefone || jid) + ': ' + r.erro); continue; }
    const f = filas.get(jid);
    if (f && f.timer) { clearTimeout(f.timer); f.timer = setTimeout(() => processar(jid).catch(e => log('erro processar', e.message)), 1500 + feitos.length * 25e3); }
    feitos.push(p.telefone || jid);
  }
  if (feitos.length || pulados.length) log('respondendo quem escreveu na pausa:', feitos.length, 'na fila;', pulados.length, 'pulados');
  return { feitos, pulados };
}
function ligarOuPausar(on, quem) {
  const antes = !!estado.ativo; estado.ativo = !!on;
  if (!estado.ativo && antes) estado.pausadaEm = Date.now();
  let r = null;
  if (estado.ativo && !antes) { const d = estado.pausadaEm || 0; delete estado.pausadaEm; if (d && sock && conectado) { try { r = responderPausados(d, 'assistente religada'); } catch (e) { log('pausados', e.message); } } }
  salvarEstado(); log('assistente', estado.ativo ? 'LIGADA' : 'PAUSADA', '(' + quem + ')'); emitir('estado', estadoPublico());
  return r;
}

function montarMensagens(jid, imagens, rotina) {
  const h = lerConv(jid).slice(-40);
  const msgs = [];
  for (const it of h) {
    const role = it.role === 'assistant' ? 'assistant' : 'user';
    const txt = role === 'assistant' ? String(it.texto || '').replace(/^\[áudio\] (.*)$/gm, '[[tts:$1]]') : it.texto;   // áudios guardados no formato antigo
    if (msgs.length && msgs[msgs.length - 1].role === role) msgs[msgs.length - 1].content[0].text += '\n' + txt;
    else msgs.push({ role, content: [{ type: 'text', text: txt }] });
  }
  while (msgs.length && msgs[0].role !== 'user') msgs.shift();
  if (rotina) {   // rotina automática (lembrete/retomada): instrução do sistema no fim, como última "mensagem"
    if (msgs.length && msgs[msgs.length - 1].role === 'user') msgs[msgs.length - 1].content[0].text += '\n\n' + rotina;
    else msgs.push({ role: 'user', content: [{ type: 'text', text: rotina }] });
  }
  if (!msgs.length || msgs[msgs.length - 1].role !== 'user') msgs.push({ role: 'user', content: [{ type: 'text', text: '(sem mensagem nova)' }] });
  const ult = msgs[msgs.length - 1];
  for (const im of imagens.slice(-3)) ult.content.unshift({ type: 'image', source: { type: 'base64', media_type: im.mime, data: im.data } });
  return msgs;
}

async function claude(system, messages, ferramentas = FERRAMENTAS) {
  for (let tentativa = 0; tentativa < 3; tentativa++) {
    let r;
    try {
      r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        // a IA pensa antes de responder: 1500 era pouco e às vezes acabava só pensando (max_tokens)
        body: JSON.stringify({ model: MODELO, max_tokens: 4000, system, tools: ferramentas, messages })
      });
    } catch (e) {   // internet do servidor oscilou ("fetch failed"): tenta de novo
      log('erro de rede com a IA', e.message, 'tentativa', tentativa + 1);
      if (tentativa === 2) throw e;
      await new Promise(res => setTimeout(res, 4000 * (tentativa + 1)));
      continue;
    }
    if (r.ok) { const j = await r.json(); if (j.usage) registrarUso(j.usage); return j; }
    const corpo = await r.text();
    log('erro API', r.status, corpo.slice(0, 300));
    if (![429, 500, 502, 503, 529].includes(r.status)) throw new Error('API ' + r.status);
    await new Promise(res => setTimeout(res, 4000 * (tentativa + 1)));
  }
  throw new Error('API indisponível');
}
function registrarUso(u) {
  const dia = agoraSP().toISOString().slice(0, 10);
  const f = path.join(DADOS, 'uso.json');
  const t = lerJson(f, {});
  const d = t[dia] || { entrada: 0, cache_escrita: 0, cache_lida: 0, saida: 0, chamadas: 0 };
  d.entrada += u.input_tokens || 0; d.cache_escrita += u.cache_creation_input_tokens || 0; d.cache_lida += u.cache_read_input_tokens || 0; d.saida += u.output_tokens || 0; d.chamadas++;
  const custo = custoUso(u); d.custo = Math.round(((d.custo || 0) + custo) * 1e6) / 1e6;
  t[dia] = d; gravarJson(f, t);
  const s = estado.saldos || (estado.saldos = {}); s.claudeGasto = (s.claudeGasto || 0) + custo;   // gasto desde o último saldo informado
}

// ---------- Saldos e pagamentos (aba Pagamentos do CRM) ----------
// Preço do Claude Haiku 5.5 em US$ por milhão de tokens (página de preços da Anthropic, nov/2026). Acima de 100 mil tokens de entrada no pedido, tudo custa 5x.
const PRECO_IA = { limite: 100000, normal: { ent: 0.10, cw5: 0.125, cw1h: 0.20, lida: 0.01, sai: 0.50 }, longo: { ent: 0.50, cw5: 0.625, cw1h: 1, lida: 0.05, sai: 2.50 } };
function custoUso(u) {
  u = u || {};
  const ent = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
  const p = ent > PRECO_IA.limite ? PRECO_IA.longo : PRECO_IA.normal;
  const cw1h = (u.cache_creation && u.cache_creation.ephemeral_1h_input_tokens) || 0, cw5 = Math.max(0, (u.cache_creation_input_tokens || 0) - cw1h);
  return ((u.input_tokens || 0) * p.ent + cw5 * p.cw5 + cw1h * p.cw1h + (u.cache_read_input_tokens || 0) * p.lida + (u.output_tokens || 0) * p.sai) / 1e6;
}
// quando avisar (pode mudar pelo CRM): Claude em US$, Meta em R$, Runway em créditos, Make em créditos livres, ElevenLabs em % que sobra, Contabo e conexões do Make em dias para vencer
const LIM_SALDO = { claude: 3, meta: 100, runwayApi: 100, runwayApp: 100, make: 1000, eleven: 10, contabo: 3, conexao: 7 };
const LINK_SALDO = {
  claude: 'https://platform.claude.com/settings/billing', meta: 'https://business.facebook.com/billing_hub/accounts/details?asset_id=439489114629228',
  contabo: 'https://my.contabo.com/invoices', make: 'https://us2.make.com/organization/9032431/subscription',
  runwayApi: 'https://dev.runwayml.com/', runwayApp: 'https://app.runwayml.com/', eleven: 'https://elevenlabs.io/app/subscription',
  conexao: 'https://us2.make.com/2984722/connections'
};
const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
// dias de calendário (Joinville) daqui até a data: hoje = 0, amanhã = 1, ontem = -1
function diasAteSP(ms) { const f = (t) => { const d = new Date(new Date(t).toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' })); return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()); }; return Math.round((f(ms) - f(Date.now())) / 864e5); }
// Contas de anúncio da Meta. Cada uma tem o seu saldo: chaves meta_<conta> (o que você anotou), metaGasto_<conta> e metaRitmo_<conta> (o que o CRM lê no Make)
const META_CONTAS = { act_439489114629228: 'CA01 Vargas', act_1326465429307211: 'CA03 Djhonata', act_1402275433424996: 'CA02 Euro' };
const linkSaldo = (id) => /^meta_act_\d+$/.test(id) ? 'https://business.facebook.com/billing_hub/accounts/details?asset_id=' + id.slice(9) : LINK_SALDO[id];
function contasMeta(man, auto) { const c = new Set(Object.keys(META_CONTAS)); for (const k of [...Object.keys(man), ...Object.keys(auto)]) { const m = /^meta(?:Gasto|Ritmo)?_(act_\d+)$/.exec(k); if (m) c.add(m[1]); } return [...c]; }
// Pré-pago: saldo que o Djhonata anotou - o que gastou desde então - o ritmo do dia desde a última leitura
function metaEstimado(man, auto, conta) {
  const m = man['meta_' + conta]; if (!m || m.valor === undefined) return null;
  const g0 = auto['metaGasto_' + conta], g = g0 && g0.desde === m.em ? g0 : null;
  const gasto = g ? Math.max(0, (g.gasto || 0) - (m.base || 0)) : 0;
  const rt = auto['metaRitmo_' + conta], ritmo = (rt && rt.porDia) || 0;
  const desde = g ? Number(g.em) || Date.parse(g.em) || 0 : Date.parse(m.em) || 0;
  const extra = desde ? ritmo * Math.max(0, Date.now() - desde) / 864e5 : 0;
  return { conta, nome: META_CONTAS[conta] || conta, informado: m.valor, em: m.em, gasto: r2(gasto), extra: r2(extra), ritmo: r2(ritmo), estimado: r2(m.valor - gasto - extra), leitura: g ? g.em : null };
}
// custo de um dia do uso.json; os dias de antes da conta em dólar entram pelo número de tokens (preço normal, cache de 5 min)
const custoDia = (v) => Math.max(v.custo || 0, ((v.entrada || 0) * PRECO_IA.normal.ent + (v.cache_escrita || 0) * PRECO_IA.normal.cw5 + (v.cache_lida || 0) * PRECO_IA.normal.lida + (v.saida || 0) * PRECO_IA.normal.sai) / 1e6);
let elevenSaldo = null;
async function lerEleven(forcar) {
  if (!ELEVEN_KEY) return { erro: 'sem chave da ElevenLabs no servidor' };
  if (!forcar && elevenSaldo && Date.now() - elevenSaldo.em < 20 * 60e3) return elevenSaldo;
  try {
    const r = await fetch('https://api.elevenlabs.io/v1/user/subscription', { headers: { 'xi-api-key': ELEVEN_KEY } });
    if (!r.ok) throw new Error('ElevenLabs ' + r.status + (r.status === 401 ? ' (a chave não tem permissão de ler a assinatura)' : ''));
    const j = await r.json();
    elevenSaldo = { usados: Number(j.character_count) || 0, limite: Number(j.character_limit) || 0, renova: j.next_character_count_reset_unix ? j.next_character_count_reset_unix * 1000 : 0, plano: j.tier || '', status: j.status || '', em: Date.now() };
  } catch (e) { elevenSaldo = { erro: e.message, em: Date.now() }; }
  return elevenSaldo;
}
function dadosSaldos() {   // tudo o que o servidor sabe, para o CRM montar os cartões
  const s = estado.saldos || {};
  const man = s.manual || {}, auto = s.auto || {}, lim = Object.assign({}, LIM_SALDO, s.limites || {});
  const cl = man.claude ? { informado: man.claude.valor, em: man.claude.em, gasto: Math.round((s.claudeGasto || 0) * 100) / 100, estimado: Math.round(((man.claude.valor || 0) - (s.claudeGasto || 0)) * 100) / 100 } : { gasto: Math.round((s.claudeGasto || 0) * 100) / 100 };
  const uso = lerJson(path.join(DADOS, 'uso.json'), {}), mes = agoraSP().toISOString().slice(0, 7);
  cl.gastoMes = Math.round(Object.entries(uso).filter(([d]) => d.startsWith(mes)).reduce((t, [, v]) => t + custoDia(v), 0) * 100) / 100;
  const metas = Object.fromEntries(contasMeta(man, auto).map(c => [c, metaEstimado(man, auto, c)]).filter(([, v]) => v));
  return { claude: cl, metas, metaContas: META_CONTAS, eleven: elevenSaldo, manual: man, auto, limites: lim, links: LINK_SALDO, avisos: s.avisos || {}, modelo: MODELO };
}
function saldosBaixos() {   // [{id, nome, texto}] do que está abaixo do limite
  const d = dadosSaldos(), lim = d.limites, out = [], br = (v) => 'R$ ' + Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (d.claude.informado !== undefined && d.claude.estimado < lim.claude) out.push({ id: 'claude', nome: 'Claude Console (IA da assistente)', texto: `sobram uns US$ ${d.claude.estimado.toFixed(2)}` });
  const e = d.eleven; if (e && e.limite) { const resta = e.limite - e.usados; if (resta / e.limite * 100 < lim.eleven) out.push({ id: 'eleven', nome: 'ElevenLabs (voz)', texto: `sobram ${resta.toLocaleString('pt-BR')} de ${e.limite.toLocaleString('pt-BR')} caracteres` }); }
  for (const m of Object.values(d.metas)) if (m.estimado < lim.meta) out.push({ id: 'meta_' + m.conta, nome: `Meta Ads ${m.nome}`, texto: m.estimado <= 0 ? 'o saldo pode ter acabado (os anúncios param)' : `saldo estimado ${br(m.estimado)}` + (m.ritmo ? ` (dá uns ${Math.max(0, Math.floor(m.estimado / m.ritmo))} dia(s))` : '') });
  const ra = d.auto.runwayApi; if (ra && ra.creditos !== undefined && ra.creditos < lim.runwayApi) out.push({ id: 'runwayApi', nome: 'Runway API (vídeos automáticos)', texto: `${ra.creditos} créditos` });
  const rp = d.manual.runwayApp; if (rp && rp.valor !== undefined && rp.valor < lim.runwayApp) out.push({ id: 'runwayApp', nome: 'Runway (app)', texto: `${rp.valor} créditos` });
  const mk = d.auto.make; if (mk && mk.livres !== undefined && mk.livres < lim.make) out.push({ id: 'make', nome: 'Make', texto: `${mk.livres.toLocaleString('pt-BR')} créditos livres até ${mk.renova ? new Date(mk.renova).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : 'renovar'}` });
  const ct = d.manual.contabo; if (ct && ct.vence) { const dias = diasAteSP(quandoMs(ct.vence)); if (dias <= lim.contabo) out.push({ id: 'contabo', nome: 'Servidor Contabo', texto: dias < 0 ? `venceu em ${ct.vence.split('-').reverse().join('/')}` : dias === 0 ? 'vence hoje' : `vence em ${dias} dia(s)` }); }
  // conexões do Make que vencem (ex.: a do Facebook liga/pausa os anúncios e lê o gasto): avisa com 7 dias
  const cx = (d.auto.conexoes && d.auto.conexoes.lista) || [];
  const vencendo = cx.filter(c => Date.parse(c.vence)).map(c => ({ nome: c.nome, dias: diasAteSP(Date.parse(c.vence)) })).filter(c => c.dias <= lim.conexao).sort((a, b) => a.dias - b.dias);
  if (vencendo.length) out.push({ id: 'conexao', nome: 'Conexão no Make', texto: vencendo.map(c => `${c.nome} ${c.dias < 0 ? 'venceu' : c.dias === 0 ? 'vence hoje' : `vence em ${c.dias} dia(s)`}`).join('; ') + ' — renove (Reautorizar) para não parar' });
  return out;
}
async function verificarSaldos() {   // aviso no WhatsApp pessoal: no máximo 1 por dia por serviço
  if (!sock || !conectado || !dentroRotina()) return;
  await lerEleven();
  const s = estado.saldos || (estado.saldos = {}), av = s.avisos || (s.avisos = {}), hoje = agoraSP().toISOString().slice(0, 10);
  for (const b of saldosBaixos()) {
    if (av[b.id] === hoje) continue;
    av[b.id] = hoje; salvarEstado();
    const [tit, acao] = b.id === 'contabo' ? ['Pagamento', 'Para pagar'] : b.id === 'conexao' ? ['Atenção', 'Para renovar'] : ['Saldo baixo', 'Para colocar saldo'];
    await enviarTexto(DONO + '@s.whatsapp.net', `⚠️ ${tit} — ${b.nome}: ${b.texto}.\n${acao}: ${linkSaldo(b.id)}\n(Tudo na aba 💳 Pagamentos do CRM.)`, 'aviso');
    log('aviso de saldo baixo', b.id, b.texto);
  }
}
setInterval(() => verificarSaldos().catch(e => log('saldos', e.message)), 3 * 3600e3);
setTimeout(() => verificarSaldos().catch(e => log('saldos', e.message)), 5 * 60e3);

// Identidade (12/11/2026): para o cliente, quem fala é o Djhonata. Resposta que fala dele como outra pessoa ("já pedi para o Djhonata verificar",
// "vou levar para o Djhonata e ele fala com você") não sai: a IA reescreve em primeira pessoa (uma vez por resposta).
// Aviso ao WhatsApp pessoal: o que é essencial, o que é dúvida de cliente (vai para o CRM) e o que é só informação (não sai)
const AVISO_ESSENCIAL = /(visita|hor[áa]rio)[^.\n]{0,60}(marcad|agendad|desmarc|remarc|cancel)|(marcou|agendou|desmarcou|remarcou|cancelou|confirmou)[^.\n]{0,40}(visita|hor[áa]rio)|falar com (uma |um |o |a )?(pessoa|atendente|corretor|humano)|n[úu]mero pessoal|pediu (o |seu |meu )?n[úu]mero|indica[çc][ãa]o|indicou|permuta|projeto|planta|esfriou|urgente/i;
const AVISO_DUVIDA = /\?|d[úu]vida|pergunt|confirm|n[ãa]o sei|n[ãa]o tenho|n[ãa]o consta|qual |quant|medida|metragem|responder|resposta/i;
const tipoDoAviso = (t) => AVISO_ESSENCIAL.test(t) ? 'essencial' : AVISO_DUVIDA.test(t) ? 'duvida' : 'info';
const AVISO_INTERNO = ' O cliente não sabe desse aviso: para ele, quem está falando é você, o Djhonata. Se for dizer que vai conferir algo, diga em primeira pessoa ("vou confirmar isso e já te falo"); nunca escreva "pedi para o Djhonata", "o Djhonata vai ver" nem "assim que ele responder".';
// Onde "Djhonata" é ela mesma se apresentando (não conta como terceira pessoa): "Aqui é o Djhonata", "sou eu, o Djhonata", assinatura numa linha só.
const RE_EU_DJHONATA = /\b(?:aqui\s+(?:é|quem\s+fala\s+é)|(?:eu\s+)?sou(?:\s+eu,?)?|me\s+chamo|meu\s+nome\s+é|pode\s+me\s+chamar\s+de|quem\s+(?:fala|est[áa]\s+falando|te\s+atende|est[áa]\s+te\s+atendendo)(?:\s+aqui|\s+com\s+voc[êe]s?)?\s+é)\s+(?:mesmo,?\s+)?(?:o\s+)?(?:pr[óo]prio\s+)?Djhonata(?:\s+Vargas)?\b|(?:^|[\s,;:.!?])é\s+o\s+(?:pr[óo]prio\s+)?Djhonata\s+(?:falando|mesmo|aqui)\b|\bDjhonata\s+aqui\b|(?:^|\n)\s*Djhonata(?:\s+Vargas)?\s*(?:[,|–-][^\n]{0,60})?(?=\n|$)/gi;
// Qualquer outra menção ao nome é falar dele como se fosse outra pessoa ("vou levar para o Djhonata", "o Djhonata fala com você", "quem fecha é o Djhonata").
const RE_ARROBA_DJHONATA = /\S*(?:[@\/]djhonata|djhonata[._][a-z0-9])\S*/gi;   // @djhonata.vargas, instagram.com/djhonata.vargas: é o endereço dele, não é falar dele
function falaEmTerceira(t) { return /\bDjhonata\b/i.test(String(t || '').replace(RE_ARROBA_DJHONATA, ' ').replace(RE_EU_DJHONATA, ' ')); }
const AVISO_3P = '(sistema) O texto que você escreveu agora NÃO foi enviado ao cliente, porque nele você fala do Djhonata como se fosse outra pessoa. Para o cliente, quem está falando é você, o Djhonata. Escreva a MESMA resposta em primeira pessoa (ex.: em vez de "já pedi para o Djhonata verificar", "vou confirmar isso e já te falo"; em vez de "vou levar isso para o Djhonata e ele fala com você", "vou ver isso aqui e já te retorno"; em vez de "assim que ele responder", "assim que eu confirmar"), sem citar o nome Djhonata nem "ele", sem mudar o resto e sem comentar esta correção.';
// Ela fala como o Djhonata (homem): "obrigada" vira "obrigado" antes de sair, em texto e em áudio.
const generoDoDono = (t) => String(t || '').replace(/\b([Oo])brigada\b/g, '$1brigado').replace(/\bOBRIGADA\b/g, 'OBRIGADO');
async function responder(f) {
  const ctx = { jid: f.jid, telefone: f.telefone, nome: f.nome, dono: f.dono, notas: [], audioAgora: !!f.audio, rotina: (f.extra && f.extra.rotina) || '' };
  const system = sistema(ctx);
  const tIniResp = Date.now();   // o que o cliente mandar depois disto chegou no meio da resposta
  const messages = montarMensagens(f.jid, f.imagens, f.rotina);
  const ferramentas = f.dono && !(estado.teste && estado.teste.ativo) ? [...FERRAMENTAS, FERRAMENTA_DONO] : FERRAMENTAS;
  if (!f.rotina) { try { await sock.sendPresenceUpdate('composing', f.jid); } catch (e) { } }
  const saida = [], textosIA = [], paradas = [];
  let usouFerramenta = false, cutucou = 0, corrigiuId = 0;
  try {
  for (let volta = 0; volta < 9; volta++) {
    const resp = await claude(system, messages, ferramentas);
    // o cliente mandou mais mensagem enquanto a IA pensava e nada saiu ainda: descarta e refaz com tudo (ex.: mandou o nome logo depois do "boa tarde")
    if (!saida.length && !usouFerramenta && !f.rotina) {
      const nova = filas.get(f.jid);
      if (nova && nova !== f) {
        nova.imagens = [...(f.imagens || []), ...(nova.imagens || [])]; if (f.audio) nova.audio = true; if (f.liberar24h) nova.liberar24h = true;
        f.refazer = true; log('cliente mandou mais mensagem enquanto a IA pensava: refaz com tudo', f.telefone || f.jid); return;
      }
    }
    paradas.push(resp.stop_reason + ':' + (resp.content || []).map(b => b.type + (b.type === 'text' ? '(' + String(b.text || '').trim().length + ')' : '')).join('+'));
    // resposta vazia (sem texto e sem ferramenta): guarda para conferir depois
    if (!(resp.content || []).some(b => (b.type === 'text' && String(b.text || '').trim()) || b.type === 'tool_use')) { try { gravarJson(path.join(DADOS, 'ia-vazia.json'), { ts: new Date().toISOString(), jid: f.jid, stop_reason: resp.stop_reason, content: resp.content, usage: resp.usage }); } catch (e) { } }
    messages.push({ role: 'assistant', content: (resp.content || []).length ? resp.content : [{ type: 'text', text: '(sem resposta)' }] });
    const resultados = [];
    // fala do Djhonata em terceira pessoa: segura o texto desta resposta inteira e pede em primeira pessoa (as ferramentas rodam normalmente)
    const segura3p = !f.dono && !corrigiuId && (resp.content || []).some(b => b.type === 'text' && falaEmTerceira(b.text));
    if (segura3p) { corrigiuId = 1; log('identidade: resposta falava do Djhonata em terceira pessoa; pedindo em primeira pessoa', f.telefone || f.jid); }
    for (const bloco of resp.content || []) {
      if (bloco.type === 'text') {
        const t = bloco.text.trim(); if (t) textosIA.push(t.slice(0, 200));
        if (!t || /^NO_REPLY\b/.test(t) || /^nada a fazer\W*$/i.test(t)) continue;
        if (segura3p) continue;
        // o Djhonata pode ter desligado a assistente nessa conversa enquanto ela pensava
        if (!podeResponder(f.jid, f.telefone)) { log('resposta descartada (pausada no meio)', f.jid); return; }
        saida.push(...await enviarSaida(f.jid, t, 'ia', f.extra));
      } else if (bloco.type === 'tool_use') {
        usouFerramenta = true;
        const r = await executar(bloco.name, bloco.input || {}, ctx);
        if (bloco.name === 'enviar_arquivo' && ctx.notas.length) saida.push(ctx.notas.pop());
        resultados.push({ type: 'tool_result', tool_use_id: bloco.id, content: String(r).slice(0, 20000) });
      }
    }
    // usou ferramenta: devolve o resultado sempre (mesmo quando ela marca "end_turn"; sem isso a IA dá erro 400)
    if (resultados.length) { if (segura3p) resultados.push({ type: 'text', text: AVISO_3P }); messages.push({ role: 'user', content: resultados }); continue; }
    if (segura3p) { messages.push({ role: 'user', content: [{ type: 'text', text: AVISO_3P }] }); continue; }
    // terminou sem falar nada com o cliente (resposta vazia, ou só usou ferramenta): pede a resposta.
    // 1ª vez: como ele prefere (áudio, se mandou ou pediu); 2ª vez: em texto, para o cliente nunca ficar sem resposta.
    const disseNoReply = textosIA.some(t => /^NO_REPLY\b/.test(t) || /^nada a fazer\W*$/i.test(t));
    if (!saida.length && cutucou < 2 && !f.rotina && !f.dono && (usouFerramenta || !disseNoReply) && sock && conectado) {
      cutucou++; log('IA terminou sem responder (' + paradas.slice(-1)[0] + '); pedindo a resposta', cutucou, f.telefone || f.jid);
      const querAudio = cutucou === 1 && ELEVEN_KEY && (ctx.audioAgora || ((estado.prefAudio || {})[f.jid] > 0));
      messages.push({ role: 'user', content: [{ type: 'text', text: '(sistema) Você ainda não mandou nenhuma mensagem ao cliente nesta vez. Responda agora ao que ele disse' + (querAudio ? ', em áudio ([[tts:...]]), porque ele mandou ou pediu áudio' : cutucou === 2 ? ', em TEXTO' : '') + '. Se realmente não houver nada a responder, escreva só NO_REPLY.' }] });
      continue;
    }
    break;
  }
  } catch (e) {   // erro no meio: se já mandou alguma coisa, guarda o que saiu e não tenta de novo (para não repetir)
    if (!saida.length) { try { if (sock) await sock.sendPresenceUpdate('paused', f.jid); } catch (_) { } throw e; }
    log('erro no meio da resposta (já tinha mandado ' + saida.length + '):', e.message);
  }
  try { if (sock) await sock.sendPresenceUpdate('paused', f.jid); } catch (e) { }
  if (saida.length) anotarResposta(f.jid, saida.join('\n'), tIniResp);
  else {
    log('IA não mandou nada:', paradas.join(' | '), JSON.stringify(textosIA).slice(0, 300));
    // tinha resposta, mas o WhatsApp caiu antes de sair: vira "pendente" e sai quando ele voltar
    if ((!sock || !conectado) && textosIA.some(t => !/^NO_REPLY\b/.test(t) && !/^nada a fazer\W*$/i.test(t))) throw new Error('WhatsApp caiu antes de a resposta sair');
  }
  log('respondido', f.telefone || f.jid, saida.length, 'mensagens');
  if (saida.length && !f.dono) { try { cardAutomatico(f.jid); } catch (e) { } }
}

// ---------- rotinas do OpenClaw: lembretes de visita e retomada ----------
// Lembrete 1: ~24h antes (8h–21h30). Lembrete 2: no dia, 2–3h antes. Retomada (só das 9h às 19h30): uma vez, 3h depois que o cliente
// parou de responder (2h se ela mandou a agenda), dentro das 24h do cliente. Tudo passa pelos freios de envio.
const rotinas = { rodando: false, dia: '', lembretes: 0, retomadas: 0, ultima: '' };
function dentroRotina() { const d = agoraSP(); const x = d.getHours() * 60 + d.getMinutes(); return x >= minutos(ROT_INI) && x <= minutos(ROT_FIM); }
function dentroRetomada(ms) { const d = new Date((ms || Date.now()) - 3 * 3600e3), x = d.getUTCHours() * 60 + d.getUTCMinutes(); return x >= minutos(RET_INI) && x <= minutos(RET_FIM); }   // Joinville é UTC-3
function tel8Chat(jid) { return String((chats[jid] || {}).telefone || pnDe(jid).split('@')[0] || '').replace(/\D/g, '').slice(-8); }
function jidPorTel8(t8) { let melhor = '', ult = -1; for (const k of Object.keys(chats)) { if (jidValido(k) && tel8Chat(k) === t8 && (chats[k].ult || 0) > ult) { melhor = k; ult = chats[k].ult || 0; } } return melhor; }
function quandoMs(q) {   // 'AAAA-MM-DDTHH:MM' em Joinville (UTC-3) -> ms; sem hora = 9h
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2}))?/.exec(String(q || '')); if (!m) return 0;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], (m[4] ? +m[4] : 9) + 3, m[5] ? +m[5] : 0);
}
function descreverQuando(q) {
  const [d, h] = String(q || '').split('T');
  const ymd = (x) => x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0');
  const hoje = agoraSP(), am = new Date(hoje.getTime() + 864e5);
  const dt = new Date(d + 'T12:00:00Z');
  const sem = isNaN(dt) ? d : dt.toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: '2-digit', timeZone: 'UTC' });
  const rel = d === ymd(hoje) ? 'hoje' : d === ymd(am) ? 'amanhã' : '';
  return (rel ? `${rel} (${sem})` : sem) + (h ? ' às ' + h : ' (horário não informado)');
}
// ---------- Agenda do escritório: a assistente consulta e marca (pedido do Djhonata, 11/11/2026). Mesmas regras do link do cliente. ----------
const AGENDA_HOOK = ENV.AGENDA_HOOK || 'https://hook.us2.make.com/ifgf6ai79h57nseenakwqw18kvjj9u41';
const AG_SEMANA = [8, 9, 10, 13, 14, 15, 16, 17, 18], AG_SABADO = [8, 9, 10, 11, 12, 13, 14, 15], AG_ANTECEDENCIA_H = 4;
async function agendaOcupados() {   // chaves ocupadas ou fechadas: "AAAA-MM-DD" (dia inteiro) ou "AAAA-MM-DDTHH:00"
  const r = await fetch(AGENDA_HOOK + '?acao=horarios&t=' + Date.now(), { signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error('agenda respondeu ' + r.status);
  return new Set((await r.text()).split(',').map(s => s.trim()).filter(Boolean));
}
function agendaLivres(ocup, data) {   // horas livres (números) de um dia AAAA-MM-DD
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(data || ''); if (!m) return [];
  const w = new Date(+m[1], +m[2] - 1, +m[3]).getDay(); if (w === 0 || ocup.has(data)) return [];
  const lim = agoraSP().getTime() + AG_ANTECEDENCIA_H * 3600e3;
  return (w === 6 ? AG_SABADO : AG_SEMANA).filter(h => new Date(+m[1], +m[2] - 1, +m[3], h, 0).getTime() >= lim && !ocup.has(`${data}T${String(h).padStart(2, '0')}:00`));
}
function guardarVisita(jid, data, hora, origem) {
  if (!jid || !/^\d{4}-\d{2}-\d{2}$/.test(data || '')) return;
  const h = /^(\d{1,2}):(\d{2})/.exec(hora || ''); const q = data + (h ? 'T' + h[1].padStart(2, '0') + ':' + h[2] : '');
  estado.visitas = estado.visitas || {};
  const v = estado.visitas[jid];
  if (v && v.q === q) { if (origem === 'crm' && !v.crm) { v.crm = true; salvarEstado(); } return; }
  estado.visitas[jid] = { q, origem, criado: Date.now(), enviados: {}, crm: origem === 'crm' };
  salvarEstado(); log('visita guardada para lembretes', jid, q, origem);
}
function cancelarVisita(jid, motivo) { if (estado.visitas && estado.visitas[jid]) { delete estado.visitas[jid]; salvarEstado(); log('lembretes cancelados', jid, motivo || ''); } }
function atualizarVisitasCrm(mapa) {   // o CRM manda {telefone8: 'AAAA-MM-DD HH:MM'} de quem está em "Visita marcada"
  estado.visitas = estado.visitas || {};
  const vistos = new Set();
  for (const [t, q] of Object.entries(mapa || {})) {
    const t8 = String(t).replace(/\D/g, '').slice(-8); if (t8.length !== 8) continue;
    const jid = jidPorTel8(t8); if (!jid) continue;   // sem conversa neste WhatsApp: sem lembrete (não puxa conversa nova)
    const [data, hora] = String(q || '').split(/[T ]/);
    guardarVisita(jid, data, hora, 'crm'); vistos.add(jid);
  }
  for (const [jid, v] of Object.entries(estado.visitas)) {
    if (vistos.has(jid)) continue;
    const t8 = tel8Chat(jid), st = t8 ? (estado.crmStatus || {})[t8] : '';
    if (v.crm || (st && st !== 'visita' && Date.now() - (v.criado || 0) > 20 * 60e3)) { delete estado.visitas[jid]; log('lembretes cancelados (CRM)', jid); }
  }
  salvarEstado();
}
function acharCliente(busca) {   // nome ou telefone -> conversas (sem repetir o mesmo número)
  const b = String(busca || '').trim(), dig = b.replace(/\D/g, '');
  let cand = [];
  if (dig.length >= 8) { const t8 = dig.slice(-8); cand = Object.keys(chats).filter(j => jidValido(j) && tel8Chat(j) === t8); }
  else if (b.length >= 2) {
    const q = semAcento(b);
    const pont = (j) => { const n = semAcento(chatPublico(j).nome || ''); if (!n) return 0; if (n === q) return 3; if (n.split(/\s+/).includes(q) || n.startsWith(q + ' ')) return 2; return n.includes(q) ? 1 : 0; };
    const lista = Object.keys(chats).filter(j => jidValido(j) && !ehDono(pnDe(j) || j) && tel8Chat(j) !== String(DONO).slice(-8)).map(j => [j, pont(j)]).filter(x => x[1] > 0);
    const melhor = Math.max(0, ...lista.map(x => x[1])); cand = lista.filter(x => x[1] === melhor).map(x => x[0]);
  }
  const porTel = new Map();
  for (const j of cand.sort((a, b) => (chats[b].ult || 0) - (chats[a].ult || 0))) { const k = tel8Chat(j) || j; if (!porTel.has(k)) porTel.set(k, j); }
  return [...porTel.values()];
}
function rotinaPermitida(jid, tipo) {
  if (!jidValido(jid) || ehDono(pnDe(jid) || jid)) return false;
  const c = chats[jid] || {}, t8 = tel8Chat(jid);
  if (!podeResponder(jid, c.telefone)) return false;           // assistente ligada (ou teste com este número) e não pausada nesta conversa
  if (c.arquivado || filas.has(jid) || ocupado.has(jid)) return false;
  if (t8 && t8 === String(DONO).slice(-8) && !(estado.teste && estado.teste.ativo)) return false;
  if (t8 && [...lerBloqueados()].some(n => n.endsWith(t8))) return false;
  if (t8 && (estado.equipe || []).includes(t8)) return false;
  const st = t8 ? (estado.crmStatus || {})[t8] || '' : '';
  if (['negociacao', 'fechado', 'pausado', 'perdido', 'desistiu', 'corretor', 'corretor_euro', 'construtor', 'pessoal'].includes(st)) return false;
  if (tipo === 'retomada' && st === 'visita') return false;
  const cl = (estado.classes || {})[jid]; if (cl && ['comprou', 'corretor', 'construtor', 'pessoal'].includes(cl.cat)) return false;
  if (etiquetasDe(jid).some(e => /pausad|perdid|desist|fechad|finaliz|comprou|corretor|constru|capta|pessoa|negocia/.test(semAcento(e.nome)))) return false;
  return true;
}
function conversaParada(jid) {   // última mensagem (sem contar avisos internos) foi da assistente e o cliente não respondeu
  const l = lerEsp(jid); let ult = null, ultCli = 0, agenda = false;
  for (let i = l.length - 1; i >= 0; i--) {
    const m = l[i];
    if (m.autor === 'cliente') { ultCli = m.ts; break; }
    if (m.autor === 'aviso') continue;
    if (!ult) ult = m;
    if (m.autor === 'ia' && /make\.com|marque seu hor[aá]rio/i.test(m.texto || '')) agenda = true;
  }
  return ult && ult.autor === 'ia' && ultCli && ult.ts > ultCli ? { ultIa: ult.ts, ultCli, agenda, jaRetomou: !!ult.rotina } : null;
}
async function verificarRotinas() {
  if (!ROTINAS || rotinas.rodando || !sock || !conectado || !API_KEY) return;
  const dia = agoraSP().toISOString().slice(0, 10); if (rotinas.dia !== dia) Object.assign(rotinas, { dia, lembretes: 0, retomadas: 0 });
  rotinas.rodando = true;
  try {
    const agora = Date.now(), fila = [], janela = dentroRotina();
    for (const [jid, v] of Object.entries(estado.visitas || {})) {
      const T = quandoMs(v.q); if (!T) continue;
      if (agora > T + 3 * 3600e3) { delete estado.visitas[jid]; salvarEstado(); continue; }
      if (!janela || !rotinaPermitida(jid, 'lembrete')) continue;
      v.enviados = v.enviados || {};
      if (!v.enviados.l24 && agora >= T - 24 * 3600e3 && agora <= T - 12 * 3600e3 && (v.criado || 0) <= T - 22 * 3600e3) fila.push({ jid, tipo: 'l24', v });
      else if (v.q.includes('T') && !v.enviados.l2 && agora >= T - 3 * 3600e3 && agora <= T - 50 * 60e3) fila.push({ jid, tipo: 'l2', v });
    }
    for (const [jid, r] of Object.entries(estado.retornos || {})) {   // retorno combinado com o cliente ("falo depois das 14h30")
      const T = quandoMs(r.q), uc = ultCli(jid);
      if (!T || agora > T + 6 * 3600e3) { delete estado.retornos[jid]; salvarEstado(); continue; }                                   // passou muito da hora: desiste
      if (agora >= T - 30 * 60e3 && uc > (r.criado || 0) + 10 * 60e3 && agora - uc < 2 * 3600e3) { delete estado.retornos[jid]; salvarEstado(); continue; }   // ele já voltou a falar por conta própria
      if (agora < T || !janela || !rotinaPermitida(jid, 'retomada')) continue;
      fila.push({ jid, tipo: 'retorno', r });
    }
    if (janela && dentroRetomada()) {
      for (const jid of Object.keys(chats)) {
        const c = chats[jid];
        if (!['ia', 'aviso'].includes(c.ultAutor) || !c.ult || agora - c.ult > 22 * 3600e3 || agora - c.ult < 2 * 3600e3) continue;
        if ((estado.visitas || {})[jid]) continue;            // tem visita marcada: quem cuida são os lembretes
        if ((estado.retornos || {})[jid]) continue;           // tem retorno combinado: ela chama na hora marcada, não antes
        const p = conversaParada(jid); if (!p || p.jaRetomou) continue;
        if (agora - p.ultCli > 22 * 3600e3) continue;          // fora das 24h do cliente: não puxa conversa
        if (agora - p.ultIa < (p.agenda ? 2 : 3) * 3600e3) continue;
        const r = (estado.retomadas || {})[jid]; if (r && r.base === p.ultCli) continue;   // já retomou desde a última mensagem dele
        if (!rotinaPermitida(jid, 'retomada')) continue;
        fila.push({ jid, tipo: 'retomada', p });
      }
    }
    for (const it of fila.slice(0, 15)) {
      if (!sock || !conectado) break;
      if (filas.has(it.jid) || ocupado.has(it.jid)) continue;
      await rodarRotina(it);
      await dorme(acaso(20e3, 60e3));
    }
  } catch (e) { log('rotinas', e.message); }
  finally { rotinas.rodando = false; }
}
async function rodarRotina(it) {
  const jid = it.jid, c = chats[jid] || {};
  let instr, extra;
  if (it.tipo === 'retomada') {
    const h = Math.max(2, Math.round((Date.now() - it.p.ultIa) / 3600e3));
    instr = `[ROTINA AUTOMÁTICA — não é mensagem do cliente] Retomada: o cliente não responde desde a sua última mensagem (há umas ${h} horas). Releia a conversa. Se fizer sentido, mande UMA mensagem curta e natural retomando de onde parou (uma pergunta simples que convide a responder), sem repetir o que já mandou e sem pressionar.${it.p.agenda ? ' Você já mandou a agenda: se ele combinou dia ou horário e ainda não mandou o comprovante, consulte a agenda com agenda_visita e, se o horário estiver livre, marque e confirme; se não estiver, ofereça os livres.' : ''} Responda só NO_REPLY se: ele disse que não quer agora ou desistiu; a conversa terminou naturalmente (agradeceu e se despediu); ele disse que ia ver e retornar em outro dia; ou não há o que retomar. É a única retomada: não prometa mandar outras mensagens.`;
    extra = { rotina: 'retomada' };
    estado.retomadas = estado.retomadas || {}; estado.retomadas[jid] = { base: it.p.ultCli, em: Date.now() };
    for (const [k, r] of Object.entries(estado.retomadas)) if (Date.now() - (r.em || 0) > 7 * 864e5) delete estado.retomadas[k];
    salvarEstado();
  } else if (it.tipo === 'retorno') {
    instr = `[ROTINA AUTOMÁTICA — não é mensagem do cliente] Retorno combinado: o cliente pediu para você chamar agora${it.r.assunto ? ` (ficou combinado: ${it.r.assunto})` : ''}. Releia a conversa e mande UMA mensagem curta e natural chamando ele de volta, retomando de onde pararam e já trazendo o próximo passo (a opção de imóvel, a conta ou a pergunta que ficou pendente). Não se apresente de novo, não diga que é uma rotina e não peça desculpa pelo horário.`;
    extra = { rotina: 'retomada' };
    delete estado.retornos[jid]; estado.retomadas = estado.retomadas || {}; estado.retomadas[jid] = { base: c.ultCliente || 0, em: Date.now() }; salvarEstado();
    liberado24h.add(jid);
  } else if (it.tipo === 'ordem') {
    instr = `[PEDIDO DO DJHONATA — não é mensagem do cliente] Retome esta conversa agora. Releia a conversa inteira antes. ${it.instr} Escreva como continuação natural da conversa (sem dizer que o Djhonata pediu), siga todas as regras do atendimento e termine com UMA pergunta simples. É uma retomada só: não prometa mandar outras mensagens.`;
    extra = { rotina: 'retomada' };
    estado.retomadas = estado.retomadas || {}; estado.retomadas[jid] = { base: c.ultCliente || 0, em: Date.now() }; salvarEstado();
    liberado24h.add(jid);
  } else {
    instr = `[ROTINA AUTOMÁTICA — não é mensagem do cliente] Lembrete de visita (${it.tipo === 'l24' ? '1 de 2, cerca de 24 horas antes' : '2 de 2, no dia, algumas horas antes'}). A visita está marcada para ${descreverQuando(it.v.q)}, no escritório da Euro (Rua Dona Francisca, 1222 - Saguaçu). Releia a conversa. Se o cliente cancelou, desmarcou, disse que não vai ou pediu para remarcar, NÃO mande lembrete: use registrar_crm com novoStatus remarcar e responda NO_REPLY. Se não, mande um lembrete curto e simpático com o dia, o horário e o endereço, sem valores, sem material novo e sem a agenda. Pode pedir para ele confirmar.`;
    extra = { rotina: 'lembrete' };
    it.v.enviados = it.v.enviados || {}; it.v.enviados[it.tipo] = Date.now(); salvarEstado();
    liberado24h.add(jid);
  }
  ocupado.add(jid); emitir('digitando', { jid, on: true });
  try {
    await responder({ jid, telefone: c.telefone || '', nome: c.nome || '', dono: false, imagens: [], rotina: instr, extra });
    if (it.tipo === 'retomada' || it.tipo === 'ordem' || it.tipo === 'retorno') rotinas.retomadas++; else rotinas.lembretes++;
    rotinas.ultima = new Date().toISOString();
    log('rotina', it.tipo, c.telefone || jid);
  } catch (e) { log('rotina com erro', it.tipo, e.message); }
  finally { liberado24h.delete(jid); ocupado.delete(jid); emitir('digitando', { jid, on: false }); }
}
setInterval(() => verificarRotinas().catch(e => log('rotinas', e.message)), 2 * 60e3);

// ---------- Follow-up dos perdidos (pedido do Djhonata, 11/11/2026) ----------
// O CRM manda os clientes que estão em Perdido. A IA lê a conversa de cada um e escreve a análise e UMA mensagem de retomada.
// Nada sai sem o Djhonata aprovar no CRM. Os aprovados saem até 30 por dia, de segunda a sexta das 9h às 19h e sábado das 9h às 12h, dos mais
// quentes para os mais frios, com uns 15 a 25 minutos entre um e outro. Quem disse que não quer, comprou com outro ou adiou
// não recebe nada e vai para "Desistiu" no CRM. Se o cliente responder, o card vai para "Em atendimento" e a assistente continua.
const FU_F = path.join(DADOS, 'followups.json');
const FU_DIA = Number(ENV.FOLLOWUP_DIA || 30), FU_INI = '09:00', FU_FIM = '19:00', FU_FIM_SAB = '12:00';
// Horário do follow-up (decisão do Djhonata, 12/11/2026): segunda a sexta das 9h às 19h, sábado das 9h às 12h; domingo não sai.
const fuFimDoDia = (dow) => dow === 0 ? -1 : minutos(dow === 6 ? FU_FIM_SAB : FU_FIM);
const fu = lerJson(FU_F, {});
for (const v of Object.values(fu)) if (v.status === 'gerando') v.status = 'fila';   // o servidor reiniciou no meio
for (const v of Object.values(fu)) if (v.status === 'erro' && /JSON|mensagem/.test(v.erro || '') && !v.refeito) { v.status = 'fila'; v.tent = 0; v.refeito = 1; }   // erro de resposta cortada: tenta de novo uma vez
const fuRun = { gerando: 0, proximoIntervalo: 0 };
let fuSalvarTimer = null;
function salvarFu() { clearTimeout(fuSalvarTimer); fuSalvarTimer = setTimeout(() => gravarJson(FU_F, fu), 800); }
const fuT8 = (t) => String(t || '').replace(/\D/g, '').slice(-8);
function fuNumero(t) { let d = String(t || '').replace(/\D/g, ''); if (!d.startsWith('55') && (d.length === 10 || d.length === 11)) d = '55' + d; return normal(d); }
const spDe = (ms) => new Date(ms - 3 * 3600e3);   // Joinville é UTC-3 (sem horário de verão): campos UTC = hora local
const fuDia = (ms) => spDe(ms).toISOString().slice(0, 10);
function fuUltimoEnvio() { let t = 0; for (const v of Object.values(fu)) if ((v.enviadoEm || 0) > t) t = v.enviadoEm; return t; }
function fuEnviadosHoje() { const h = fuDia(Date.now()); return Object.values(fu).filter(v => v.enviadoEm && fuDia(v.enviadoEm) === h).length; }
function fuFilaAprovada() { return Object.values(fu).filter(v => v.status === 'aprovado').sort((a, b) => (b.prioridade || 0) - (a.prioridade || 0) || (a.aprovadoEm || 0) - (b.aprovadoEm || 0)); }
function fuNaJanela(ms) { const d = spDe(ms), m = d.getUTCHours() * 60 + d.getUTCMinutes(); return m >= minutos(FU_INI) && m <= fuFimDoDia(d.getUTCDay()); }
function fuProximaAbertura(ms) {   // próximo 9h (segunda a sábado) depois de ms
  const d = spDe(ms); let t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 9 + 3, 0);
  if (t <= ms) t += 864e5;
  while (spDe(t).getUTCDay() === 0) t += 864e5;
  return t;
}
function fuPrevisoes() {   // quando cada aprovado deve sair (estimativa: uns 20 minutos entre um e outro)
  const out = {}; let t = Math.max(Date.now(), fuUltimoEnvio() + 20 * 60e3), dia = fuDia(t), noDia = dia === fuDia(Date.now()) ? fuEnviadosHoje() : 0;
  for (const x of fuFilaAprovada()) {
    for (let g = 0; g < 500; g++) {
      if (fuDia(t) !== dia) { dia = fuDia(t); noDia = 0; }
      if (fuNaJanela(t) && noDia < FU_DIA) break;
      const d = spDe(t), m = d.getUTCHours() * 60 + d.getUTCMinutes();
      t = (d.getUTCDay() !== 0 && m < minutos(FU_INI) && noDia < FU_DIA) ? t + (minutos(FU_INI) - m) * 60e3 : fuProximaAbertura(t);
    }
    out[x.tel8] = t; noDia++; t += 20 * 60e3;
  }
  return out;
}
function fuResumo() {
  const contagem = {}; for (const v of Object.values(fu)) contagem[v.status] = (contagem[v.status] || 0) + 1;
  const prev = fuPrevisoes(), prox = Math.min(...Object.values(prev), Infinity);
  return { contagem, hoje: fuEnviadosHoje(), limiteDia: FU_DIA, gerando: (contagem.fila || 0) + (contagem.gerando || 0), proximo: isFinite(prox) ? prox : 0 };
}
function fuPublico(x, prev) {
  return { tel8: x.tel8, tel: x.tel, id: x.id, nome: x.nome, status: x.status, decisao: x.decisao || '', motivo: x.motivo || '', analise: x.analise || '', mensagem: x.mensagem || '', prioridade: x.prioridade || 0, imovel: x.imovel || '', criadoEm: x.criadoEm, geradoEm: x.geradoEm || 0, aprovadoEm: x.aprovadoEm || 0, enviadoEm: x.enviadoEm || 0, respondeuEm: x.respondeuEm || 0, erro: x.erro || '', jid: x.jid || '', previsao: (prev && prev[x.tel8]) || 0 };
}
function fuEvento(x, novoStatus, resultado) {   // vai para o CRM pelo mesmo caminho dos eventos da assistente
  try { fs.appendFileSync(path.join(DADOS, 'eventos-crm.jsonl'), JSON.stringify({ rid: 'fu' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), ts: new Date().toISOString(), telefone: formatoBR(fuNumero(x.tel)), nome: x.nome || '', novoStatus, resultado }) + '\n'); } catch (e) { }
}
function fuConversa(jid) {
  const quem = { cliente: 'Cliente', ia: 'Djhonata (assistente)', voce: 'Djhonata', celular: 'Djhonata (celular)' };
  const l = lerEsp(jid).filter(m => m.autor !== 'aviso' && (String(m.texto || '').trim() || m.tipo !== 'text')).slice(-40);
  const t = l.map(m => `${quandoFoi(m.ts)} — ${quem[m.autor] || m.autor}: ${m.tipo && m.tipo !== 'text' && !m.transc ? '[' + m.tipo + '] ' : ''}${String(m.texto || '').replace(/\s+/g, ' ').slice(0, 400)}`).join('\n');
  return t.length > 9000 ? t.slice(-9000) : t;
}
function fuTarefa(x, conversa) {
  const c = x.crm || {};
  const dados = [c.nome && `Nome no CRM: ${c.nome}${c.nomeProvisorio ? ' (veio do perfil do WhatsApp: pode não ser o nome real)' : ''}`, c.bairro && `Bairro de interesse: ${c.bairro}`, c.imovel && `Imóvel de interesse: ${c.imovel}`, c.proximo && `Próximo passo anotado: ${c.proximo}`, c.resumo && `Resumo da conversa (CRM): ${c.resumo}`, c.historico && `Histórico do WhatsApp (CRM): ${c.historico}`, c.obs && `Observações (CRM): ${c.obs}`].filter(Boolean).join('\n');
  return `[TAREFA INTERNA DO SISTEMA — não é mensagem do cliente e nada disto vai para ele]
FOLLOW-UP DE CLIENTE PERDIDO. O Djhonata quer retomar o contato com este cliente, que parou de responder há mais de 7 dias (está em "Perdido" no CRM). A mensagem só sai depois que o Djhonata aprovar.

DADOS DO CRM
${dados || '(nada anotado)'}

CONVERSA NO WHATSAPP (a mais recente por último)
${conversa || '(não há conversa deste cliente neste WhatsApp: use só os dados do CRM)'}

O QUE FAZER
1) Decida:
- "desistiu": o cliente disse claramente que não quer mais, que já comprou (com outro corretor, imobiliária ou construtora), pediu para não receber mais mensagens, ou adiou ("agora não", "vou deixar para frente", "sem condições no momento"). Não escreva mensagem.
- "nao_cliente": é corretor, construtor, fornecedor, contato pessoal, ou a conversa não é sobre comprar imóvel. Não escreva mensagem.
- "enviar": nos outros casos.
2) Se for "enviar", escreva UMA mensagem de WhatsApp curta (no máximo 3 frases), na voz do Djhonata, em primeira pessoa, retomando de onde parou, com o gancho que mais pode converter este cliente:
 a) um imóvel do catálogo atual (CATALOGO.md) que encaixa no que ele procurava (bairro, valor, tipo, quartos, pronto ou na planta), citando o nome ou a rua e o bairro, só com dados do catálogo; ou
 b) se a dificuldade foi a entrada ou o valor: que agora dá para montar com entrada menor (sinal flexível, entrada parcelada até a entrega, FGTS, financiamento pela avaliação do banco), sem números que não estejam no catálogo e sem prometer aprovação; ou
 c) se ele já tinha gostado de um imóvel e só faltou marcar: um convite para passar no escritório tirar as dúvidas.
 Termine com uma pergunta simples que convide a responder. Não diga que ele sumiu, que parou de responder ou que é um follow-up. Não mande link nem agenda nesta mensagem (se ele responder, a conversa continua). Só use 🙏🏼 (agradecer) ou ✅ (confirmar) como emoji, nunca 👍, sem negrito e sem lista. Chame pelo primeiro nome só se for nome de pessoa (do CRM ou dito na conversa). Se nunca conversaram neste WhatsApp, apresente-se rapidinho ("aqui é o Djhonata, da Euro Consultoria"). Se a última mensagem da conversa já é do Djhonata e ficou sem resposta (ex.: "Estou com imóveis novos em Joinville. Qual bairro você busca?"), não repita a mesma ideia: traga algo concreto e novo.
3) Prioridade de 1 a 5: 5 = muito quente (marcou visita, pediu simulação, perguntou de entrada ou financiamento com os dados dele, gostou de um imóvel); 3 = pediu informações e conversou; 1 = só a primeira mensagem do anúncio, sem conversa.
Responda SOMENTE com um JSON válido, sem texto antes ou depois:
{"decisao": "enviar|desistiu|nao_cliente", "motivo": "frase curta", "analise": "1 ou 2 frases: o que ele procurava, onde parou e qual gancho você usou", "prioridade": 1, "imovel": "imóvel citado ou vazio", "mensagem": "texto da mensagem ou vazio"}`;
}
async function fuGerarUm(x) {
  x.status = 'gerando'; x.tent = (x.tent || 0) + 1;
  try {
    const jid = acharJid(fuNumero(x.tel) + '@s.whatsapp.net'), temChat = !!chats[jid];
    const system = sistema({ jid: temChat ? jid : '', telefone: x.tel, nome: x.nome, dono: false, notas: [] });
    const txt = await claudeTexto(system, fuTarefa(x, temChat ? fuConversa(jid) : ''), 1500);
    const i = txt.indexOf('{'), j = txt.lastIndexOf('}'); if (i < 0 || j < i) { log('follow-up: resposta sem JSON', x.tel, JSON.stringify(String(txt).slice(0, 160))); throw new Error('a IA não devolveu o JSON'); }
    const r = JSON.parse(txt.slice(i, j + 1));
    if (x.status !== 'gerando') return;   // cancelado enquanto a IA pensava (ex.: o cliente voltou a escrever)
    const dec = ['enviar', 'desistiu', 'nao_cliente'].includes(r.decisao) ? r.decisao : 'enviar';
    Object.assign(x, { decisao: dec, motivo: String(r.motivo || '').slice(0, 300), analise: String(r.analise || '').slice(0, 700), prioridade: Math.max(1, Math.min(5, Math.round(Number(r.prioridade) || 1))), imovel: String(r.imovel || '').slice(0, 120), geradoEm: Date.now(), erro: '', jid: temChat ? jid : '' });
    if (dec === 'enviar') {
      const msg = String(r.mensagem || '').trim(); if (!msg) throw new Error('a IA não escreveu a mensagem');
      x.mensagem = msg.slice(0, 1200); x.status = 'pronto';
    } else {
      x.mensagem = ''; x.status = dec;
      if (dec === 'desistiu') fuEvento(x, 'sem_interesse', 'Follow-up dos perdidos: ' + (x.motivo || 'disse que não quer mais'));
    }
  } catch (e) {
    x.erro = String(e.message || e).slice(0, 200);
    if (x.status === 'gerando') x.status = x.tent >= 3 ? 'erro' : 'fila';
    log('follow-up: erro ao preparar', x.tel, x.erro);
  }
  salvarFu();
}
function fuTrabalhar() {   // prepara 2 por vez
  if (!API_KEY) return;
  while (fuRun.gerando < 2) {
    const x = Object.values(fu).find(v => v.status === 'fila'); if (!x) return;
    fuRun.gerando++;
    fuGerarUm(x).catch(() => { }).finally(() => { fuRun.gerando--; setTimeout(fuTrabalhar, 300); });
  }
}
setInterval(fuTrabalhar, 30e3);
setTimeout(fuTrabalhar, 20e3);
async function fuEnviar(x) {   // devolve 'enviado', 'cancelado' ou 'erro'
  const fim = (status, erro) => { Object.assign(x, { status, erro }); salvarFu(); return status; };
  const num = fuNumero(x.tel); if (num.length < 12) return fim('erro', 'telefone inválido');
  let jid = acharJid(num + '@s.whatsapp.net');
  if (chats[jid] && ultCli(jid) > (x.geradoEm || x.criadoEm || 0)) return fim('cancelado', 'o cliente voltou a escrever antes do envio');
  // Você (ou a assistente) já falou com o cliente depois que este texto foi preparado: o follow-up pronto ficou velho e sairia como mensagem repetida (pedido do Djhonata, 13/11/2026).
  try { const t0 = x.geradoEm || x.criadoEm || 0; if (t0 && chats[jid] && lerEsp(jid).some(m => m.autor !== 'cliente' && m.autor !== 'aviso' && !m.followup && (m.ts || 0) > t0)) return fim('cancelado', 'você já falou com o cliente depois que este follow-up foi preparado'); } catch (e) { }
  const st = (estado.crmStatus || {})[x.tel8]; if (st && st !== 'perdido') return fim('cancelado', 'saiu de Perdido no CRM');
  if (lerBloqueados().has(num) || (estado.equipe || []).includes(x.tel8) || ehDono(num)) return fim('cancelado', 'número bloqueado para a assistente');
  const texto = String(x.mensagem || '').trim(); if (!texto) return fim('erro', 'mensagem vazia');
  if (!chats[jid]) {   // nunca conversou neste WhatsApp: confere se o número tem WhatsApp
    try { const [r] = await sock.onWhatsApp(num); if (!r || !r.exists) return fim('erro', 'esse número não tem WhatsApp'); if (r.jid) jid = acharJid(r.jid); } catch (e) { return 'erro'; }
  }
  try { await sock.sendPresenceUpdate('composing', jid); } catch (e) { }
  await dorme(Math.min(9000, 1200 + texto.length * acaso(25, 45)));
  const r = await sock.sendMessage(jid, { text: texto });
  const id = lembrarEnvio(r); ultimoEnvio = Date.now();
  registrarEspelho(jid, { id, autor: 'voce', tipo: 'text', texto, ts: Date.now(), followup: true });
  anotar(acharJid(jid), 'assistant', '(Djhonata escreveu) ' + texto);
  if (x.nome && x.tel8) { estado.crmNomes = estado.crmNomes || {}; if (!estado.crmNomes[x.tel8]) { estado.crmNomes[x.tel8] = String(x.nome).slice(0, 60); salvarEstado(); } }
  Object.assign(x, { status: 'enviado', enviadoEm: Date.now(), jid: acharJid(jid), erro: '' }); salvarFu();
  log('follow-up enviado', x.tel, x.nome || '');
  return 'enviado';
}
async function fuEnviarProximo() {
  if (!sock || !conectado || !estado.ativo || (estado.teste && estado.teste.ativo) || !fuNaJanela(Date.now())) return;
  if (fuEnviadosHoje() >= FU_DIA) return;
  if (!fuRun.proximoIntervalo) fuRun.proximoIntervalo = acaso(14, 26) * 60e3;
  if (Date.now() - fuUltimoEnvio() < fuRun.proximoIntervalo) return;
  for (const x of fuFilaAprovada()) {
    let r = 'erro'; try { r = await fuEnviar(x); } catch (e) { log('follow-up: erro ao enviar', x.tel, e.message); }
    if (r === 'enviado') { fuRun.proximoIntervalo = acaso(14, 26) * 60e3; return; }
    if (r === 'erro' && x.status === 'aprovado') return;   // erro passageiro (ex.: WhatsApp oscilou): tenta na próxima volta
  }
}
setInterval(() => fuEnviarProximo().catch(e => log('follow-up', e.message)), 60e3);
function fuClienteFalou(jid, telefone, ts) {   // o cliente escreveu: respondeu o follow-up ou voltou sozinho
  const x = fu[fuT8(telefone || (chats[jid] || {}).telefone || '')]; if (!x) return;
  ts = (ts || 0) + 999;   // o WhatsApp manda a hora em segundos
  if (x.status === 'enviado' && ts > (x.enviadoEm || 0)) {
    Object.assign(x, { status: 'respondeu', respondeuEm: ts }); salvarFu();
    fuEvento(x, 'atendimento', 'Respondeu o follow-up dos perdidos');
    log('respondeu o follow-up', x.tel, x.nome || '');
  } else if (['fila', 'gerando', 'pronto', 'aprovado'].includes(x.status) && ts > (x.criadoEm || 0)) {
    Object.assign(x, { status: 'cancelado', erro: 'o cliente voltou a escrever sozinho' }); salvarFu();
  }
}

const NO_AR_DESDE = Date.now();
function estadoPublico() {
  const uso = lerJson(path.join(DADOS, 'uso.json'), {});
  const hoje = uso[agoraSP().toISOString().slice(0, 10)] || null;
  return {
    conectado, numero: meuNumero, qr: !!ultimoQR, whatsDesligado: !!estado.whatsDesligado, iniciando,
    assistente: !!estado.ativo, horario: ATENDE_24H ? '24 horas' : `${HORA_INI}–${HORA_FIM}`, dentroDoHorario: dentroDoHorario(), versao: VERSAO, noArDesde: NO_AR_DESDE,
    regras: ARQS_REGRAS.map(f => ({ arquivo: f, ok: !!lerTexto(f) })), imoveis: pastasImoveis().length, bloqueados: lerBloqueados().size,
    usoHoje: hoje, modelo: MODELO, teste: estado.teste && estado.teste.ativo ? (estado.teste.numeros || []) : [],
    voz: !!ELEVEN_KEY, transcricao: ELEVEN_KEY ? 'ElevenLabs' : GEMINI_KEY ? 'Gemini' : '',
    audio: { transcritos: ouvido.feitas, falados: voz.feitas, erros: ouvido.erros + voz.erros, ultimoErro: (voz.ultimoErro || ouvido.ultimoErro || '').slice(0, 160) },
    rotinas: ROTINAS ? { visitas: Object.keys(estado.visitas || {}).length, lembretesHoje: rotinas.lembretes, retomadasHoje: rotinas.retomadas, horario: `${ROT_INI}–${ROT_FIM}`, retomada: `${RET_INI}–${RET_FIM}`, retornos: Object.keys(estado.retornos || {}).length } : null,
    pendentes: Object.keys(estado.devendo || {}).length, naFila: filas.size
  };
}

async function iniciarWhatsApp() {
  if (estado.whatsDesligado || iniciando) return;
  iniciando = true;
  try {
    await carregarBaileys();
    const { state, saveCreds } = await useMultiFileAuthState(AUTH);
    let version;
    try { version = (await fetchLatestBaileysVersion()).version; } catch (e) { }
    let s; try { s = makeWASocket({ version, auth: state, logger: pino({ level: 'warn' }, pino.destination({ dest: path.join(DADOS, 'baileys.log'), sync: false })), browser: Browsers.ubuntu('Euro Ponte'), markOnlineOnConnect: false, syncFullHistory: true,
      getMessage: async (key) => { try { const l = lerEsp(key.remoteJid); const x = l.find(y => y.id === key.id); return x && x.texto ? { conversation: x.texto } : undefined; } catch (e) { return undefined; } } });
    } catch (e) { if (BAILEYS_VERSAO.startsWith('baileys 7')) { voltarParaAntigo('erro ao criar a conexão: ' + e.message); iniciando = false; return iniciarWhatsApp(); } throw e; }
    log('biblioteca do WhatsApp:', BAILEYS_VERSAO);
    sock = s;
    s.ev.on('creds.update', saveCreds);
    s.ev.on('connection.update', (u) => {
      if (sock !== s) return;
      if (u.qr) { ultimoQR = u.qr; log('QR novo disponível no painel'); emitir('estado', estadoPublico()); }
      if (u.qr || u.connection === 'open') falhasSeguidas = 0;
      if (u.connection === 'open' && !global.__sincronizou) { global.__sincronizou = true; setTimeout(() => { if (sock === s) s.resyncAppState(['critical_block', 'critical_unblock_low', 'regular_high', 'regular_low', 'regular'], true).then(() => { log('etiquetas e contatos sincronizados', Object.keys(etq.labels).length, 'etiquetas'); return lerEquipe(); }).catch(e => log('sincronizar', e.message)); }, 20e3); }
      if (u.connection === 'open') { if (BAILEYS_VERSAO.startsWith('baileys 7')) abriuComV7 = true; conectadoDesde = Date.now(); conectado = true; ultimoQR = null; meuNumero = (s.user && s.user.id || '').split(':')[0]; log('WhatsApp conectado', meuNumero); emitir('estado', estadoPublico());
        // depois que o WhatsApp entregar o que chegou atrasado, confere quem ficou sem resposta (queda, reinício)
        setTimeout(() => { if (sock === s) retomarPendentes('ao conectar').catch(e => log('pendentes', e.message)); }, 45e3); }
      if (u.connection === 'close') {
        conectado = false; ultimoQR = null;
        const code = u.lastDisconnect && u.lastDisconnect.error && u.lastDisconnect.error.output && u.lastDisconnect.error.output.statusCode;
        log('WhatsApp desconectado', code);
        if (code === DisconnectReason.loggedOut) { fs.rmSync(AUTH, { recursive: true, force: true }); fs.mkdirSync(AUTH, { recursive: true }); }
        sock = null;
        emitir('estado', estadoPublico());
        falhasSeguidas++;
        if (BAILEYS_VERSAO.startsWith('baileys 7') && !abriuComV7 && falhasSeguidas >= 4 && temSessao()) voltarParaAntigo('a versão 7 não conseguiu conectar (' + code + ')');
        // quedas comuns (408, 428, 503) voltam sozinhas em segundos: não pausam. Só pausa quando o WhatsApp recusa, desloga ou outro aparelho toma a sessão.
        if (conectadoDesde && Date.now() - conectadoDesde > 30e3) { quedas.push(Date.now()); while (quedas.length && Date.now() - quedas[0] > 3600e3) quedas.shift(); if (quedas.length >= 4) log('conexão instável:', quedas.length, 'quedas na última hora (a assistente segue atendendo)'); }
        if (code === 403) pausarPorSeguranca('o WhatsApp recusou a conexão (403)');
        else if (code === 401) pausarPorSeguranca('o WhatsApp deslogou este aparelho (401)');
        else if (code === 440) pausarPorSeguranca('outro aparelho ou programa assumiu esta sessão do WhatsApp (440)');
        conectadoDesde = 0;
        const espera = Math.min(60e3, 4e3 * Math.pow(1.6, Math.max(0, falhasSeguidas - 1)));
        if (falhasSeguidas >= 6 && code === 428 && !temSessao()) { log('sem QR após várias tentativas; recomeçando a sessão'); }
        clearTimeout(timerReconectar);
        if (!estado.whatsDesligado) timerReconectar = setTimeout(() => iniciarWhatsApp().catch(e => log('erro reconectar', e.message)), espera);
      }
    });
    s.ev.on('messages.upsert', async ({ messages, type }) => {
      for (const m of messages) { try { await aoReceber(m, type); } catch (e) { log('erro mensagem', e.message); } }
    });
    // histórico recente que o WhatsApp manda ao conectar: só vai para o espelho
    s.ev.on('messaging-history.set', async ({ chats: lista, messages, contacts, syncType, progress }) => {
      for (const c of contacts || []) guardarContato(c);
      for (const ch of lista || []) guardarChat(ch);
      let n = 0;
      for (const m of messages || []) { try { await aoReceber(m, 'historico'); n++; } catch (e) { } }
      resolverLids(s).catch(() => { });
      unirDuplicadas();
      log('histórico', syncType, progress == null ? '' : progress + '%', (lista || []).length, 'conversas', (contacts || []).length, 'contatos', n, 'mensagens');
      emitir('recarregar', {});
    });
    s.ev.on('labels.edit', (l) => { if (!l || l.id == null) return; etq.labels[l.id] = { nome: l.name || (etq.labels[l.id] || {}).nome || '', cor: l.color, apagada: !!l.deleted }; salvarEtq(); });
    s.ev.on('labels.association', ({ association: a, type }) => {
      if (!a || !a.chatId || a.labelId == null) return;
      const l = new Set(etq.chats[a.chatId] || []); if (type === 'remove') l.delete(String(a.labelId)); else l.add(String(a.labelId));
      etq.chats[a.chatId] = [...l]; salvarEtq();
      const k = a.chatId + '|' + String(a.labelId), meu = meusRotulos.get(k); meusRotulos.delete(k);
      if (type !== 'remove' && !(meu && Date.now() - meu < 120e3)) {   // você trocou a etiqueta no celular -> muda o status no CRM
        const nome = String((etq.labels[String(a.labelId)] || {}).nome || '').toLowerCase();
        const c = CATS_ETQ.find(x => x.re.test(nome));
        const pn = pnDe(a.chatId); const tel = (chats[a.chatId] || {}).telefone || (pn.endsWith('@s.whatsapp.net') ? pn.split('@')[0] : '');
        const t8 = String(tel || '').replace(/\D/g, '').slice(-8);
        const atual = (estado.crmStatus || {})[t8];
        const mesmo = c && (atual === c.cat || (c.cat === 'corretor_euro' && atual === 'corretor') || (c.cat === 'corretor' && (estado.equipe || []).includes(t8)));
        const recenteMeu = [...meusRotulos.keys()].some(k => k.endsWith('|' + String(a.labelId)) && (k.startsWith(a.chatId) || (pn && k.startsWith(pn)) || (t8 && (chats[k.split('|')[0]] || {}).telefone && String(chats[k.split('|')[0]].telefone).endsWith(t8))) && Date.now() - meusRotulos.get(k) < 300e3);
        if (c && tel && !mesmo && !recenteMeu && !etiquetando.rodando) {
          const NS = { corretor_euro: 'corretor', atendimento: 'atendimento', novo: 'remarcar', visita: 'visita_marcada', negociacao: 'negociacao', fechado: 'fechado', pausado: 'pausado', perdido: 'perdido', desistiu: 'desistiu', corretor: 'corretor', construtor: 'construtor', pessoal: 'pessoal' };
          fs.appendFileSync(path.join(DADOS, 'eventos-crm.jsonl'), JSON.stringify({ rid: 'et' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), ts: new Date().toISOString(), telefone: formatoBR(tel), nome: (chats[a.chatId] || {}).nome || '', novoStatus: NS[c.cat], resultado: 'Etiqueta "' + (etq.labels[String(a.labelId)] || {}).nome + '" colocada no WhatsApp' }) + '\n');
          estado.crmStatus = estado.crmStatus || {}; estado.crmStatus[String(tel).replace(/\D/g, '').slice(-8)] = c.cat; salvarEstado();
          setTimeout(() => garantirEtiquetas().then(ids => definirEtiqueta(a.chatId, c.cat, ids)).catch(() => { }), 3000);   // tira a etiqueta de status antiga
        }
      }
    });
    s.ev.on('lid-mapping.update', (u) => {
      const arr = Array.isArray(u) ? u : (u && Array.isArray(u.mappings) ? u.mappings : [u]);
      for (const x of arr) { if (x && x.lid && x.pn) ligarLid(String(x.lid), String(x.pn).includes('@') ? String(x.pn) : x.pn + '@s.whatsapp.net'); }
    });
    s.ev.on('chats.upsert', (lista) => { for (const ch of lista || []) guardarChat(ch); });
    s.ev.on('chats.update', (lista) => { for (const ch of lista || []) guardarChat(ch); });
    s.ev.on('contacts.upsert', (lista) => { for (const c of lista || []) guardarContato(c); });
    s.ev.on('contacts.update', (lista) => { for (const c of lista || []) guardarContato(c); });
  } finally { iniciando = false; }
}
async function resolverLids(s) {
  const lm = s && s.signalRepository && s.signalRepository.lidMapping;
  if (!lm || typeof lm.getPNForLID !== 'function') return;
  let n = 0;
  for (const jid of Object.keys(chats)) {
    if (!jid.endsWith('@lid') || lidPn[jid]) continue;
    try { const pn = await lm.getPNForLID(jid); if (pn) { ligarLid(jid, String(pn).replace(/:\d+@/, '@')); n++; } } catch (e) { }
  }
  if (n) log('telefones descobertos pelo LID', n);
}
async function resolverTelefones(lista) {
  if (!sock || !conectado) throw new Error('WhatsApp desconectado');
  await carregarBaileys(); const B = { USyncQuery: BPICK('USyncQuery'), USyncUser: BPICK('USyncUser') };
  const nums = [...new Set((lista || []).map(t => String(t || '').replace(/\D/g, '')).filter(t => t.length >= 10).map(t => t.startsWith('55') ? t : '55' + t))];
  let achou = 0;
  for (let i = 0; i < nums.length; i += 40) {
    const lote = nums.slice(i, i + 40);
    try {
      if (B.USyncQuery && B.USyncUser && sock.executeUSyncQuery) {
        const q = new B.USyncQuery().withContactProtocol().withLIDProtocol();
        for (const n of lote) q.withUser(new B.USyncUser().withPhone('+' + n));
        const r = await sock.executeUSyncQuery(q);
        for (const x of (r && r.list) || []) { if (x.lid && x.id) { ligarLid(x.lid, x.id); achou++; } }
      } else {
        const r = await sock.onWhatsApp(...lote);
        for (const x of r || []) { if (x.lid && x.jid) { ligarLid(x.lid, x.jid); achou++; } }
      }
    } catch (e) { log('resolver telefones', e.message); }
    await new Promise(r => setTimeout(r, 600));
  }
  log('telefones ligados às conversas', achou, 'de', nums.length);
  unirDuplicadas();
  return { consultados: nums.length, ligados: achou, conversasComTelefone: Object.keys(chats).filter(j => chats[j].telefone || lidPn[j]).length };
}
function acharJid(j) {   // telefone (5547...@s.whatsapp.net) -> conversa existente (muitas vêm como código @lid)
  j = String(j || ''); if (!j || chats[j]) return j;
  if (!j.endsWith('@s.whatsapp.net')) return j;
  const t8 = j.split('@')[0].replace(/\D/g, '').slice(-8); if (t8.length < 8) return j;
  let melhor = '', ult = -1;
  for (const k of Object.keys(chats)) { const tel = String(chats[k].telefone || pnDe(k).split('@')[0] || ''); if (tel.replace(/\D/g, '').endsWith(t8) && (chats[k].ult || 0) > ult) { melhor = k; ult = chats[k].ult || 0; } }
  return melhor || j;
}
function unirDuplicadas() {   // mesma pessoa em duas conversas (número e código interno): junta na do código
  let n = 0;
  for (const pnj of Object.keys(chats).filter(k => k.endsWith('@s.whatsapp.net'))) {
    const t8 = pnj.split('@')[0].replace(/\D/g, '').slice(-8); if (t8.length < 8) continue;
    const alvo = Object.keys(chats).find(k => k !== pnj && k.endsWith('@lid') && String(chats[k].telefone || pnDe(k).split('@')[0] || '').replace(/\D/g, '').endsWith(t8));
    if (!alvo) continue;
    try {
      const juntos = [...lerEsp(alvo)]; const ids = new Set(juntos.map(x => x.id));
      for (const x of lerEsp(pnj)) if (!x.id || !ids.has(x.id)) juntos.push(x);
      juntos.sort((a, b) => a.ts - b.ts); gravarJson(arqEsp(alvo), juntos.slice(-1000));
      const a = chats[alvo], b = chats[pnj];
      if ((b.ult || 0) > (a.ult || 0)) { a.ult = b.ult; a.ultTexto = b.ultTexto; a.ultAutor = b.ultAutor; }
      if (!a.telefone && b.telefone) a.telefone = b.telefone; if (!a.nome && b.nome) a.nome = b.nome;
      delete chats[pnj]; try { fs.unlinkSync(arqEsp(pnj)); } catch (e) { }
      n++;
    } catch (e) { log('unir conversas', e.message); }
  }
  if (n) { salvarChats(); log('conversas duplicadas unidas:', n); }
  return n;
}
async function arquivarChat(jid, arquivar) {
  if (!sock || !conectado) throw new Error('WhatsApp desconectado');
  const c = chats[jid] || (chats[jid] = {});
  let k = c.ultKey, ts = c.ultKeyTs;
  if (!k) { const l = lerEsp(jid); const u = l[l.length - 1]; if (u && u.id) { k = { id: u.id, fromMe: u.autor !== 'cliente' }; ts = u.ts; } }
  const lastMessages = k ? [{ key: { remoteJid: jid, id: k.id, fromMe: !!k.fromMe }, messageTimestamp: Math.floor((ts || c.ult || Date.now()) / 1000) }] : [];
  await sock.chatModify({ archive: !!arquivar, lastMessages }, jid);
  c.arquivado = !!arquivar; salvarChats();
}
// O modelo pode gastar parte do limite raciocinando antes de escrever; com limite baixo a resposta saía cortada
// (foi o que dava "a IA não devolveu o JSON" no follow-up). Por isso o piso de 5.000 tokens: só se paga o que for usado.
async function claudeTexto(system, texto, maxTokens = 3000, temperatura) {
  for (let t = 0; t < 3; t++) {
    const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, body: JSON.stringify(Object.assign({ model: MODELO, max_tokens: Math.max(maxTokens, 5000), system, messages: [{ role: 'user', content: texto }] }, temperatura === undefined ? {} : { temperature: temperatura })) });
    if (r.ok) { const j = await r.json(); if (j.usage) registrarUso(j.usage); return (j.content || []).map(x => x.text || '').join(''); }
    if (![429, 500, 502, 503, 529].includes(r.status)) throw new Error('API ' + r.status + ' ' + (await r.text()).slice(0, 200));
    await new Promise(res => setTimeout(res, 5000 * (t + 1)));
  }
  throw new Error('API indisponível');
}
// ===== FICHA DE ATENDIMENTO (pedido do Djhonata, 13/11/2026) =====
// Quando o cliente marca visita, o servidor lê a conversa e monta a ficha que o Djhonata abre no card do CRM (e imprime) antes de atender:
// imóvel de interesse, fluxo de pagamento que o cliente recebeu, o que ele quer, objeções, pendências. Refaz sozinha quando o cliente volta a falar,
// até o card entrar em negociação (veio ao escritório).
const FICHAS_DIR = path.join(DADOS, 'fichas');
try { fs.mkdirSync(FICHAS_DIR, { recursive: true }); } catch (e) { }
const arqFichaAt = (jid) => path.join(FICHAS_DIR, String(jid).replace(/[^0-9a-zA-Z@._-]/g, '_') + '.json');
const lerFichaAt = (jid) => lerJson(arqFichaAt(jid), null);
const fichaAt = { gerando: {}, erros: {}, fila: [], ativos: 0, varrendo: false };
const SIS_FICHA = `Você monta a FICHA DE ATENDIMENTO de um cliente para o corretor Djhonata (Euro Consultoria Imobiliária, Joinville) ler antes de receber o cliente no escritório. Leia a conversa do WhatsApp e devolva SOMENTE um JSON, sem texto antes nem depois, exatamente neste formato:
{"imovel":{"pasta":"pasta exata de um dos imóveis enviados, ou vazio","unidade":"unidade tratada com o cliente e se é de ponta ou de meio, ou vazio","medidas":"medidas ditas ao cliente (frente, fundos, abertura), ou vazio"},"fluxo":{"enviado":true,"quando":"DD/MM às HHhMM","linhas":[{"item":"Sinal na assinatura","valor":"R$ 10.000,00"}],"total":"R$ 380.000,00 ou vazio","dito":"condição ou ressalva dita ao cliente, ou vazio","resposta":"o que o cliente respondeu sobre o fluxo"},"quer":["Rótulo: o que ele quer"],"informou":["FGTS: ...","Carteira assinada: ...","Renda: ...","Sinal: ...","Quem compra junto: ..."],"objecoes":[{"ponto":"a dúvida ou objeção, com as palavras dele quando ajudar","status":"Em aberto | Resolvida | Explicada | Respondida","nota":"como ficou, em uma frase"}],"pendencias":["o que foi prometido ao cliente e ainda não foi entregue"],"comecar":["até 3 passos, em ordem, para abrir o atendimento no escritório"]}
Regras:
- Use só o que está na conversa e nos dados dos imóveis. Não invente. O que o cliente não disse fica como "não informou".
- Imóvel de interesse: o que o cliente escolheu, ou o último que ele não recusou. Imóvel que ele recusou não entra; se a recusa mostra uma preferência (ex.: não quer pronto, quer mais terreno), escreva a preferência em "quer".
- "fluxo": o fluxo de pagamento na ÚLTIMA versão que o cliente recebeu para o imóvel de interesse, item por item, com os valores como foram ditos (inclua FGTS e financiamento se foram ditos). Se nenhum fluxo foi enviado: "enviado": false e "linhas": [].
- "quer": bairro, valor, tipo, exigências (casa de ponta, terreno, vagas, prazo). "informou": o que ele contou de renda, FGTS, carteira, sinal, quem compra junto.
- "objecoes": toda dúvida ou objeção que apareceu, com o status. "pendencias": promessas em aberto (planta, resposta, retorno).
- "comecar": comece pelo que está em aberto e pode derrubar a venda.
- Mensagens [ia] e [voce] foram enviadas em nome do Djhonata. Frases curtas, português simples, sem emoji. Valores no formato R$ 10.000,00.`;
function fichaQuando(q) { const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/.exec(q || ''); if (!m) return ''; const d = new Date(+m[1], +m[2] - 1, +m[3]); return ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'][d.getDay()] + `, ${m[3]}/${m[2]}/${m[1]}` + (m[4] ? `, às ${+m[4]}h${m[5] !== '00' ? m[5] : ''}` : ''); }
function fichaLinha(m) { const d = new Date((m.ts || 0) - 3 * 3600e3).toISOString(); return d.slice(8, 10) + '/' + d.slice(5, 7) + ' ' + d.slice(11, 16) + ' [' + m.autor + (m.tipo && m.tipo !== 'text' ? ':' + m.tipo : '') + '] ' + String(m.texto || '').replace(/\s*\n+\s*/g, ' / ').slice(0, 1500); }
function fichaImovel(pasta) {   // dados do imóvel como estão no cadastro (ficha.md), mais o fluxo padrão de hoje
  const t = lerTexto(path.join(pasta, 'ficha.md')).replace(/\r/g, ''), g = (re) => ((re.exec(t) || [])[1] || '').trim(), f = dadosDaFicha(pasta);
  let padrao = []; try { const x = simularFluxo({ imovel: pasta }); if (x && x.texto) padrao = x.texto.split('\n').filter(l => /^(✅|💵)/.test(l)).map(l => l.replace(/^(✅|💵)\s*/, '').trim()); } catch (e) { }
  return { pasta, ref: geoRef(pasta), nome: f.nome, endereco: g(/^-\s*Endere[çc]o:\s*([^\n]+)/mi), tipo: g(/^-\s*Tipo de constru[çc][ãa]o:\s*([^\n]+)/mi) || g(/^-\s*Tipo:\s*([^\n]+)/mi), area: g(/^-\s*[ÁA]rea:\s*([^\n]+)/mi), comodos: g(/^-\s*C[ôo]modos:\s*([^\n]+)/mi), vagas: g(/^-\s*Vagas:\s*([^\n]+)/mi),
    preco: f.preco ? brl(f.preco) : '', entrega: g(/^-\s*Entrega:\s*([^\n]+)/mi), unidades: g(/^-\s*Unidades dispon[íi]veis:\s*([^\n]+)/mi).slice(0, 300), projeto: projetosDaPasta(pasta).length ? 'Projeto na pasta do imóvel' : 'Sem projeto na pasta do imóvel', temFoto: !!midiaDaOferta(pasta).foto1, padrao };
}
async function fichaGerar(jid, motivo) {
  if (fichaAt.gerando[jid]) return null; fichaAt.gerando[jid] = Date.now();
  try {
    const todas = lerEsp(jid), l = todas.filter(m => m.autor !== 'aviso' && (String(m.texto || '').trim() || (m.tipo && m.tipo !== 'text'))); if (!l.length) return null;
    const c = chatPublico(jid) || {}, cc = chats[jid] || {}, st = (estado.crmStatus || {})[tel8Chat(jid)] || '';
    const ims = [...new Set(l.map(m => m.oferta).filter(Boolean))].filter(p => lerTexto(path.join(p, 'ficha.md'))).slice(-4).map(fichaImovel);
    const vis = (estado.visitas || {})[jid], visTxt = vis && vis.q ? fichaQuando(vis.q) : '';
    const origem = cc.anuncio ? 'Anúncio' + (cc.anuncio.titulo ? ' "' + cc.anuncio.titulo + '"' : '') : 'Chamou no WhatsApp';
    const dados = `CLIENTE: ${c.nome || 'sem nome'} | telefone ${c.telefone || ''} | origem: ${origem} | etapa no CRM: ${st || 'sem card'}${visTxt ? ' | visita marcada: ' + visTxt : ''}\n\nIMÓVEIS ENVIADOS NA CONVERSA (dados do cadastro):\n`
      + (ims.map(i => `- pasta: ${i.pasta} | ${i.nome} | ${i.endereco} | ${i.tipo} | ${i.area} | ${i.comodos} | ${i.vagas} | ${i.preco} | entrega: ${i.entrega} | unidades: ${i.unidades || 'não informado'}`).join('\n') || '(nenhum imóvel do catálogo foi enviado)')
      + '\n\nCONVERSA (horário de Joinville):\n' + l.slice(-220).map(fichaLinha).join('\n');
    const bruto = await claudeTexto(SIS_FICHA, dados, 1800, 0);
    const mj = /\{[\s\S]*\}/.exec(bruto || ''); let j = null; try { j = mj ? JSON.parse(mj[0]) : null; } catch (e) { }
    if (!j || typeof j !== 'object') throw new Error('resposta sem JSON');
    const tx = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n), lista = (v, n) => (Array.isArray(v) ? v : []).map(x => tx(x, 220)).filter(Boolean).slice(0, n);
    const ji = j.imovel || {}, fl = j.fluxo || {}, im = ims.find(i => i.pasta === ji.pasta) || (ims.length === 1 ? ims[0] : null);
    const linhas = (Array.isArray(fl.linhas) ? fl.linhas : []).map(x => ({ item: tx((x || {}).item, 120), valor: tx((x || {}).valor, 40) })).filter(x => x.item).slice(0, 10);
    const ficha = { v: 1, jid, nome: c.nome || '', telefone: c.telefone || '', origem, crm: st, visita: visTxt,
      imovel: im ? Object.assign({}, im, { unidade: tx(ji.unidade, 160), medidas: tx(ji.medidas, 160) }) : null,
      fluxo: { enviado: !!fl.enviado && linhas.length > 0, quando: tx(fl.quando, 40), linhas, total: tx(fl.total, 40), dito: tx(fl.dito, 300), resposta: tx(fl.resposta, 300) },
      quer: lista(j.quer, 7), informou: lista(j.informou, 7),
      objecoes: (Array.isArray(j.objecoes) ? j.objecoes : []).map(o => ({ ponto: tx((o || {}).ponto, 140), status: tx((o || {}).status, 20), nota: tx((o || {}).nota, 200) })).filter(o => o.ponto).slice(0, 7),
      pendencias: lista(j.pendencias, 5), comecar: lista(j.comecar, 3), geradaEm: Date.now(), ateTs: todas[todas.length - 1].ts || 0, deTs: l[0].ts || 0, msgs: l.length, motivo };
    gravarJson(arqFichaAt(jid), ficha); delete fichaAt.erros[jid];
    log('ficha de atendimento:', motivo, jid, im ? im.nome : 'sem imóvel');
    return ficha;
  } catch (e) { fichaAt.erros[jid] = { em: Date.now(), msg: e.message }; log('ficha: falhou', jid, e.message); return null; }
  finally { delete fichaAt.gerando[jid]; }
}
function fichaRodar() { while (fichaAt.ativos < 2 && fichaAt.fila.length) { const x = fichaAt.fila.shift(); fichaAt.ativos++; fichaGerar(x.jid, x.motivo).catch(() => { }).finally(() => { fichaAt.ativos--; fichaRodar(); }); } }
function fichaPedir(jid, motivo) { if (!jid || fichaAt.gerando[jid] || fichaAt.fila.some(x => x.jid === jid)) return; fichaAt.fila.push({ jid, motivo }); fichaRodar(); }
const fichaNaFila = (jid) => !!fichaAt.gerando[jid] || fichaAt.fila.some(x => x.jid === jid);
function fichaAlvo(v) { v = String(v || ''); if (v.includes('@')) return acharJid(v); const t8 = v.replace(/\D/g, '').slice(-8); if (t8.length < 8) return ''; return Object.keys(chats).find(j => jidValido(j) && !j.endsWith('@g.us') && tel8Chat(j) === t8) || ''; }
// Varredura (a cada 2 min): quem tem visita guardada e ainda não tem ficha ganha a ficha; quem tem ficha e voltou a conversar tem a ficha refeita
// depois de 8 min sem mensagem nova. Card em negociação ou fechado: o cliente já veio ao escritório e a ficha para de mudar.
function fichaVarrer() {
  if (!API_KEY || fichaAt.varrendo) return; fichaAt.varrendo = true;
  try {
    const cand = new Set(Object.keys(estado.visitas || {}));
    try { for (const f of fs.readdirSync(FICHAS_DIR)) if (f.endsWith('.json')) { const x = lerJson(path.join(FICHAS_DIR, f), null); if (x && x.jid) cand.add(x.jid); } } catch (e) { }
    for (const jid of cand) {
      if (fichaNaFila(jid)) continue;
      const fx = lerFichaAt(jid), l = lerEsp(jid); if (!l.length) continue;
      const ult = l[l.length - 1].ts || 0, st = (estado.crmStatus || {})[tel8Chat(jid)] || '', er = fichaAt.erros[jid];
      if (er && Date.now() - er.em < 30 * 60e3) continue;
      if (fx && /^(negociacao|fechado)$/.test(st)) continue;
      if (fx && (ult <= (fx.ateTs || 0) || Date.now() - ult < 8 * 60e3)) continue;
      fichaPedir(jid, fx ? 'conversa nova' : 'visita marcada');
    }
  } catch (e) { log('ficha: varredura', e.message); } finally { fichaAt.varrendo = false; }
}
setInterval(fichaVarrer, 2 * 60e3);
const classif = { rodando: false, feitos: 0, total: 0, erro: '' };
const SIS_CLASSE = `Você organiza o WhatsApp de Djhonata, corretor de imóveis da Euro Consultoria (Joinville/SC), que vende casas geminadas e apartamentos na planta.
Para cada conversa, escolha UMA categoria:
- cliente: pessoa interessada em comprar imóvel que AINDA NÃO comprou (lead de anúncio, pediu valores, visita, simulação, documentos para financiamento em andamento). Leads antigos ou que sumiram continuam "cliente".
- comprou: já comprou imóvel com ele (marcado no CRM como comprador, ou a conversa mostra contrato assinado, financiamento assinado, entrega de chaves, pagamento de honorários/sinal já feito).
- corretor: outro corretor, imobiliária, parceiro de vendas, captador.
- construtor: construtora, incorporadora, engenheiro, empreiteiro, loteadora, fornecedor de obra.
- pessoal: família, amigos, assuntos pessoais, serviços pessoais (oficina, médico, loja, banco pessoal), colegas sem relação com venda.
- duvida: não dá para saber (sem mensagens e nome sem pista).
Na dúvida entre "cliente" e outra categoria, escolha "cliente". Responda SOMENTE com JSON: [{"n":número,"cat":"categoria","motivo":"até 8 palavras"}].`;
// Regra do Djhonata: nas conversas ficam só os clientes em foco (interagindo, visita marcada, negociando, "Importante").
// Arquiva: comprou / pedido finalizado, perdido (+7 dias sem falar), corretor, construtor/captação, pessoal.
function ultCli(jid) {   // última mensagem do cliente (calcula do espelho para conversas que vieram do histórico)
  const c = chats[jid] || {};
  if (c.ultCliente === undefined) { const l = lerEsp(jid); let t = 0; for (const m of l) if (m.autor === 'cliente' && m.ts > t) t = m.ts; c.ultCliente = t; salvarChats(); }
  return c.ultCliente || 0;
}
async function classificarTudo(compradores, refazer, crm = {}) {
  if (classif.rodando) return;
  estado.classes = {};
  const tel8 = (t) => String(t || '').replace(/\D/g, '').slice(-8);
  const comp = new Set((compradores || []).map(tel8).filter(x => x.length === 8));
  const st = {}; for (const [t, v] of Object.entries(crm.status || {})) { const k = tel8(t); if (k.length === 8) st[k] = v; }
  estado.crmStatus = st;
  for (const k of ['corretor', 'construtor', 'pessoal']) for (const t of (crm[k] || [])) { const x = tel8(t); if (x.length === 8) st[x] = k; }
  const SETE = 7 * 864e5, agora = Date.now();
  const lista = Object.keys(chats).filter(j => !chats[j].arquivado).sort((a, b) => (chats[b].ult || 0) - (chats[a].ult || 0));
  Object.assign(classif, { rodando: true, feitos: 0, total: lista.length, erro: '' });
  const paraIA = [];
  const marca = (jid, cat, motivo) => { estado.classes[jid] = { cat, motivo }; };
  try {
    for (const jid of lista) {
      const c = chats[jid]; const t = tel8(c.telefone || pnDe(jid).split('@')[0]);
      const etqs = etiquetasDe(jid).map(e => String(e.nome || '').toLowerCase());
      const uc = ultCli(jid); const recente = uc && agora - uc < SETE;
      const s = t.length === 8 ? st[t] : '';
      if (t.length === 8 && (estado.equipe || []).includes(t)) marca(jid, 'corretor', 'corretor da Euro (grupo)');
      else if (etqs.some(n => /import/.test(n))) marca(jid, 'cliente', 'etiqueta Importante');
      else if (etqs.some(n => /finaliz|pago|comprou|vendid/.test(n))) marca(jid, 'comprou', 'etiqueta ' + etqs.find(n => /finaliz|pago|comprou|vendid/.test(n)));
      else if (etqs.some(n => /capta|constru/.test(n))) marca(jid, 'construtor', 'etiqueta ' + etqs.find(n => /capta|constru/.test(n)));
      else if (t.length === 8 && comp.has(t)) marca(jid, 'comprou', 'comprador no CRM');
      else if (s === 'fechado') marca(jid, 'comprou', 'negócio fechado no CRM');
      else if (s === 'corretor' || s === 'construtor' || s === 'pessoal') marca(jid, s, 'marcado no CRM');
      else if (s === 'perdido' || s === 'desistiu' || s === 'pausado') marca(jid, 'perdido', 'CRM: ' + s);
      else if (s === 'visita' || s === 'negociacao') marca(jid, 'cliente', 'CRM: ' + (s === 'visita' ? 'visita marcada' : 'em negociação'));
      else if (s) marca(jid, recente ? 'cliente' : 'perdido', recente ? 'CRM: em atendimento' : 'CRM: sem conversa há +7 dias');
      else if (!recente) marca(jid, 'perdido', uc ? 'sem conversa há +7 dias' : 'nunca respondeu');
      else paraIA.push(jid);
      classif.feitos++;
    }
    classif.total = lista.length; salvarEstado();
    // Só as conversas recentes de quem não está no CRM passam pela IA (corretor? pessoal? cliente novo?)
    for (let i = 0; i < paraIA.length && API_KEY; i += 15) {
      const lote = paraIA.slice(i, i + 15);
      const blocos = lote.map((jid, k) => {
        const c = chats[jid]; const tel = c.telefone || '';
        const msgs = lerEsp(jid).filter(m => m.texto || m.tipo !== 'text').slice(-12).map(m => (m.autor === 'cliente' ? 'C: ' : 'D: ') + (m.texto ? m.texto.replace(/\s+/g, ' ').slice(0, 160) : '[' + m.tipo + ']')).join('\n');
        return `#${k + 1} nome: ${c.nome || contatos[jid] || contatos[pnDe(jid)] || '(sem nome)'} | telefone: ${tel || '?'}\n${msgs || '(sem mensagens)'}`;
      }).join('\n\n');
      let resp = '';
      try { resp = await claudeTexto(SIS_CLASSE, blocos); } catch (e) { classif.erro = e.message; log('classificar', e.message); continue; }
      const a = resp.indexOf('['), b = resp.lastIndexOf(']');
      let arr = []; try { arr = JSON.parse(resp.slice(a, b + 1)); } catch (e) { }
      for (const r of arr) { const jid = lote[(Number(r.n) || 0) - 1]; if (jid && r.cat) marca(jid, r.cat === 'duvida' ? 'cliente' : String(r.cat), String(r.motivo || '').slice(0, 80)); }
      salvarEstado();
    }
    for (const jid of paraIA) if (!estado.classes[jid]) marca(jid, 'cliente', 'conversa recente');
  } finally { classif.rodando = false; salvarEstado(); log('organização terminou', lista.length, 'conversas;', paraIA.length, 'pela IA'); }
}
// ---------- etiquetas por categoria ----------
// Uma etiqueta por conversa: Cliente, Visita marcada, Negociando, Já comprou, Corretor, Construtor, Pessoal.
const CATS_ETQ = [   // espelho das colunas do CRM (status do cliente)
  { cat: 'atendimento', nome: 'Atendimento online', re: /atendim|^client/, cor: 1 },
  { cat: 'novo', nome: 'Remarcar visita', re: /remarc/, cor: 2 },
  { cat: 'visita', nome: 'Visita marcada', re: /^visita|visita marc|agend/, cor: 3 },
  { cat: 'negociacao', nome: 'Em negociação', re: /negocia|import/, cor: 5 },
  { cat: 'fechado', nome: 'Negócio fechado', re: /fechad|finaliz|comprou|pago/, cor: 8 },
  { cat: 'pausado', nome: 'Pausado', re: /pausad/, cor: 9 },
  { cat: 'perdido', nome: 'Perdido', re: /perdid/, cor: 11 },
  { cat: 'desistiu', nome: 'Desistiu / comprou com outro', re: /desist/, cor: 13 },
  { cat: 'corretor_euro', nome: 'Corretor Euro', re: /corretor euro|corretores euro|equipe/, cor: 6 },
  { cat: 'corretor', nome: 'Corretor parceiro', re: /parceir/, cor: 10 },
  { cat: 'construtor', nome: 'Construtores', re: /constru|capta/, cor: 12 },
  { cat: 'pessoal', nome: 'Pessoais', re: /pessoa|famil|amig/, cor: 15 }
];
let garantindo = null;
function garantirEtiquetas() { if (!garantindo) garantindo = garantirEtiquetas0().finally(() => { garantindo = null; }); return garantindo; }
async function garantirEtiquetas0() {
  const ids = {};
  for (const [id, l] of Object.entries(etq.labels)) {   // a etiqueta "Corretor" criada antes pela ponte vira "Corretor parceiro"
    if (Number(id) >= 90 && !l.apagada && String(l.nome || '').trim().toLowerCase() === 'corretor' && typeof sock.addLabel === 'function') {
      try { await sock.addLabel('', { id, name: 'Corretor parceiro', color: l.cor || 10, deleted: false }); l.nome = 'Corretor parceiro'; salvarEtq(); log('etiqueta renomeada: Corretor -> Corretor parceiro'); } catch (e) { log('renomear etiqueta', e.message); }
    }
  }
  for (const c of CATS_ETQ) {
    const ach = Object.entries(etq.labels).find(([, l]) => !l.apagada && c.re.test(String(l.nome || '').toLowerCase()));
    if (ach) { ids[c.cat] = ach[0]; continue; }
    if (typeof sock.addLabel !== 'function') continue;
    let novo = 90; while (etq.labels[String(novo)]) novo++;
    try { await sock.addLabel('', { id: String(novo), name: c.nome, color: c.cor, deleted: false }); etq.labels[String(novo)] = { nome: c.nome, cor: c.cor }; ids[c.cat] = String(novo); salvarEtq(); log('etiqueta criada', c.nome); }
    catch (e) { log('criar etiqueta', c.nome, e.message); }
    await dorme(800);
  }
  return ids;
}
async function lerEquipe() {     // participantes do grupo "Euro Imobiliária" = corretores da casa
  if (!sock || !conectado) return;
  try {
    const grupos = await sock.groupFetchAllParticipating();
    const g = Object.values(grupos || {}).find(x => /euro\s*imobili/i.test(String(x.subject || '')));
    if (!g) { log('grupo Euro Imobiliária não encontrado'); return; }
    const tels = [];
    for (const p of g.participants || []) {
      let pn = [p.phoneNumber, p.jid, p.id].find(x => String(x || '').endsWith('@s.whatsapp.net')) || '';
      if (!pn && String(p.id || '').endsWith('@lid')) pn = lidPn[p.id] || '';
      if (p.id && String(p.id).endsWith('@lid') && pn) ligarLid(p.id, pn);
      const t = String(pn).split('@')[0].replace(/\D/g, '').slice(-8);
      if (t.length === 8 && !ehDono(pn)) tels.push(t);
    }
    estado.equipe = [...new Set(tels)]; salvarEstado();
    log('equipe Euro:', estado.equipe.length, 'corretores no grupo', g.subject);
  } catch (e) { log('ler equipe', e.message); }
}
function catEtiqueta(jid) {    // status do CRM manda; sem CRM, usa a organização (comprou -> fechado, cliente -> atendimento)
  const t = String((chats[jid] || {}).telefone || pnDe(jid).split('@')[0] || '').replace(/\D/g, '').slice(-8);
  const st = (estado.crmStatus || {})[t] || '';
  if (t && (estado.equipe || []).includes(t)) return 'corretor_euro';
  if (CATS_ETQ.some(c => c.cat === st)) return st;
  const cl = (estado.classes || {})[jid]; const cat = cl ? cl.cat : '';
  return { comprou: 'fechado', cliente: 'atendimento', duvida: 'atendimento', perdido: 'perdido', corretor: 'corretor', construtor: 'construtor', pessoal: 'pessoal' }[cat] || '';
}
async function definirEtiqueta(jid, cat, ids) {
  if (!cat || !ids[cat]) return false;
  const tem = new Set(etq.chats[jid] || []);
  let mudou = false;
  for (const c of CATS_ETQ) {
    const id = ids[c.cat]; if (!id) continue;
    const quer = c.cat === cat;
    if (quer === tem.has(id)) continue;
    meusRotulos.set(jid + '|' + id, Date.now());
    if (quer) await sock.addChatLabel(jid, id); else await sock.removeChatLabel(jid, id);
    quer ? tem.add(id) : tem.delete(id); mudou = true;
    await dorme(acaso(350, 700));
  }
  etq.chats[jid] = [...tem]; salvarEtq();
  return mudou;
}
const etiquetando = { rodando: false, feitos: 0, total: 0 };
const meusRotulos = new Map();   // trocas de etiqueta feitas pela ponte (para não confundir com as feitas no celular)
async function etiquetarTudo() {
  if (etiquetando.rodando || !sock || !conectado) return;
  await lerEquipe();
  const ids = await garantirEtiquetas();
  const lista = Object.keys(chats).filter(j => catEtiqueta(j));
  Object.assign(etiquetando, { rodando: true, feitos: 0, total: lista.length });
  try { for (const jid of lista) { if (!sock || !conectado) break; try { await definirEtiqueta(jid, catEtiqueta(jid), ids); } catch (e) { log('etiquetar', jid, e.message); } etiquetando.feitos++; } }
  finally { etiquetando.rodando = false; log('etiquetas aplicadas', etiquetando.feitos, 'conversas'); }
}
async function aplicarEtiquetaStatus(jid, novoStatus) {
  // A assistente registrou um evento: a etiqueta da conversa acompanha o novo status do CRM.
  if (!sock || !conectado || !jid) return;
  const st = String(novoStatus || '').toLowerCase();
  const cat = { atendimento: 'atendimento', visita_marcada: 'visita', visita: 'visita', negociacao: 'negociacao', remarcar: 'novo', pausado: 'pausado', sem_interesse: 'desistiu', desistiu: 'desistiu' }[st];
  if (!cat) return;
  const t = String((chats[jid] || {}).telefone || pnDe(jid).split('@')[0] || '').replace(/\D/g, '').slice(-8);
  if (t) { estado.crmStatus = estado.crmStatus || {}; estado.crmStatus[t] = cat; salvarEstado(); }
  try { await definirEtiqueta(jid, cat, await garantirEtiquetas()); } catch (e) { log('etiqueta', e.message); }
}
async function atualizarStatusCrm(mapa) {
  // O CRM manda o status de cada telefone; só as conversas que mudaram trocam de etiqueta.
  const tel8 = (x) => String(x || '').replace(/\D/g, '').slice(-8);
  const novo = {}; for (const [t, v] of Object.entries(mapa || {})) { const k = tel8(t); if (k.length === 8) novo[k] = v; }
  const antigo = estado.crmStatus || {}; estado.crmStatus = novo; salvarEstado();
  if (!sock || !conectado || etiquetando.rodando || !Object.keys(etq.labels).length) return 0;
  const mud = new Set(Object.keys(novo).filter(k => antigo[k] !== novo[k]));
  if (!mud.size) return 0;
  const ids = await garantirEtiquetas(); let n = 0;
  for (const jid of Object.keys(chats)) { const t = tel8(chats[jid].telefone || pnDe(jid).split('@')[0]); if (mud.has(t)) { try { if (await definirEtiqueta(jid, catEtiqueta(jid), ids)) n++; } catch (e) { } } }
  if (n) log('etiquetas atualizadas pelo CRM', n);
  return n;
}
async function desconectarWhatsApp() {
  estado.whatsDesligado = true; salvarEstado(); clearTimeout(timerReconectar);
  const s = sock;
  try { if (s) await s.logout(); } catch (e) { log('logout', e.message); }
  try { if (s) s.end(undefined); } catch (e) { }
  sock = null; conectado = false; ultimoQR = null;
  fs.rmSync(AUTH, { recursive: true, force: true }); fs.mkdirSync(AUTH, { recursive: true });
  log('WhatsApp DESCONECTADO pelo painel');
  emitir('estado', estadoPublico());
}
let falhasSeguidas = 0, timerReconectar = null, conectadoDesde = 0;
function temSessao() { try { return fs.readdirSync(AUTH).length > 0; } catch (e) { return false; } }
async function conectarWhatsApp() {
  estado.whatsDesligado = false; salvarEstado(); falhasSeguidas = 0; clearTimeout(timerReconectar);
  if (!sock) await iniciarWhatsApp();
  emitir('estado', estadoPublico());
}

// ---------- servidor web: painel (espelho) + recebimento do catálogo ----------
function tokenOk(u) { const t = u.searchParams.get('t') || ''; return TOKEN && t.length === TOKEN.length && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(TOKEN)); }
let VERSAO = ''; try { VERSAO = crypto.createHash('sha1').update(fs.readFileSync(path.join(BASE, 'index.js'))).digest('hex'); } catch (e) { }   // impressão digital do programa que está rodando (o CRM e o PC conferem se a atualização chegou)
const SESSAO = crypto.createHmac('sha256', TOKEN || 'sem-token').update('painel-v2').digest('hex');
function cookies(req) { const o = {}; for (const p of String(req.headers.cookie || '').split(';')) { const i = p.indexOf('='); if (i > 0) o[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); } return o; }
function logado(req, u) { const c = cookies(req).ep || ''; return (c.length === SESSAO.length && crypto.timingSafeEqual(Buffer.from(c), Buffer.from(SESSAO))) || tokenOk(u); }
function senhaOk(s) { s = String(s || ''); return [TOKEN, SENHA].filter(Boolean).some(v => v.length === s.length && crypto.timingSafeEqual(Buffer.from(v), Buffer.from(s))); }
function cookieSessao(req) { const https = req.headers['x-forwarded-proto'] === 'https'; return `ep=${SESSAO}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${https ? '; Secure' : ''}`; }
function listarCatalogo() {
  const out = {};
  (function andar(dir, rel) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) andar(path.join(dir, e.name), r);
      else { const st = fs.statSync(path.join(dir, e.name)); out[r] = [st.size, Math.floor(st.mtimeMs / 1000)]; }
    }
  })(CATALOGO, '');
  return out;
}
function json(res, v, code = 200) { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(v)); }
function corpo(req, limite = 20e6) {
  return new Promise((ok, erro) => {
    const partes = []; let tam = 0;
    req.on('data', d => { tam += d.length; if (tam > limite) { erro(new Error('arquivo grande demais')); req.destroy(); } else partes.push(d); });
    req.on('end', () => ok(Buffer.concat(partes))); req.on('error', erro);
  });
}
const MIME_EXT = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', mp4: 'video/mp4', ogg: 'audio/ogg', oga: 'audio/ogg', mp3: 'audio/mpeg', m4a: 'audio/mp4', pdf: 'application/pdf' };
function servirArquivo(req, res, abs) {
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) { res.writeHead(404); return res.end(); }
  const tam = fs.statSync(abs).size, tipo = MIME_EXT[path.extname(abs).slice(1).toLowerCase()] || 'application/octet-stream';
  const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
  if (range) {
    const ini = range[1] ? Number(range[1]) : 0, fim = range[2] ? Math.min(Number(range[2]), tam - 1) : tam - 1;
    res.writeHead(206, { 'content-type': tipo, 'content-range': `bytes ${ini}-${fim}/${tam}`, 'accept-ranges': 'bytes', 'content-length': fim - ini + 1, 'cache-control': 'private, max-age=31536000' });
    return fs.createReadStream(abs, { start: ini, end: fim }).pipe(res);
  }
  res.writeHead(200, { 'content-type': tipo, 'content-length': tam, 'accept-ranges': 'bytes', 'cache-control': 'private, max-age=31536000' });
  fs.createReadStream(abs).pipe(res);
}
const PAGINA_LOGIN = (erro) => `<!doctype html><meta charset=utf8><meta name=viewport content="width=device-width,initial-scale=1"><title>WhatsApp Euro</title>
<style>body{font:16px system-ui,sans-serif;background:#eef4fb;color:#16213a;display:grid;place-items:center;min-height:100vh;margin:0;padding:16px;box-sizing:border-box}form{background:#fff;border:1px solid #d6deeb;border-radius:16px;padding:24px;display:grid;gap:12px;width:100%;max-width:340px}input{font:inherit;padding:12px;border:1px solid #c7d2e3;border-radius:10px}button{font:inherit;padding:12px;border:0;border-radius:10px;background:#1f8f5f;color:#fff;font-weight:600;cursor:pointer}p{margin:0;color:#b3261e;font-size:14px}</style>
<form method=post action=/login><h2 style="margin:0">WhatsApp Euro</h2><input name=senha type=password placeholder="Senha" autofocus autocomplete=current-password>${erro ? '<p>Senha errada.</p>' : ''}<button>Entrar</button></form>`;

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  try {
    // ---- catálogo (script do computador, com ?t=TOKEN) ----
    if (u.pathname === '/manifest' || u.pathname === '/arquivo') {
      if (!tokenOk(u)) { res.writeHead(403); return res.end('acesso negado'); }
      if (u.pathname === '/manifest') return json(res, listarCatalogo());
      if (req.method === 'PUT') {
        const rel = (u.searchParams.get('p') || '').replace(/\\/g, '/').replace(/^\/+/, '');
        const abs = path.resolve(CATALOGO, rel);
        if (!rel || !abs.startsWith(CATALOGO + path.sep)) { res.writeHead(400); return res.end('caminho inválido'); }
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        const tmp = abs + '.parcial';
        const w = fs.createWriteStream(tmp);
        req.pipe(w);
        w.on('finish', () => { fs.renameSync(tmp, abs); const mt = Number(u.searchParams.get('m') || 0); if (mt) fs.utimesSync(abs, mt, mt); res.writeHead(200); res.end('ok'); });
        w.on('error', e => { res.writeHead(500); res.end(e.message); });
        return;
      }
    }
    // ---- login ----
    if (u.pathname === '/login' && req.method === 'POST') {
      const senha = new URLSearchParams((await corpo(req, 1e4)).toString()).get('senha');
      if (senhaOk(senha)) { res.writeHead(303, { 'set-cookie': cookieSessao(req), location: '/' }); return res.end(); }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(PAGINA_LOGIN(true));
    }
    if (!logado(req, u)) {
      if (u.pathname === '/' || u.pathname === '/painel') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(PAGINA_LOGIN(false)); }
      return json(res, { erro: 'login' }, 401);
    }
    if (tokenOk(u) && !cookies(req).ep) res.setHeader('set-cookie', cookieSessao(req)); // link com ?t= vira login

    // ---- painel ----
    if (u.pathname === '/' || u.pathname === '/painel') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(fs.readFileSync(path.join(BASE, 'painel.html')));
    }
    if (u.pathname === '/sair') { res.writeHead(303, { 'set-cookie': 'ep=; Path=/; Max-Age=0', location: '/' }); return res.end(); }
    if (u.pathname === '/eventos') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
      res.write(`event: estado\ndata: ${JSON.stringify(estadoPublico())}\n\n`);
      clientesSSE.add(res);
      const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch (e) { } }, 25e3);
      req.on('close', () => { clearInterval(ping); clientesSSE.delete(res); });
      return;
    }
    if (u.pathname === '/api/estado') return json(res, estadoPublico());
    if (u.pathname === '/api/qr.svg') {
      if (!ultimoQR) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'no-store' });
      return res.end(await QRCode.toString(ultimoQR, { type: 'svg', margin: 2, width: 300 }));
    }
    if (u.pathname === '/api/chats') {
      const lista = Object.keys(chats).map(chatPublico).sort((a, b) => b.ult - a.ult).slice(0, 400);
      return json(res, lista);
    }
    if (u.pathname === '/api/msgs') {
      const jid = u.searchParams.get('jid') || '';
      return json(res, { chat: chatPublico(jid), msgs: lerEsp(jid).slice(-300) });
    }
    if (req.method === 'POST') {
      let b = null;
      if (u.pathname !== '/api/foto') {
        const txt = (await corpo(req, 1e6)).toString();
        if (/x-www-form-urlencoded/.test(String(req.headers['content-type'] || ''))) { b = Object.fromEntries(new URLSearchParams(txt)); if ('on' in b) b.on = b.on === 'sim' || b.on === 'true' || b.on === '1'; }
        else b = JSON.parse(txt || '{}');
        if (b && typeof b.on === 'string') b.on = b.on === 'sim' || b.on === 'true' || b.on === '1';   // "nao" em JSON também é desligar
      }
      if (u.pathname === '/api/ponte') {   // uma única porta para o CRM (via Make): ver, enviar, ligar/pausar, desconectar...
        const ac = String(b.acao || 'ver'); let jid = acharJid(b.jid);
        if (ac === 'aprimorar') {
          const rascunho = String(b.texto || '').trim(); if (!rascunho) return json(res, { erro: 'escreva a mensagem primeiro' }, 400);
          const conversa = jidValido(jid) ? lerEsp(jid).filter(m => m.texto).slice(-14).map(m => (m.autor === 'cliente' ? 'Cliente: ' : 'Euro: ') + m.texto.replace(/\s+/g, ' ').slice(0, 300)).join('\n') : '';
          const jeito = ['JEITO-DO-DJHONATA.md', 'REGRAS-ATENDIMENTO.md'].map(f => lerTexto(f)).filter(Boolean).join('\n\n').slice(0, 12000);
          const sis = `Você revisa a mensagem que o Djhonata, corretor da Euro Consultoria Imobiliária (Joinville/SC), vai mandar a um cliente pelo WhatsApp.
Reescreva o RASCUNHO dele deixando claro, organizado, cordial e profissional, no jeito dele de escrever (próximo, direto, sem formalidade excessiva).
REGRAS OBRIGATÓRIAS:
1. Mantenha TODAS as informações do rascunho exatamente como ele escreveu: mesmos documentos, valores, datas, nomes, imóveis e pedidos. Nunca troque um item por outro, mesmo que a conversa fale de outra coisa.
2. Não acrescente NADA que não esteja no rascunho: nenhuma data, dia da semana, prazo, documento, valor, condição, promessa ou assunto novo.
3. Só melhore a forma: ortografia, acentos, pontuação, ordem das frases, cordialidade e clareza.
4. A conversa abaixo serve APENAS para acertar o tom (formal/informal) e o nome do cliente. Nunca copie informação dela.
5. Português do Brasil, frases curtas, no máximo 1 emoji se combinar. Tamanho parecido com o do rascunho.
Responda SOMENTE com a mensagem final, sem aspas e sem comentários.${jeito ? '\n\nComo o Djhonata escreve e as regras do atendimento:\n' + jeito : ''}`;
          try { const sug = (await claudeTexto(sis, (conversa ? 'Conversa até agora (só para o tom, NÃO use informações daqui):\n' + conversa + '\n\n' : '') + 'RASCUNHO DO DJHONATA (reescreva só este, mantendo todas as informações dele e nada além):\n' + rascunho, 800)).trim(); return json(res, { sugestao: sug }); }
          catch (e) { return json(res, { erro: e.message }, 502); }
        }
        if (ac === 'enviar') {
          const texto = String(b.texto || '').trim();
          if (jid && !chats[jid] && jid.endsWith('@s.whatsapp.net') && sock && conectado) { try { const [r] = await sock.onWhatsApp(jid.split('@')[0]); if (r && r.exists && r.jid) jid = r.jid; } catch (e) { } }
          if (!jidValido(jid) || !texto) return json(res, { erro: 'conversa ou texto inválido' }, 400);
          const id = await enviarTexto(jid, texto, 'voce');
          if (!id) return json(res, { erro: 'WhatsApp desconectado' }, 409);
          anotar(jid, 'assistant', `(Djhonata escreveu) ${texto}`);
        } else if (ac === 'saldos') {   // aba Pagamentos do CRM
          await lerEleven(!!b.on);
          return json(res, { saldos: dadosSaldos(), baixos: saldosBaixos() });
        } else if (ac === 'saldos_salvar') {   // o CRM manda o saldo digitado (manual), o que ele leu no Make (auto) e os limites
          let p = {}; try { p = JSON.parse(b.texto || '{}'); } catch (e) { return json(res, { erro: 'dados inválidos' }, 400); }
          const s = estado.saldos || (estado.saldos = {});
          if (p.limites && typeof p.limites === 'object') p.limites = Object.fromEntries(Object.entries(p.limites).filter(([k, v]) => k in LIM_SALDO && v !== '' && v !== null && isFinite(+v)).map(([k, v]) => [k, +v]));
          for (const k of ['manual', 'auto', 'limites']) if (p[k] && typeof p[k] === 'object') s[k] = Object.assign({}, s[k] || {}, p[k]);
          if (p.manual && p.manual.claude) { s.claudeGasto = 0; delete (s.avisos || {}).claude; }   // saldo novo do Claude: o gasto volta a contar do zero
          if (p.manual) for (const k of Object.keys(p.manual)) delete (s.avisos || {})[k];       // recarregou: pode avisar de novo quando baixar
          salvarEstado(); log('saldos atualizados pelo CRM:', Object.keys(p).join(', '));
          return json(res, { ok: true, saldos: dadosSaldos(), baixos: saldosBaixos() });
        } else if (ac === 'esquecer') {   // a IA esquece o que conversou nesse contato (fica uma cópia no servidor)
          if (!jidValido(jid)) return json(res, { erro: 'conversa inválida' }, 400);
          const ok = esquecerConversa(jid); filas.delete(jid); quitarResposta(jid); log('memória da conversa apagada', jid, ok ? '' : '(estava vazia)');
          return json(res, { ok: true, apagou: ok });
        } else if (ac === 'funil') {   // leads por dia: conversas novas de clientes e quantas vieram do anúncio (para o funil do CRM)
          const de = Date.parse(String(b.texto || '').slice(0, 10)) || (Date.now() - 400 * 864e5);
          const dia = (t) => new Date(t).toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
          const dias = {}, tels = {};
          for (const j of Object.keys(chats)) {
            if (!jidValido(j) || j.endsWith('@g.us') || ehDono(pnDe(j) || j)) continue;
            const c = chats[j], cl = (estado.classes || {})[j], cat = cl ? cl.cat : '';
            if (/corretor|construtor|pessoal/.test(cat)) continue;
            let p = c.primeira;
            if (!p) { const l = lerEsp(j); const ini = l.find(m => m.autor === 'cliente'); p = ini ? ini.ts : 0; if (!c.anuncio && ini && RE_MSG_ANUNCIO.test(ini.texto || '')) c.anuncio = { em: ini.ts, titulo: '', pelaMensagem: true }; if (p) c.primeira = p; }
            if (!p || p < de) continue;
            const d = dia(p), v = dias[d] || (dias[d] = { leads: 0, anuncio: 0 });
            v.leads++; if (c.anuncio) v.anuncio++;
            const t8 = String(c.telefone || '').replace(/\D/g, '').slice(-8); if (t8) tels[t8] = { dia: d, anuncio: !!c.anuncio };
          }
          salvarChats();
          return json(res, { dias, tels });
        } else if (ac === 'voz_info') {
          return json(res, { cfg: vozCfg(), padrao: VOZ_PADRAO, vozNova: estado.vozNova || null, teste: estado.vozTeste || null, clonagem: estado.vozClonagem || null, testando: testandoVoz, voz });
        } else if (ac === 'voz_teste') {   // manda as versões no WhatsApp do Djhonata (em segundo plano); texto = frase do teste ou JSON {fala, versoes}
          if (!ELEVEN_KEY) return json(res, { erro: 'sem chave da ElevenLabs' }, 409);
          if (!sock || !conectado) return json(res, { erro: 'WhatsApp desconectado' }, 409);
          if (testandoVoz) return json(res, { erro: 'já tem um teste de voz rodando' }, 409);
          const tx = String(b.texto || '').trim(); let p = { fala: tx };
          if (tx.startsWith('{')) { try { p = JSON.parse(tx); } catch (e) { return json(res, { erro: 'dados inválidos' }, 400); } }
          const versoes = Array.isArray(p.versoes) && p.versoes.length ? p.versoes.slice(0, 6) : versoesVoz();
          testarVoz(p.fala || FALA_TESTE, versoes).catch(e => log('teste de voz:', e.message));
          return json(res, { ok: true, versoes: versoes.map(v => v.nome + (v.desc ? ' ' + v.desc : '')) });
        } else if (ac === 'voz_clonar') {   // cria a voz nova com os áudios do Djhonata; com on=sim, manda o teste no WhatsApp quando terminar
          if (!ELEVEN_KEY) return json(res, { erro: 'sem chave da ElevenLabs' }, 409);
          const vc = estado.vozClonagem;
          if (vc && vc.status === 'rodando' && Date.now() - vc.em < 5 * 60e3) return json(res, { erro: 'já está criando a voz' }, 409);
          if (estado.vozNova && estado.vozNova.id && String(b.texto || '') !== 'de novo') return json(res, { erro: 'a voz nova já existe (mande texto "de novo" para criar outra)', vozNova: estado.vozNova }, 409);
          estado.vozClonagem = { status: 'rodando', em: Date.now() }; salvarEstado();
          const testarDepois = !!b.on;
          clonarVoz().then(v => { estado.vozClonagem = { status: 'ok', em: Date.now(), voz: v }; salvarEstado(); if (testarDepois && sock && conectado) return testarVoz(FALA_TESTE, versoesVoz()); })
            .catch(e => { estado.vozClonagem = { status: 'erro', em: Date.now(), erro: String(e.message).slice(0, 300) }; salvarEstado(); log('voz nova:', e.message); });
          return json(res, { ok: true, criando: true });
        } else if (ac === 'voz_config') {   // salva o jeito da voz (texto = JSON com voz, modelo, stability, similarity, style, speed, boost, tag) ou 'padrao'
          const tx = String(b.texto || '').trim();
          if (tx === 'padrao') delete estado.vozCfg;
          else {
            let p; try { p = JSON.parse(tx); } catch (e) { return json(res, { erro: 'dados inválidos' }, 400); }
            const campos = ['voz', 'modelo', 'stability', 'similarity', 'style', 'speed', 'boost', 'tag'];
            estado.vozCfg = Object.assign({}, estado.vozCfg || {}, Object.fromEntries(Object.entries(p || {}).filter(([k]) => campos.includes(k))));
          }
          salvarEstado(); log('jeito da voz:', JSON.stringify(vozCfg()));
          return json(res, { ok: true, cfg: vozCfg() });
        } else if (ac === 'responder_agora') {   // a assistente responde agora o que o cliente mandou e ficou sem resposta
          if (!sock || !conectado) return json(res, { erro: 'WhatsApp desconectado' }, 409);
          const r = reenfileirar(jid, 'pedido do CRM', String(b.texto || '').trim());
          if (r.erro) return json(res, { erro: r.erro }, 409);
          b._resultado = r;
        } else if (ac === 'conversas') {   // exporta as conversas de clientes em texto compacto, para análise (texto = {desde, limite, msgs})
          let o = {}; try { o = JSON.parse(b.texto || '{}'); } catch (e) { }
          const desde = Number(o.desde) || Date.parse(o.desde || '') || Date.now() - 3 * 864e5, lim = Math.min(120, Number(o.limite) || 60), nMsgs = Math.min(80, Number(o.msgs) || 40);
          const bloq = lerBloqueados(), hm = (t) => new Date(t - 3 * 3600e3).toISOString().slice(5, 16).replace('T', ' ');
          const lista = Object.keys(chats).filter(j => jidValido(j) && (chats[j].ultCliente || 0) >= desde).map(j => ({ j, p: chatPublico(j) }))
            .filter(x => x.p.telefone && !bloq.has(normal(x.p.telefone)) && normal(x.p.telefone) !== normal(DONO)).sort((a, b) => (b.p.ult || 0) - (a.p.ult || 0)).slice(0, lim);
          const partes = [];
          for (const x of lista) {
            const t8 = String(x.p.telefone).replace(/\D/g, '').slice(-8), c = chats[x.j] || {};
            const ms = lerEsp(x.j).slice(-nMsgs);
            partes.push('===== ' + (x.p.nome || 'sem nome') + ' | ' + x.p.telefone + ' | CRM: ' + ((estado.crmStatus || {})[t8] || 'sem card') + (c.anuncio ? ' | anúncio: ' + (c.anuncio.titulo || 'sim') + (c.anuncio.anuncioId ? ' [' + c.anuncio.anuncioId + ((adsMapa[c.anuncio.anuncioId] || {}).pasta ? ' = ' + adsMapa[c.anuncio.anuncioId].pasta : (adsMapa[c.anuncio.anuncioId] || {}).generico ? ' = genérico' : '') + ']' : '') : '') + (x.p.iaOff ? ' | IA desligada neste chat' : '') + '\n'
              + ms.map(m => hm(m.ts) + ' [' + m.autor + (m.rotina ? ':' + m.rotina : '') + (m.followup ? ':followup' : '') + (m.tipo && m.tipo !== 'text' ? ':' + m.tipo : '') + '] ' + String(m.texto || '').replace(/\s*\n+\s*/g, ' / ').slice(0, m.tipo === 'audio' ? 2500 : 420)).join('\n'));   // áudio vai inteiro (13/11/2026): cortado em 420, o fim do áudio longo ficava fora da avaliação
            await new Promise(r => setTimeout(r, 2));
          }
          return json(res, { ok: true, conversas: lista.length, texto: partes.join('\n\n') });
        } else if (ac === 'sinais') {   // sinais de cada conversa dos últimos N dias (texto = dias), para a pontuação "Quentes" do CRM
          const dias = Math.min(120, Math.max(1, Number(b.texto) || 45)), desde = Date.now() - dias * 864e5, tels = {};
          let k = 0;
          for (const j of Object.keys(chats)) {
            if (!jidValido(j) || j.endsWith('@g.us') || ehDono(pnDe(j) || j)) continue;
            const c = chats[j]; if ((c.ultCliente || 0) < desde) continue;
            const t8 = String(c.telefone || '').replace(/\D/g, '').slice(-8); if (!t8) continue;
            let s = null; try { s = sinaisDe(j); } catch (e) { }
            if (s && s.n && (!tels[t8] || (s.uc || 0) > (tels[t8].uc || 0))) tels[t8] = s;
            if (++k % 40 === 0) await new Promise(r => setTimeout(r, 2));
          }
          return json(res, { ok: true, em: Date.now(), dias, tels });
        } else if (ac === 'retomar') {   // retomada pedida pelo Djhonata: jid = conversa ou telefone; texto = o que a assistente deve fazer nessa retomada
          if (!sock || !conectado) return json(res, { erro: 'WhatsApp desconectado' }, 409);
          if (!estado.ativo || (estado.teste && estado.teste.ativo)) return json(res, { erro: 'a assistente está pausada ou em teste' }, 409);
          const alvo = jidValido(jid) && chats[jid] ? jid : jidPorTel8(String(b.jid || '').replace(/\D/g, '').slice(-8));
          const instr = String(b.texto || '').trim().slice(0, 1500);
          if (!alvo || !chats[alvo]) return json(res, { erro: 'conversa não encontrada' }, 404);
          if (!instr) return json(res, { erro: 'diga o que retomar' }, 400);
          if (filas.has(alvo) || ocupado.has(alvo)) return json(res, { erro: 'a assistente já está respondendo essa conversa' }, 409);
          if (!rotinaPermitida(alvo, 'ordem')) return json(res, { erro: 'essa conversa está travada para a assistente (bloqueado, fechado, corretor ou pausado)' }, 409);
          rodarRotina({ jid: alvo, tipo: 'ordem', instr }).catch(e => log('retomar', e.message));
          return json(res, { ok: true, jid: alvo, nome: chats[alvo].nome || '', telefone: chats[alvo].telefone || '' });
        } else if (ac === 'crm_faltantes') {   // cria o card de quem a assistente atendeu nos últimos N dias e não está no CRM (texto = dias)
          const dias = Math.min(30, Math.max(1, Number(b.texto) || 2)), desde = Date.now() - dias * 864e5, feitos = [];
          for (const j of Object.keys(chats)) {
            if (!jidValido(j)) continue; const c = chats[j]; if ((c.ultCliente || 0) < desde) continue;
            if (!lerEsp(j).some(m => m.autor === 'ia' && m.ts >= desde)) continue;   // só quem a assistente atendeu
            try { if (cardAutomatico(j)) feitos.push((c.nome || '') + ' ' + (c.telefone || '')); } catch (e) { }
            await new Promise(r => setTimeout(r, 5));
          }
          return json(res, { ok: true, criados: feitos.length, quem: feitos });
        } else if (ac === 'responder_pausados') {   // texto = desde quando (ms ou data ISO)
          if (!sock || !conectado) return json(res, { erro: 'WhatsApp desconectado' }, 409);
          if (!estado.ativo || (estado.teste && estado.teste.ativo)) return json(res, { erro: 'a assistente está pausada ou em teste' }, 409);
          const tx = String(b.texto || '').trim(), d = /^\d+$/.test(tx) ? Number(tx) : Date.parse(tx);
          if (!d) return json(res, { erro: 'diga desde quando' }, 400);
          return json(res, Object.assign({ ok: true }, responderPausados(d, 'pedido do Djhonata')));
        } else if (ac === 'ia_conversa') {
          if (!jidValido(jid)) return json(res, { erro: 'conversa inválida' }, 400);
          if (b.on) delete estado.pausas[jid]; else { estado.pausas[jid] = Date.now() + 3650 * 864e5; filas.delete(jid); }
          salvarEstado(); emitir('chat', chatPublico(jid));
        } else if (ac === 'assistente') {
          const rp = ligarOuPausar(b.on, 'CRM'); if (rp) b._resultado = rp;
        } else if (ac === 'desconectar') { await desconectarWhatsApp(); }
        else if (ac === 'conectar') { await conectarWhatsApp(); await new Promise(r => setTimeout(r, 2500)); }
        else if (ac === 'lido') { if (chats[jid]) { chats[jid].naoLidas = 0; salvarChats(); } }
        else if (ac === 'arquivar') {
          let alvos = []; try { alvos = JSON.parse(b.texto || '[]'); } catch (e) { }
          if (!Array.isArray(alvos)) alvos = []; if (jidValido(jid)) alvos.push(jid);
          const ok = [], falhas = [];
          for (const j of alvos.filter(jidValido)) { try { await arquivarChat(j, b.on); ok.push(j); } catch (e) { falhas.push(j + ': ' + e.message); } await new Promise(r => setTimeout(r, 350)); }
          log(b.on ? 'arquivadas' : 'desarquivadas', ok.length, 'conversas', falhas.length ? 'falhas ' + falhas.length : '');
          const o = { feitos: ok.length, falhas };
          if (!alvos.length) o.falhas.push('nenhuma conversa');
          b._resultado = o;
        }
        else if (ac === 'classificar') {
          let p = {}; try { p = JSON.parse(b.texto || '{}'); } catch (e) { }
          classificarTudo(p.compradores || [], !!p.refazer, p).catch(e => log('classificar', e.message));
          await new Promise(r => setTimeout(r, 500));
        }
        else if (ac === 'atualizar') {
          let ref = 'main';
          try { const c = await (await fetch('https://api.github.com/repos/djhonatavargas/euro-ponte/commits/main', { headers: { 'user-agent': 'euro-ponte' } })).json(); if (c && c.sha) ref = c.sha; } catch (e) { }
          const REPO = 'https://raw.githubusercontent.com/djhonatavargas/euro-ponte/' + ref + '/';
          const novos = {};
          for (const f of ['index.js', 'painel.html']) { const r = await fetch(REPO + f + '?' + Date.now()); if (!r.ok) return json(res, { erro: 'GitHub ' + r.status + ' em ' + f }, 502); novos[f] = await r.text(); }
          try { new Function(novos['index.js'].replace(/^#!.*\n/, '')); } catch (e) { if (!/import|await/.test(e.message)) return json(res, { erro: 'index.js novo com erro: ' + e.message }, 400); }
          for (const f in novos) fs.writeFileSync(path.join(BASE, f), novos[f]);
          log('atualizado pelo CRM; reiniciando');
          json(res, { ok: true, reiniciando: true });
          return setTimeout(() => process.exit(0), 800);
        }
        else if (ac === 'followup_gerar') {   // o CRM manda os clientes em Perdido (lote); a IA prepara a mensagem de cada um
          let p = {}; try { p = JSON.parse(b.texto || '{}'); } catch (e) { }
          let novos = 0, ignorados = 0;
          for (const c of (Array.isArray(p.clientes) ? p.clientes : []).slice(0, 200)) {
            const num = fuNumero(c.telefone), t8 = num.slice(-8);
            if (num.length < 12 || t8.length !== 8 || ehDono(num)) { ignorados++; continue; }
            const v = fu[t8];
            if (v && (['enviado', 'respondeu', 'aprovado', 'gerando'].includes(v.status) || (!p.refazer && v.status !== 'erro'))) { ignorados++; continue; }   // já tem (ou já foi): não refaz
            fu[t8] = { tel8: t8, tel: num, id: String(c.id || ''), nome: String(c.nome || '').slice(0, 80), status: 'fila', criadoEm: Date.now(), tent: 0,
              crm: { nome: String(c.nome || '').slice(0, 80), nomeProvisorio: !!c.nomeProvisorio, bairro: String(c.bairro || '').slice(0, 80), imovel: String(c.imovel || '').slice(0, 160), proximo: String(c.proximo || '').slice(0, 300), resumo: String(c.resumo || '').slice(0, 1500), historico: String(c.historico || '').slice(0, 1800), obs: String(c.obs || '').slice(-900) } };
            novos++;
          }
          salvarFu(); setTimeout(fuTrabalhar, 200);
          return json(res, Object.assign({ ok: true, novos, ignorados }, fuResumo()));
        }
        else if (ac === 'followup_lista') {   // {tel} = um cliente; {status:[...], limite, pular} = lista; {mapa:true} = status de todos (para o CRM marcar os cards)
          let p = {}; try { p = JSON.parse(b.texto || '{}'); } catch (e) { }
          const prev = fuPrevisoes(), out = fuResumo();
          if (p.tel) { const x = fu[fuT8(p.tel)]; out.item = x ? fuPublico(x, prev) : null; }
          if (p.mapa) { out.mapa = {}; for (const v of Object.values(fu)) out.mapa[v.tel8] = v.status; }
          if (Array.isArray(p.status) && p.status.length) {
            const ord = { aprovado: (a, z) => (prev[a.tel8] || 0) - (prev[z.tel8] || 0), enviado: (a, z) => (z.enviadoEm || 0) - (a.enviadoEm || 0), respondeu: (a, z) => (z.respondeuEm || 0) - (a.respondeuEm || 0) };
            const sel = Object.values(fu).filter(v => p.status.includes(v.status)).sort(ord[p.status[0]] || ((a, z) => (z.prioridade || 0) - (a.prioridade || 0) || (z.geradoEm || 0) - (a.geradoEm || 0)));
            const pular = Math.max(0, Number(p.pular) || 0), lim = Math.min(100, Math.max(1, Number(p.limite) || 40));
            out.total = sel.length; out.itens = sel.slice(pular, pular + lim).map(x => fuPublico(x, prev));
          }
          return json(res, out);
        }
        else if (ac === 'followup_salvar') {   // {tel8 | tels:[...], acao: aprovar|cancelar|desaprovar, mensagem}
          let p = {}; try { p = JSON.parse(b.texto || '{}'); } catch (e) { }
          const tels = [...new Set((Array.isArray(p.tels) ? p.tels : [p.tel8]).map(fuT8))].filter(t => fu[t]);
          let n = 0;
          for (const t of tels) {
            const x = fu[t];
            if (typeof p.mensagem === 'string' && tels.length === 1 && ['pronto', 'aprovado', 'cancelado', 'erro'].includes(x.status) && p.mensagem.trim()) x.mensagem = p.mensagem.trim().slice(0, 1200);
            if (p.acao === 'aprovar' && ['pronto', 'cancelado', 'erro'].includes(x.status) && x.mensagem) { Object.assign(x, { status: 'aprovado', aprovadoEm: Date.now(), erro: '' }); n++; }
            else if (p.acao === 'cancelar' && ['fila', 'pronto', 'aprovado', 'erro'].includes(x.status)) { Object.assign(x, { status: 'cancelado', erro: 'cancelado por você' }); n++; }
            else if (p.acao === 'desaprovar' && x.status === 'aprovado') { x.status = 'pronto'; n++; }
            else if (!p.acao) n++;
          }
          salvarFu();
          const prev = fuPrevisoes();
          return json(res, Object.assign({ ok: true, alterados: n, itens: tels.map(t => fuPublico(fu[t], prev)) }, fuResumo()));
        }
        else if (ac === 'eventos') {
          let linhas = []; try { linhas = fs.readFileSync(path.join(DADOS, 'eventos-crm.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean); } catch (e) { }
          const ok = new Set(estado.eventosOk || []);
          const pend = linhas.filter(e => e.rid && !ok.has(e.rid)).slice(-100);
          const ult = {}; for (const jid of Object.keys(chats)) { const c = chats[jid]; const t = (c.telefone || '').replace(/\D/g, '').slice(-8); const u = ultCli(jid); if (t.length === 8 && u) ult[t] = Math.max(ult[t] || 0, u); }
          return json(res, { eventos: pend, ultimaMsgCliente: ult });
        }
        else if (ac === 'eventos_ok') {
          let ids = []; try { ids = JSON.parse(b.texto || '[]'); } catch (e) { }
          estado.eventosOk = [...new Set([...(estado.eventosOk || []), ...ids])].slice(-2000); salvarEstado();
          return json(res, { ok: true });
        }
        else if (ac === 'etiqueta') {
          if (!sock || !conectado) return json(res, { erro: 'WhatsApp desconectado' }, 409);
          const id = String(b.texto || ''); if (!jidValido(jid) || !etq.labels[id]) return json(res, { erro: 'etiqueta ou conversa inválida' }, 400);
          if (b.on) await sock.addChatLabel(jid, id); else await sock.removeChatLabel(jid, id);
          const l = new Set(etq.chats[jid] || []); if (b.on) l.add(id); else l.delete(id); etq.chats[jid] = [...l]; salvarEtq();
        }
        else if (ac === 'resolver') {
          let l = []; try { l = JSON.parse(b.texto || '[]'); } catch (e) { }
          try { b._resultado = await resolverTelefones(l); } catch (e) { return json(res, { erro: e.message }, 409); }
        }
        else if (ac === 'etiquetar') {
          let p = {}; try { p = JSON.parse(b.texto || '{}'); } catch (e) { }
          (async () => { if (p.status) await classificarTudo(p.compradores || [], true, p); await etiquetarTudo(); })().catch(e => log('etiquetar', e.message));
          await dorme(1500);
        }
        else if (ac === 'anuncios') {   // CRM: de qual imóvel é cada anúncio. Devolve o que está gravado, os anúncios que já trouxeram cliente e os imóveis do catálogo
          const v = adsVistos();
          const imoveis = pastasImoveis().filter(p => lerTexto(path.join(p, 'ficha.md'))).map(p => ({ pasta: p, nome: dadosDaFicha(p).nome, ref: geoRef(p) }));
          return json(res, { ok: true, mapa: adsMapa, vistos: v.lista, semCodigo: v.semCodigo, imoveis });
        }
        else if (ac === 'anuncios_salvar') {   // texto = JSON { código do anúncio: { nome, pasta, generico } }. Sem pasta e sem generico = tira a ligação daquele anúncio
          let m = null; try { m = JSON.parse(b.texto || ''); } catch (e) { }
          if (!m || typeof m !== 'object' || Array.isArray(m)) return json(res, { erro: 'lista inválida' }, 400);
          const validas = new Set(pastasImoveis()); let n = 0; const recusados = [];
          for (const [id, v] of Object.entries(m)) {
            if (!/^[\w-]{1,40}$/.test(id) || !v || typeof v !== 'object') { recusados.push(id); continue; }
            if (v.pasta && !validas.has(String(v.pasta))) { recusados.push(id); continue; }   // imóvel que não existe no catálogo: não grava
            if (!v.pasta && !v.generico) { if (adsMapa[id]) { delete adsMapa[id]; n++; } continue; }
            adsMapa[id] = { nome: String(v.nome || '').slice(0, 120), pasta: v.pasta ? String(v.pasta) : '', generico: !v.pasta && !!v.generico, em: Date.now() }; n++;
          }
          gravarJson(ADS_ARQ, adsMapa); log('anúncios ligados a imóveis:', Object.keys(adsMapa).length, recusados.length ? '(recusados: ' + recusados.length + ')' : '');
          return json(res, { ok: true, mapa: adsMapa, mudou: n, recusados });
        }
        else if (ac === 'geo') {   // CRM: o que o mapa achou perto de cada imóvel, para o Djhonata revisar e aprovar. texto = "atualizar" adianta a busca
          if (b.texto === 'atualizar') geoRotina(30).catch(e => log('geo', e.message));
          const lista = pastasImoveis().filter(p => lerTexto(path.join(p, 'ficha.md'))).map(p => { const g = geo.imoveis[p] || {}, d = dadosDaFicha(p); return { pasta: p, nome: d.nome, ref: geoRef(p), bairro: g.bairro || '', localizado: !!(g.lat && !g.aprox), aprox: !!g.aprox, auto: geoItensTexto(g.entorno), texto: g.revisado || '', aprovado: !!g.aprovado, em: g.entornoEm || 0 }; });
          return json(res, { ok: true, imoveis: lista, rodando: geoRodando, erro: geoErro, pertoMin: GEO_PERTO_MIN, tabela: geoTabelaTexto() });
        }
        else if (ac === 'geo_salvar') {   // jid = pasta do imóvel (ou "todos"); on = aprovado ou não; texto = texto revisado pelo Djhonata (vazio = usar o do mapa)
          const alvo = String(b.jid || '');
          if (alvo === 'todos') { let n = 0; for (const p of Object.keys(geo.imoveis)) { const g = geo.imoveis[p]; if (g && !g.aprovado && ((g.entorno || []).length || g.revisado)) { g.aprovado = true; g.aprovadoEm = Date.now(); n++; } } geoSalvar(); log('geografia: aprovados de uma vez', n); return json(res, { ok: true, aprovados: n }); }
          if (!pastasImoveis().includes(alvo)) return json(res, { erro: 'imóvel não encontrado' }, 404);
          const g = geo.imoveis[alvo] = geo.imoveis[alvo] || {};
          if (typeof b.texto === 'string' && b.texto !== 'manter') g.revisado = b.texto.replace(/\s+/g, ' ').trim().slice(0, 600);
          g.aprovado = !!b.on && !!(g.revisado || (g.entorno || []).length); g.aprovadoEm = g.aprovado ? Date.now() : 0; geoSalvar();
          return json(res, { ok: true, pasta: alvo, aprovado: g.aprovado, texto: g.revisado || '', auto: geoItensTexto(g.entorno) });
        }
        else if (ac === 'regras_ler') {
          const arq = ARQS_REGRAS.includes(b.jid) ? b.jid : 'REGRAS-ATENDIMENTO.md';
          let em = 0; try { em = fs.statSync(path.join(CATALOGO, arq)).mtimeMs; } catch (e) { }
          return json(res, { arquivo: arq, texto: lerTexto(arq), em, arquivos: ARQS_REGRAS.map(f => ({ arquivo: f, ok: !!lerTexto(f) })) });
        }
        else if (ac === 'regras_trocar') {   // troca trechos exatos de um arquivo de regras: texto = JSON { assunto, pares: [[antigo, novo], ...] }; cada trecho precisa aparecer 1 vez. Só grava com on = sim (sem isso, só diz o que trocaria). Guarda cópia antes.
          const arq = ARQS_REGRAS.includes(b.jid) ? b.jid : 'REGRAS-ATENDIMENTO.md', abs = path.join(CATALOGO, arq);
          let pares = null, assunto = 'ajuste'; try { const j = JSON.parse(String(b.texto || '')); pares = Array.isArray(j) ? j : j.pares; if (j && j.assunto) assunto = String(j.assunto); } catch (e) { }
          if (!Array.isArray(pares) || !pares.length || !pares.every(x => Array.isArray(x) && x.length === 2 && typeof x[0] === 'string' && typeof x[1] === 'string' && x[0].length >= 12)) return json(res, { erro: 'mande texto = JSON { assunto, pares: [[antigo, novo], ...] }' }, 400);
          const cru = lerTexto(arq), antes = cru.replace(/\r/g, ''); if (antes.trim().length < 200) return json(res, { erro: 'arquivo vazio ou não encontrado: ' + arq }, 400);
          let txt = antes; const feitas = [], faltou = [];
          pares.forEach(([a, n], i) => { const q = txt.split(a).length - 1; if (q === 1) { txt = txt.replace(a, () => n); feitas.push(i); } else faltou.push({ i, vezes: q, ja: txt.includes(n) }); });
          let copia = '';
          if (feitas.length && b.on === true) {
            copia = arq.replace(/\.md$/, '') + '-backup-' + (assunto.replace(/[^a-z0-9-]/gi, '').slice(0, 30) || 'ajuste') + '-' + agoraSP().toISOString().slice(0, 10) + '.md';
            fs.writeFileSync(path.join(CATALOGO, copia), cru); try { fs.copyFileSync(abs, abs + '.anterior'); } catch (e) { }
            fs.writeFileSync(abs, txt);
            log('regras: trechos trocados em', arq, feitas.length, 'de', pares.length, '| cópia:', copia);
          }
          return json(res, { arquivo: arq, gravou: !!copia, feitas, faltou, copia, antes: antes.length, depois: txt.length });
        }
        else if (ac === 'regras_salvar') {
          const arq = ARQS_REGRAS.includes(b.jid) ? b.jid : 'REGRAS-ATENDIMENTO.md';
          const txt = String(b.texto || '');
          if (txt.trim().length < 200) return json(res, { erro: 'texto curto demais: não salvei' }, 400);
          const abs = path.join(CATALOGO, arq);
          fs.mkdirSync(CATALOGO, { recursive: true });
          try { if (fs.existsSync(abs)) fs.copyFileSync(abs, abs + '.anterior'); } catch (e) { }
          fs.writeFileSync(abs, txt);
          log('regras salvas pelo CRM:', arq, txt.length, 'caracteres');
          return json(res, { ok: true, arquivo: arq, em: Date.now() });
        }
        else if (ac === 'teste') {
          const limparTeste = (nums) => { const t8 = new Set((nums || []).map(n => String(n).replace(/\D/g, '').slice(-8))); let n = 0; for (const j of Object.keys(chats)) if (t8.has(tel8De(j))) { if (esquecerConversa(j)) n++; filas.delete(j); quitarResposta(j); } if (n) log('memória do teste apagada em', n, 'conversa(s)'); };
          limparTeste((estado.teste || {}).numeros);   // o que a IA conversou no teste (ou antes dele) não passa para a próxima fase
          if (b.on) {
            let nums = []; try { nums = (JSON.parse(b.texto || '{}').numeros) || []; } catch (e) { }
            if (!nums.length) nums = [DONO];
            estado.teste = { ativo: true, numeros: nums.map(n => String(n).replace(/\D/g, '')) }; salvarEstado();
            try { await resolverTelefones(estado.teste.numeros); } catch (e) { }
            log('MODO TESTE ligado para', estado.teste.numeros.join(', '));
            limparTeste(estado.teste.numeros);
          } else {
            estado.teste = { ativo: false, numeros: [] }; salvarEstado(); log('modo teste desligado');
            setTimeout(() => retomarPendentes('fim do teste').then(n => { if (n) log('clientes que escreveram durante o teste:', n); }).catch(e => log('pendentes', e.message)), 1500);
          }
          emitir('estado', estadoPublico());
        }
        else if (ac === 'crm_status') { let m = {}; try { m = JSON.parse(b.texto || '{}'); } catch (e) { } atualizarStatusCrm(m).catch(e => log('crm_status', e.message)); return json(res, { ok: true }); }
        else if (ac === 'crm_nomes') { let m = {}; try { m = JSON.parse(b.texto || '{}'); } catch (e) { } const nv = {}; for (const [k, v] of Object.entries(m || {})) { const t8 = String(k).replace(/\D/g, '').slice(-8); if (t8.length === 8 && v) nv[t8] = String(v).slice(0, 60); } if (Object.keys(nv).length) { estado.crmNomes = nv; salvarEstado(); } return json(res, { ok: true, nomes: Object.keys(nv).length }); }
        else if (ac === 'crm_visitas') { let m = {}; try { m = JSON.parse(b.texto || '{}'); } catch (e) { } atualizarVisitasCrm(m); return json(res, { ok: true, visitas: Object.keys(estado.visitas || {}).length }); }
        else if (ac === 'rotinas') {   // o que o sistema sabe das visitas e das rotinas (para conferir)
          return json(res, { rotinas, visitas: Object.entries(estado.visitas || {}).map(([j, v]) => ({ nome: chatPublico(j).nome, telefone: chatPublico(j).telefone, quando: descreverQuando(v.q), origem: v.origem, enviados: v.enviados })), retomadas: Object.keys(estado.retomadas || {}).length, voz, ouvido, ffmpeg: temFfmpeg(), iaVazia: lerJson(path.join(DADOS, 'ia-vazia.json'), null) });
        }
        else if (ac === 'sincronizar') {
          if (!sock || !conectado) return json(res, { erro: 'WhatsApp desconectado' }, 409);
          for (const ini of [false, true]) { try { await sock.resyncAppState(['critical_block', 'critical_unblock_low', 'regular_high', 'regular_low', 'regular'], ini); } catch (e) { log('sincronizar', ini, e.message); } }
          log('sincronizar: etiquetas', Object.keys(etq.labels).length, 'contatos', Object.keys(contatos).length);
          await new Promise(r => setTimeout(r, 1500));
        }
        else if (ac === 'diag') {
          const lids = Object.keys(chats).filter(j => j.endsWith('@lid'));
          let bl = ''; try { bl = fs.readFileSync(path.join(DADOS, 'baileys.log'), 'utf8').split('\n').slice(-25).map(l => { try { const o = JSON.parse(l); return (o.msg || '') + ' ' + JSON.stringify(o.err ? o.err.message : (o.error || '')).slice(0, 200); } catch (e) { return l.slice(0, 200); } }).join('\n'); } catch (e) { }
          return json(res, { baileys: bl, etiquetas: etq.labels, etiquetando, temAddLabel: !!(sock && typeof sock.addLabel === 'function'), chats: Object.keys(chats).length, lids: lids.length, lidsComTelefone: lids.filter(j => lidPn[j] || chats[j].telefone).length, mapa: Object.keys(lidPn).length, contatos: Object.keys(contatos).length, temLidMapping: !!(sock && sock.signalRepository && sock.signalRepository.lidMapping) });
        }
        else if (ac === 'avisos') {   // dúvidas de clientes que a assistente anotou para o Djhonata responder (não foram para o celular dele)
          return json(res, { ok: true, avisos: (estado.avisos || []).filter(a => a.tipo === 'duvida' && !a.feito).slice(-40).reverse() });
        }
        else if (ac === 'aviso_feito') {   // texto = id do aviso: sai da lista
          const a = (estado.avisos || []).find(x => x.id && x.id === String(b.texto || '')); if (!a) return json(res, { erro: 'aviso não encontrado' }, 404);
          a.feito = Date.now(); salvarEstado(); return json(res, { ok: true });
        }
        else if (ac === 'ficha') {   // ficha de atendimento de um cliente (jid = conversa ou telefone). Monta se não existe, refaz se a conversa andou; on = sim refaz agora
          const j = fichaAlvo(b.jid); if (!j) return json(res, { erro: 'conversa não encontrada' }, 404);
          const fx = lerFichaAt(j), l = lerEsp(j), ult = l.length ? l[l.length - 1].ts || 0 : 0, velha = !!fx && ult > (fx.ateTs || 0);
          if ((b.on === true || !fx || velha) && l.length) fichaPedir(j, b.on === true ? 'pedido no CRM' : fx ? 'conversa nova' : 'primeira vez');
          return json(res, { ok: true, jid: j, ficha: fx, gerando: fichaNaFila(j), desatualizada: velha, erro: fichaAt.erros[j] ? fichaAt.erros[j].msg : '' });
        }
        else if (ac === 'ficha_foto') {   // foto 1 do imóvel (texto = pasta ou ref), em base64, para a ficha de atendimento
          const pasta = acharPasta(String(b.texto || '')); if (!pasta) return json(res, { erro: 'imóvel não encontrado' }, 404);
          const f1 = midiaDaOferta(pasta).foto1; let buf = null;
          try {
            if (/^https?:/i.test(f1)) { const r = await fetch(f1, { signal: AbortSignal.timeout(20000) }); if (r.ok) buf = Buffer.from(await r.arrayBuffer()); }
            else if (f1) { const abs = path.resolve(CATALOGO, f1); if (abs.startsWith(CATALOGO + path.sep) && fs.existsSync(abs)) buf = fs.readFileSync(abs); }
          } catch (e) { log('ficha: foto', pasta, e.message); }
          if (buf && buf.length > 3e6) buf = null;
          return json(res, { ok: true, pasta, tipo: /\.png(\?|$)/i.test(f1) ? 'image/png' : /\.webp(\?|$)/i.test(f1) ? 'image/webp' : 'image/jpeg', b64: buf ? buf.toString('base64') : '' });
        }
        else if (ac === 'fichas') {   // quais clientes já têm ficha de atendimento
          const lista = []; try { for (const f of fs.readdirSync(FICHAS_DIR)) if (f.endsWith('.json')) { const x = lerJson(path.join(FICHAS_DIR, f), null); if (x && x.jid) lista.push({ jid: x.jid, nome: x.nome, telefone: x.telefone, geradaEm: x.geradaEm, imovel: x.imovel ? x.imovel.nome : '' }); } } catch (e) { }
          return json(res, { ok: true, fichas: lista, fila: fichaAt.fila.length, gerando: Object.keys(fichaAt.gerando).length });
        }
        else if (ac === 'ultimas') {   // {final do telefone: hora da última mensagem, de qualquer lado}; o CRM mostra "última interação" em cada card
          const m = {};
          for (const j of Object.keys(chats)) { if (!jidValido(j) || j.endsWith('@g.us')) continue; const c = chats[j], t = tel8Chat(j); if (t && c.ult) m[t] = Math.max(m[t] || 0, c.ult); }
          return json(res, { ultimas: m });
        }
        else if (ac === 'retornos') {   // retornos combinados com clientes ("amanhã cedo eu te chamo"), para conferência
          return json(res, { retornos: Object.entries(estado.retornos || {}).map(([jid, r]) => ({ jid, telefone: (chats[jid] || {}).telefone || '', nome: (chats[jid] || {}).nome || '', quando: r.q, assunto: r.assunto || '', criado: r.criado || 0 })) });
        }
        else if (ac === 'log') {
          let t = ''; try { t = fs.readFileSync(path.join(DADOS, 'ponte.log'), 'utf8'); } catch (e) { }
          return json(res, { log: t.split('\n').slice(-60).join('\n') });
        }
        const verArq = ac === 'ver' && b.texto === 'arquivados';
        const todos = Object.keys(chats).map(chatPublico);
        const out = { estado: estadoPublico(), classif, etiquetando, etiquetas: Object.entries(etq.labels).filter(([, l]) => !l.apagada).map(([id, l]) => ({ id, nome: l.nome, cor: l.cor })), totais: { ativos: todos.filter(c => !c.arquivado).length, arquivados: todos.filter(c => c.arquivado).length },
          chats: todos.filter(c => verArq ? c.arquivado : !c.arquivado).sort((a, b) => b.ult - a.ult).slice(0, 400) };
        if (b._resultado) out.resultado = b._resultado;
        if (jidValido(jid)) { out.chat = chatPublico(jid); out.msgs = lerEsp(jid).slice(-60).map(m => ({ id: m.id, autor: m.autor, tipo: m.tipo, texto: m.texto, ts: m.ts, rotina: m.rotina || undefined, transc: m.transc || undefined, voz: m.voz || undefined, ordem: m.ordem || undefined, followup: m.followup || undefined })); }
        if (ultimoQR && !conectado) { try { out.qr = await QRCode.toString(ultimoQR, { type: 'svg', margin: 1, width: 240 }); } catch (e) { } }
        return json(res, out);
      }
      if (u.pathname === '/api/enviar') {
        const jid = b.jid, texto = String(b.texto || '').trim();
        if (!jidValido(jid) || !texto) return json(res, { erro: 'conversa ou texto inválido' }, 400);
        const id = await enviarTexto(jid, texto, 'voce');
        if (!id) return json(res, { erro: 'WhatsApp desconectado' }, 409);
        anotar(jid, 'assistant', `(Djhonata escreveu) ${texto}`);
        if (PAUSA_HORAS > 0) { estado.pausas[jid] = Date.now() + PAUSA_HORAS * 3600e3; salvarEstado(); filas.delete(jid); emitir('chat', chatPublico(jid)); }
        return json(res, { ok: true, id });
      }
      if (u.pathname === '/api/foto') {
        const jid = u.searchParams.get('jid') || '', legenda = u.searchParams.get('legenda') || '';
        const mime = String(req.headers['content-type'] || 'image/jpeg').split(';')[0];
        if (!jidValido(jid) || !/^image\//.test(mime)) return json(res, { erro: 'foto inválida' }, 400);
        await enviarFotoPainel(jid, await corpo(req, 16e6), mime, legenda);
        return json(res, { ok: true });
      }
      if (u.pathname === '/api/ia-conversa') {
        const jid = b.jid; if (!jidValido(jid)) return json(res, { erro: 'conversa inválida' }, 400);
        if (b.on) delete estado.pausas[jid]; else { estado.pausas[jid] = Date.now() + 3650 * 864e5; filas.delete(jid); }
        salvarEstado(); log('assistente', b.on ? 'ligada' : 'desligada', 'na conversa', jid);
        emitir('chat', chatPublico(jid)); return json(res, chatPublico(jid));
      }
      if (u.pathname === '/api/lido') {
        const jid = b.jid; if (chats[jid]) { chats[jid].naoLidas = 0; salvarChats(); emitir('chat', chatPublico(jid)); }
        return json(res, { ok: true });
      }
      if (u.pathname === '/api/assistente') {
        ligarOuPausar(b.on, 'painel'); return json(res, estadoPublico());
      }
      if (u.pathname === '/api/desconectar') { await desconectarWhatsApp(); return json(res, estadoPublico()); }
      if (u.pathname === '/api/conectar') { await conectarWhatsApp(); return json(res, estadoPublico()); }
    }
    // ---- mídias ----
    if (u.pathname.startsWith('/m/')) { const n = path.basename(decodeURIComponent(u.pathname.slice(3))); return servirArquivo(req, res, path.join(MIDIA, n)); }
    if (u.pathname.startsWith('/c/')) {
      const rel = decodeURIComponent(u.pathname.slice(3)); const abs = path.resolve(CATALOGO, rel);
      if (!abs.startsWith(CATALOGO + path.sep)) { res.writeHead(400); return res.end(); }
      return servirArquivo(req, res, abs);
    }
    res.writeHead(404); res.end('não encontrado');
  } catch (e) { log('erro http', u.pathname, e.message); try { json(res, { erro: e.message }, 500); } catch (x) { } }
}).listen(PORTA, () => log('painel na porta', PORTA));

if (!API_KEY) log('ATENÇÃO: falta ANTHROPIC_API_KEY no .env');
try { unirDuplicadas(); } catch (e) { log('unir conversas', e.message); }
iniciarWhatsApp().catch(e => log('erro ao iniciar WhatsApp', e.message));
