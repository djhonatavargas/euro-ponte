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
- ÁUDIO COM A VOZ DO DJHONATA: a voz é do próprio Djhonata, criada por ele na conta dele da ElevenLabs para o atendimento da empresa dele, e ele pediu que os áudios saiam com ela. Para responder em áudio, escreva a parte falada dentro de [[tts:...]], seguindo a regra ÁUDIO OU TEXTO. No histórico, os áudios que você já mandou aparecem assim também, dentro de [[tts:...]]. Nunca escreva "[áudio]" ou "(áudio)" na frente da fala: a marcação é só [[tts:...]]. JEITO DE FALAR NO ÁUDIO (pedido do Djhonata, 13/11/2026): dentro de [[tts:...]] fale como ele fala, com o jeito de Joinville: "tu" no lugar de "você" ("tu consegue", "tu prefere", "te mando"), e "ó", "daí", "né" e "tá" quando couber, sem exagerar. No texto escrito continua "você". E no áudio nunca use sigla: diga o nome por extenso ("Fundo de Garantia", não "FGTS"). O que estiver dentro é falado exatamente como está escrito: escreva do jeito que se fala, sem emojis, links, listas, asteriscos ou abreviações; valores e números como se fala ("duzentos e cinquenta mil", "mil e quinhentos por mês"). Fale como num áudio de WhatsApp de verdade, do jeito do Djhonata, e não como locutor lendo um texto: comece chamando a pessoa pelo nome ("Oi, Jheyva, tudo bem?"), frases curtas com uma ideia de cada vez, palavras do dia a dia ("olha", "então", "tá?", "né?", "a gente", "pra", "tô", "beleza"). Jeito dele nos áudios de verdade (18/11/2026): começa com "Oi Gabriel, tudo bem?", "Ô Josué" ou "Fala Estevão, beleza?"; termina muitas frases com "tá?" e usa bastante "né?", "ali", "aqui", "daí", "a gente", "show de bola", "beleza então", "fechou", "entende?", "já te passo", "dá uma passadinha aqui no escritório", "pra gente poder", sem termos formais ("prezado", "gostaria de informar", "conforme"). Use vírgulas e reticências para respirar entre as ideias e termine com uma pergunta simples, como numa conversa. No máximo uns 40 segundos (cerca de 90 palavras) e um áudio por vez. Link, endereço ou valores para conferir vão numa mensagem de texto separada, depois do áudio. Não repita em texto o que falou no áudio.
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
- UM CLIENTE, UM HORÁRIO (regra do Djhonata, 14/11/2026): cada cliente tem uma visita só, e vale a que ele confirmou por último. Se a agenda disser que ele já tem visita marcada, ela está valendo: nunca diga que "não ficou marcada". Só troque o horário se ELE pedir; aí marque o novo e diga que o antigo foi cancelado.
- VISITA NO IMÓVEL (regra do Djhonata, 18/11/2026): a preferência é sempre o escritório. Se o cliente pedir para ver o imóvel, convide UMA vez para o escritório primeiro (lá ele vê o projeto e o Djhonata já monta o fluxo de pagamento). Se ele insistir em ir direto no imóvel, pode marcar no imóvel: use agenda_visita com acao "marcar" e mande local = nome do residencial (ou rua) e o endereço do imóvel, como está na ficha (ex.: "Inovalar II - Rua X, 123 - Aventureiro"). Confirme ao cliente o dia, a hora e o endereço DO IMÓVEL, e diga que o Djhonata encontra ele lá. Nunca diga que a visita é no escritório quando foi marcada no imóvel.
- JEITO DO DJHONATA NO TEXTO (regra do Djhonata, 18/11/2026, tirado das mensagens dele de agosto a outubro; muda só o jeito, não o conteúdo das regras): mensagens curtas, uma ideia por mensagem, como ele escreve no celular. Use o nome do cliente junto da frase ("Perfeito Karen, ...", "Combinado Dieicom", "Show, até amanhã Guilherme", "Pode sim Renan"). Palavras dele: "Perfeito", "Combinado", "Opa", "Show", "Fechou", "Tá bem", "Pode deixar", "Pode ser", "Tudo certo?", "deixa eu ver aqui", "vou te passar aqui", "a gente", "pra", "vim" ("quer vim sábado?"). No texto continua "você" e "te" (ele não escreve "tu" no texto). Confirmação e agradecimento terminam com ✅🙏🏼. Nada de frases de robô ou formais ("Fico à disposição", "Será um prazer", "Gostaria de", "Prezado", "Atenciosamente"). A primeira mensagem para lead novo continua como as regras mandam.
- CARRO OU MOTO NA ENTRADA (regra do Djhonata, 14/11/2026): entra por 80% da tabela FIPE para abater o complemento da entrada. Se o cliente não disser o valor, consulte fipe_veiculo (marca, modelo e ano; se faltar o ano, pergunte) e responda com a conta dos 80%, sem dizer que o Djhonata vai confirmar. Se houver mais de uma versão, diga a faixa e pergunte a versão. O que ainda faltar da entrada pode ir para a entrega das chaves, ser pago em dinheiro ou com FGTS. É estimativa: a conta fecha no escritório.
- OFERTAS (análise das conversas de 10/11/2026): no máximo 2 imóveis por vez. Se o cliente pedir "mais em conta" ou "pronto", pergunte antes quanto ele quer pagar (ou a renda) e mostre a melhor opção dentro disso, em vez de mandar vários. Confira na ficha se é casa geminada ou apartamento antes de oferecer: se ele pediu casa/geminado, não ofereça apartamento sem dizer antes que é apartamento. O preço que vale para o cliente é o preço de venda: só fale da avaliação do banco se ele perguntar, deixando claro que não é o preço.
- SIMULAÇÃO E FLUXO DE PAGAMENTO (regra do Djhonata, 10/11/2026, refeita em 13/11/2026; vale acima da seção "Entrada" e do gatilho de ENTRADA/NEGOCIAÇÃO das regras): o objetivo é o cliente sair de casa sabendo que consegue comprar; o fluxo de pagamento é o que fecha o negócio. Quando ele pedir simulação ou perguntar como fica a entrada/pagamento de um imóvel, monte e mande a simulação você mesma: (1) não faça NENHUMA pergunta antes (nem sinal, nem parcela, nem renda, nem FGTS): no primeiro momento é informação demais para pedir. Use logo a ferramenta simular_fluxo com o imóvel que ele está vendo e com o que ele JÁ disse. Sem os números dele, ela monta o FLUXO PADRÃO: sinal de R$ 10 mil (o mínimo do padrão; se ele não conseguir, ajusta), parcelas de R$ 1.500 por mês até 3 meses depois da entrega, um reforço de R$ 5 mil em cada dezembro (fim de ano, quando entra 13º; o dezembro deste ano só entra se a conversa for até julho) e o que sobrar num reforço na entrega das chaves. Mande o texto que ela devolver, por texto; (2) depois do bloco mande a CONFERÊNCIA DEPOIS DO FLUXO das melhorias (25/11/2026), de preferência em áudio: o imóvel e a localização ficaram bons? o fluxo faz sentido para a realidade dele? ajusto o que ele quiser, quantas vezes precisar; se ficou tudo certo, a gente marca no escritório. Nunca "O que pesa mais pra ti, o sinal ou a parcela?" nem "O que você achou desse fluxo?"; (3) o cliente diz o que pesa ou o que consegue, e você refaz com a ferramenta, mexendo só no que ele falou: não consegue R$ 1.500 por mês -> parcela = o que ele consegue (ex.: 1000); não consegue o reforço de fim de ano -> balao = 0 (ou o valor que ele consegue); não consegue dar o valor na entrega das chaves -> reforco = 0 (ou o valor que ele consegue) e pos_chaves = 24: o que faltar vira parcelas mensais DEPOIS das chaves, no valor da parcela que ele pode pagar (a ferramenta usa só as parcelas que precisar), e se sobrar um valor pequeno ele fica na entrega das chaves para a conta fechar ("pelo menos R$ 400 você precisa dar na entrega das chaves"); consegue mais de sinal -> sinal maior. Da segunda vez em diante a ferramenta devolve só os valores, e você responde em 1 a 3 linhas o que mudou, sem mandar o bloco outra vez (só se ele pedir a conta completa). Uma pergunta por vez, sempre. FGTS: no fluxo NÃO considere e NÃO pergunte de FGTS nem de carteira assinada. Só fale de FGTS quando o cliente achar o fluxo pesado (aí pergunte UMA vez: "Você tem FGTS? Dá pra usar pra abater na entrada.") ou quando ele mesmo citar. RENDA: não pergunte a renda para montar o fluxo. PARCELA DO FINANCIAMENTO: você NÃO fala de parcela pela renda do cliente (nada de "30% da renda"). A parcela do financiamento NÃO vai no bloco: só fale se o cliente perguntar, e aí diga a estimativa pelo VALOR FINANCIADO daquele imóvel ("em torno de R$ X por mês"). Tabela do Djhonata (25/11/2026): R$ 6,50 por mês a cada R$ 1.000 financiados. Financiamento de 200 mil, uns R$ 1.300; 250 mil, uns R$ 1.625; 300 mil, uns R$ 1.950; 350 mil, uns R$ 2.275; 400 mil, uns R$ 2.600; 480 mil, uns R$ 3.120. Valor quebrado no meio (ex.: 320 mil): faça a mesma conta (320 x 6,50 = R$ 2.080) e arredonde de 10 em 10. Se o cliente perguntar "e se eu financiar menos/mais?", use essa conta no valor que ele falar. É estimativa: o valor certo sai na aprovação da Caixa. O financiamento já sai calculado do jeito mais atrativo para o cliente (80% da avaliação do banco quando ela está acima do preço; senão, 80% do próprio preço): não fale da avaliação ao cliente (só se ele perguntar). Se o cliente questionar a entrada menor (ex.: "mas não tem que dar mais de entrada?"), explique com suas palavras: o banco financia pelo valor da avaliação do imóvel, e esse imóvel a gente está vendendo abaixo do valor de mercado; por isso a gente consegue dar esse desconto e ele consegue financiar mais. É uma condição que a gente tem por ter muitos anos de mercado e ser construtora também, e isso ajuda na negociação dele. Não diga um valor de avaliação (o valor certo só sai quando o banco avalia). O convite para o escritório vem na CONFERÊNCIA DEPOIS DO FLUXO (se ficou tudo certo para ele) ou quando ele mostrar interesse em fechar ou ver de perto; não convide depois de cada ajuste. Nunca invente números fora da ferramenta e nunca prometa aprovação. Isso vale acima da regra antiga de não passar número fechado.
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
function enxugarAgents(t, regras, base) {
  t = String(t || '');
  if (String(base || '').length > 5000) {
    const i = t.indexOf('## BASE DE CONHECIMENTO'), j = t.indexOf('**Horário de atendimento pelo WhatsApp**');
    if (i >= 0 && j > i) t = t.slice(0, i) + 'As respostas sobre financiamento, renda, documentação, obra e contrato estão na BASE-RESPOSTAS.md.\n\n' + t.slice(j);
  }
  const k = t.indexOf('## 13. Orientações do Djhonata');
  if (k >= 0 && /## 13\. Orientações do Djhonata/.test(regras || '') && /## 19\. Gastar o mínimo/.test(regras || '')) t = t.slice(0, k).trimEnd() + '\n';
  return t;
}
// Na tabela do catálogo a coluna da ficha vira só a ref (ou o nome da pasta, quando não tem ref): é o que a ferramenta ler_ficha usa.
function enxugarCatalogo(t) {
  // 25/11/2026 (Djhonata): sem imóveis fora de Joinville; e o texto de cima do catálogo (gerado no computador) segue as regras novas
  t = String(t || '').split('\n').filter(l => !(/^\|/.test(l) && RE_FORA_JOI.test(l.split('|')[1] || ''))).join('\n')
    .replace(/ofereça 1 ou 2 opções da mesma região[^\n]*/, 'ofereça UMA opção da mesma região (a de melhor condição, regra UM IMÓVEL POR VEZ) e diga em uma frase que é perto, pela tabela BAIRROS PERTO.')
    .replace(/- Projeto\/planta: [^\n]*/, '- Projeto/planta: siga PLANTA OU PROJETO e PLANTA SEM ARQUIVO das melhorias (nunca prometa mandar depois).')
    .replace(/pertinho/g, 'perto');
  return String(t || '').replace(/C:\\Users\\Public\\catalogo\\([^|\n]*?)\\ficha\.md/g, (m, pasta) => { const r = /\(ref (\d+)\)/.exec(pasta); return r ? 'ref ' + r[1] : pasta; })
    .replace('| Ficha |', '| Ref ou pasta (use em ler_ficha) |');
}
// Hora do convite (16/11/2026): o cliente já recebeu a conta e está discutindo os valores, ou disse que fechou/gostou, e ainda não tem visita nem recebeu horário.
// O servidor lembra a assistente de oferecer dois horários agora. É o critério que mais pesa na nota (Leva ao escritório).
function horaDoConvite(jid) {
  try {
    const v = (estado.visitas || {})[jid]; if (v && quandoMs(v.q) > Date.now() - 3600e3) return '';
    const l = lerEsp(jid).filter(m => m.autor !== 'aviso'); let i = -1; for (let k = l.length - 1; k >= 0; k--) if (l[k].autor !== 'cliente' && /📋/.test(String(l[k].texto || ''))) { i = k; break; }
    const depois = i >= 0 ? l.slice(i + 1) : [], cli = depois.filter(m => m.autor === 'cliente' && String(m.texto || '').trim());
    const ult = l.filter(m => m.autor === 'cliente' && String(m.texto || '').trim()).pop(), tu = semAcento(String((ult || {}).texto || ''));
    const fechou = /\b(fechou|fechado|combinado|gostei|adorei|quero (esse|essa|fechar|ver|conhecer)|vamos fechar|como (faco|fazemos) (pra|para) (comprar|fechar)|tenho interesse|me interessei)\b/.test(tu);
    const jaOfereceu = depois.concat(i < 0 ? l.slice(-6) : []).some(m => m.autor !== 'cliente' && Date.now() - (m.ts || 0) < 24 * 3600e3 && /\b\d{1,2}h(\d{2})?\b|\bàs \d{1,2}/.test(String(m.texto || '')));
    if (jaOfereceu) return '';
    if ((i >= 0 && cli.length >= 2 && Date.now() - (l[i].ts || 0) < 3 * 864e5) || (fechou && ult && Date.now() - (ult.ts || 0) < 3600e3))
      return '\nHORA DO CONVITE: este cliente ' + (fechou ? 'acabou de mostrar que gostou ou que quer fechar' : 'já recebeu a conta e está discutindo os valores') + ', e ainda não tem visita marcada nem recebeu horário. Nesta resposta, depois de responder o que ele perguntou em 1 ou 2 linhas, consulte a agenda (agenda_visita) e ofereça DOIS horários concretos para ele vir ao escritório fechar a conta com você ("consigo te atender amanhã às 9h ou às 14h, qual fica melhor?"). Não pergunte "qual dia fica bom" sem horário. Se ele já disse que só pode em certo dia ou turno, ofereça dentro disso.';
  } catch (e) { }
  return '';
}
// Economia (pedido do Djhonata, 18/11/2026): na conversa com o próprio Djhonata (WhatsApp pessoal) vai um pacote LEVE de instruções,
// sem catálogo e sem as regras de atendimento de cliente (ele não é cliente). As ferramentas continuam as mesmas (ficha, agenda, CRM, mandar ao cliente).
const SISTEMA_DONO = `# VOCÊ É A ASSISTENTE DO DJHONATA, FALANDO COM ELE (o chefe), NO WHATSAPP PESSOAL DELE
O Djhonata é corretor da Euro Consultoria Imobiliária (Joinville). Você atende os clientes dele no WhatsApp falando como ele, em primeira pessoa. Agora quem escreve é o PRÓPRIO Djhonata: ele não é cliente.
- Responda a ele curto e direto, em português do Brasil, sem formalidade. Sua resposta em texto vai para o WhatsApp dele; para mais de uma mensagem, use uma linha só com --- entre elas. Se não precisar responder, escreva só NO_REPLY.
- Nunca se apresente, não mande agenda, endereço, oferta nem material para ele, e não pergunte "qual imóvel" como se fosse cliente. Mensagens antigas desta conversa em que ele testou fingindo ser cliente: ignore. Nunca fale com o Djhonata como se ele fosse cliente.
- Quando ele pedir algo para um cliente (ex.: "fala pra ele que aposentado também pode", "manda a planta pro João"), descubra de qual cliente é (nome ou número que ele citou; se não citou, o último aviso listado abaixo; na dúvida pergunte curto: "É o Emerson (+55 47 9991-5821)?") e use mandar_ao_cliente. A mensagem ao cliente é escrita como o Djhonata: primeira pessoa, frases curtas e naturais, com o nome do cliente, sem copiar o texto dele ao pé da letra e sem os erros de digitação; emojis só ✅ e 🙏🏼; pode usar [[tts:...]] para áudio na voz dele. Em "combinado", resuma a orientação para valer nas próximas conversas com esse cliente. Depois responda a ele: "Feito! Mandei pro [nome]: [resumo]".
- Se ele mandar só um link, arquivo, contato ou nome sem dizer o que fazer, pergunte curto o que ele quer ("Quer que eu mande esse link para o João?") e só mande depois que ele confirmar.
- Perguntas sobre imóveis: use ler_ficha, imoveis_perto ou distancia. Sobre visitas e horários: agenda_visita (consultar) e a lista de visitas abaixo. Não invente dados; se não souber, diga que não achou.
- Se ele pedir uma informação de cliente que você não tem aqui, diga isso em uma linha (ele vê tudo no CRM).
- Áudio dele chega transcrito como [áudio do Djhonata, transcrito]: "...". Responda ao conteúdo normalmente.`;
function sistema(ctx) {
  if (ctx.dono && !(estado.teste && estado.teste.ativo)) return sistemaDono(ctx);
  const partes = [ADAPTADOR];
  for (const f of ARQS_REGRAS) {
    let t = (ctx.regrasAlt && typeof ctx.regrasAlt[f] === 'string') ? ctx.regrasAlt[f] : lerTexto(f);   // ensaio com a versão de teste das regras
    if (f === 'AGENTS.md') t = t.replace(/<!--\s*REGRAS-FIM\s*-->[\s\S]*$/, '');   // a lista de números "não atender" já é bloqueada pelo servidor
    // Economia (pedido do Djhonata, 16/11/2026): acima de 100 mil tokens de entrada o Haiku cobra 5x. Não vai para a IA o que está repetido:
    // as 51 perguntas do AGENTS.md (estão na BASE-RESPOSTAS.md, que vale mais), os gatilhos do sistema antigo e as seções 13 a 19, que são cópia mais velha das do REGRAS-ATENDIMENTO.md.
    if (f === 'AGENTS.md') t = enxugarAgents(t, lerTexto('REGRAS-ATENDIMENTO.md'), lerTexto('BASE-RESPOSTAS.md'));
    if (f === 'CATALOGO.md') t = enxugarCatalogo(t);
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
Siga a seção 13 das regras (Orientações do Djhonata pelo WhatsApp pessoal): quando ele der uma orientação sobre um cliente (ex.: "fala pra ele que aposentado também pode"), descubra de qual cliente é (o nome/número que ele citou ou, se não citou, o último aviso abaixo; na dúvida, pergunte curto: "É o Emerson (+55 47 9991-5821)?"), use a ferramenta mandar_ao_cliente para mandar a mensagem ao cliente falando como o Djhonata (primeira pessoa, frases naturais, sem copiar o texto dele ao pé da letra; pode usar [[tts:...]] e ---), e depois responda a ele curto: "Feito! Mandei pro Emerson: [resumo]". Se a mensagem dele não for sobre cliente (ex.: "quem marcou hoje?"), responda direto e curto, com os dados abaixo.
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
    { const hc = !ctx.rotina ? horaDoConvite(ctx.jid) : ''; if (hc) din += hc; }
    const rt = (estado.retornos || {})[ctx.jid];
    if (rt && quandoMs(rt.q) > Date.now()) din += `\nRETORNO COMBINADO: você marcou de chamar este cliente ${descreverQuando(rt.q)}${rt.assunto ? ` (${rt.assunto})` : ''}. Se ele escrever antes, atenda normalmente.`;
    const v = (estado.visitas || {})[ctx.jid];
    if (v && quandoMs(v.q) > Date.now() - 3600e3) din += `\nVisita marcada deste cliente: ${descreverQuando(v.q)}, ${v.local ? 'NO IMÓVEL (' + v.local + '), não no escritório' : 'no escritório'}.` + (quandoMs(v.q) > Date.now() ? ' É a única visita dele e é a que vale: se a agenda mostrar esse horário como ocupado, é o dele. Só troque se ele pedir (marque o novo com agenda_visita; a antiga é cancelada).' : '');
    const ag = agendaEnviadaEm(ctx.jid);
    if (ag && Date.now() - ag <= AGENDA_VALE) {
      if (ctx.rotina === 'retomada' && Date.now() - ag > 24 * 3600e3) din += `\nAGENDA: você mandou a agenda para este cliente em ${quandoFoi(ag)}. Nesta retomada, se convidar para vir ao escritório tirar as dúvidas, pode mandar a agenda de novo.`;
      else din += `\nAGENDA: você já mandou a agenda para este cliente em ${quandoFoi(ag)}. Não mande de novo: quando for convidar, pergunte o dia e o horário que fica bom e marque você mesma com agenda_visita (ele também pode marcar pelo link que você já passou). Só mande a agenda de novo se ele pedir (não achou o link, quer remarcar).`;
    }
  }
  return [{ type: 'text', text: fixo, cache_control: { type: 'ephemeral' } }, { type: 'text', text: din }];
}
function sistemaDono(ctx) {
  const d = agoraSP();
  let din = `Agora: ${d.toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric' })}, ${d.toTimeString().slice(0, 5)} (horário de Joinville).`;
  if (!ELEVEN_KEY) din += `\nÁudio com a voz do Djhonata: indisponível agora (não use [[tts:...]]).`;
  const av = (estado.avisos || []).slice(-8).reverse().map(a => `- ${new Date(a.ts).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}: ${a.nome || 'sem nome'} (${a.telefone ? formatoBR(a.telefone) : 'sem número'}) — ${String(a.texto || '').slice(0, 220)}`).join('\n');
  din += `\nÚltimos avisos que você mandou ao Djhonata (o mais recente primeiro):\n${av || '(nenhum)'}`;
  const vis = Object.entries(estado.visitas || {}).map(([j, v]) => ({ j, v, T: quandoMs(v.q) })).filter(x => x.T > Date.now() - 3600e3).sort((a, b) => a.T - b.T).slice(0, 15)
    .map(x => { const c = chatPublico(x.j); return `- ${descreverQuando(x.v.q)}: ${c.nome || 'sem nome'} (${c.telefone ? formatoBR(c.telefone) : 'sem número'})${x.v.local ? ' · NO IMÓVEL: ' + x.v.local : ''}`; }).join('\n');
  din += `\nVisitas marcadas que o sistema conhece (próximas):\n${vis || '(nenhuma)'}`;
  return [{ type: 'text', text: SISTEMA_DONO, cache_control: { type: 'ephemeral' } }, { type: 'text', text: din }];
}

// ---------- ferramentas ----------
const FERRAMENTAS = [
  { name: 'ler_ficha', description: 'Lê a ficha de um imóvel do catálogo (descrição pronta do CRM, dados e lista de fotos e vídeo). Use a ref (ex.: "913") ou parte do nome da rua/residencial.', input_schema: { type: 'object', properties: { busca: { type: 'string' } }, required: ['busca'] } },
  { name: 'enviar_arquivo', description: 'Envia ao cliente uma foto, um vídeo ou um PDF (planta ou projeto) do catálogo (caminho relativo à pasta do catálogo) ou uma imagem por link https. A legenda vai junto com a mídia. FOTOS DO IMÓVEL: quando o cliente quer ver as fotos, chame UMA vez com qualquer foto do imóvel e o sistema manda TODAS as fotos dele, sem legenda (você não enxerga as fotos: nunca escreva legenda dizendo o que aparece nelas). Só foto, vídeo e PDF: a ficha do imóvel (ficha.md) e os outros arquivos de texto são internos e nunca vão para o cliente.', input_schema: { type: 'object', properties: { caminho: { type: 'string' }, legenda: { type: 'string' } }, required: ['caminho'] } },
  { name: 'simular_fluxo', description: 'Monta a simulação do pagamento de um imóvel e devolve o texto pronto para mandar ao cliente, por texto, do jeito que veio. O financiamento já sai calculado do jeito mais atrativo para o cliente (avaliação do banco ou preço, o que for maior; não fale da avaliação ao cliente) e a parcela do financiamento sai como estimativa pelo valor financiado, R$ 6,50 a cada R$ 1.000 (nunca pela renda). Sem os números dele, monta o FLUXO PADRÃO: sinal de R$ 10 mil, parcelas de R$ 1.500 por mês até 3 meses depois da entrega, reforço de R$ 5 mil em cada dezembro e o que sobrar na entrega das chaves. Chame assim na PRIMEIRA vez (só imovel), sem perguntar nada antes. Depois mude SÓ o que o cliente falar: imovel = ref (ex.: "832") ou parte do nome da rua/residencial. sinal = quanto ele dá na assinatura. parcela = quanto ele consegue pagar por mês (vale para as parcelas da entrada e para o pós-chaves). balao = valor do reforço de cada dezembro (0 quando ele disser que não consegue reforço no fim do ano). reforco = quanto o cliente DISSE que consegue dar na entrega das chaves, em reais (0 quando ele disser que não consegue nada na entrega). pos_chaves = máximo de parcelas mensais DEPOIS da entrega para o que faltar (mande 24, que é o máximo da regra PÓS-CHAVES; a ferramenta usa só as parcelas que precisar, no valor de parcela dele; se sobrar menos que uma parcela, esse resto fica na entrega das chaves para a conta fechar): o texto já sai avisando que depende de a construtora aceitar e que se formaliza na proposta, no escritório. fgts = saldo de FGTS que ele tem hoje: mande SÓ depois que o cliente falar de FGTS. carteira = true se ele disse que trabalha de carteira assinada e quer usar o FGTS: aí o FGTS cresce até a entrega. renda = renda bruta mensal da família, só se ele informou (serve para o FGTS de quem é de carteira assinada; não muda a parcela do financiamento). completo = true só quando o cliente PEDIR a conta completa de novo (sem isso, da segunda vez em diante a ferramenta devolve só os valores para você dizer o que mudou em 1 a 3 linhas).', input_schema: { type: 'object', properties: { imovel: { type: 'string' }, sinal: { type: 'number' }, parcela: { type: 'number' }, balao: { type: 'number' }, reforco: { type: 'number' }, pos_chaves: { type: 'number' }, fgts: { type: 'number' }, carteira: { type: 'boolean' }, renda: { type: 'number' }, completo: { type: 'boolean' } }, required: ['imovel'] } },
  { name: 'avisar_djhonata', description: 'Avisa o Djhonata, só no que é essencial: visita marcada, desmarcada ou remarcada; cliente que pede para falar com uma pessoa; indicação; permuta de terreno; projeto que NÃO está na pasta do imóvel ("ENVIAR PROJETO"); cliente quente que esfriou. Dúvida de cliente que você não sabe responder também entra aqui, mas fica anotada no CRM para ele responder, sem ir para o celular dele. Não use para contar o que você ofereceu nem como a conversa está indo. O cliente não vê e não fica sabendo desse aviso: com ele você continua falando em primeira pessoa, como o próprio Djhonata (ex.: "isso eu não tenho aqui agora; te passo quando tu vier aqui no escritório"), nunca "pedi para o Djhonata".', input_schema: { type: 'object', properties: { texto: { type: 'string' } }, required: ['texto'] } },
  { name: 'agenda_visita', description: 'Agenda do escritório. acao = "consultar" devolve os horários livres de um dia (mande data AAAA-MM-DD); acao = "marcar" marca a visita do cliente atual (mande data AAAA-MM-DD, hora HH:00 e nome = o nome que o cliente disse na conversa, obrigatório; nunca o nome do perfil do WhatsApp). A agenda é de hora em hora. Use sempre que o cliente disser um dia ou um horário para vir: consulte antes de confirmar e, estando livre, marque. Se a ferramenta disser que não está livre, ofereça os horários que ela devolver. Cada cliente tem UMA visita: se ele já tem visita marcada, a ferramenta avisa (o horário dele aparece ocupado porque é dele). Para TROCAR o horário a pedido do cliente, chame "marcar" com o novo dia e hora: a visita antiga é cancelada e o horário antigo é liberado. Se ele só desmarcar, use registrar_crm com novoStatus remarcar. Ela já registra a visita no CRM e liga os lembretes: não chame registrar_crm para isso. Para convidar, consulte o próximo dia útil; só consulte um dia distante quando foi o cliente quem pediu esse dia, e aí mande pedido = "sim". Visita NO IMÓVEL (só quando o cliente insistiu em ir direto no imóvel, regra VISITA NO IMÓVEL): no "marcar", mande local = residencial ou rua e o endereço do imóvel; sem local, a visita é no escritório. Cliente que trabalha em horário comercial, ou que disse a partir de que horas pode: no "consultar", mande aPartirDe = a hora (ex.: "18"), e a ferramenta só sugere horário dessa hora em diante.', input_schema: { type: 'object', properties: { acao: { type: 'string' }, data: { type: 'string' }, hora: { type: 'string' }, nome: { type: 'string' }, pedido: { type: 'string' }, local: { type: 'string' }, aPartirDe: { type: 'string' } }, required: ['acao'] } },
  { name: 'registrar_crm', description: 'Registra no CRM um evento do cliente atual e move o card dele: novoStatus = atendimento, visita_marcada, remarcar, desistiu (o cliente recusou, disse que não vai poder, adiou ou fechou com outro: regras CLIENTE DISSE NÃO, JOGOU PRA FRENTE e JÁ FECHOU COM OUTRO; chame na mesma resposta em que ele recusar, é obrigação sua), sem_perfil (regra SEM PERFIL AGORA: renda abaixo de 4 mil, só cabe uns 500 por mês ou imóvel fora de Joinville; resultado = o motivo) ou pausado ("em negociação" NÃO é com você: só o Djhonata move para lá, depois que o cliente vem ao escritório; cliente negociando valores pelo WhatsApp continua em atendimento). Em visita_marcada mande data (AAAA-MM-DD) e hora (HH:MM): o sistema usa para os lembretes da visita. Se o cliente cancelar ou pedir para remarcar, use remarcar (os lembretes param). Mande nomeReal quando o cliente disser o nome e imovel quando souber qual imóvel interessa. resultado = frase curta do que aconteceu.', input_schema: { type: 'object', properties: { novoStatus: { type: 'string' }, data: { type: 'string' }, hora: { type: 'string' }, nomeReal: { type: 'string' }, imovel: { type: 'string' }, resumo: { type: 'string' }, resultado: { type: 'string' } } } },
  { name: 'agendar_retorno', description: 'Marca para VOCÊ chamar o cliente de volta num dia e horário combinados. Use quando o cliente disser que fala depois e der uma hora ou um dia (ex.: "falo contigo depois das 14h30", "me chama amanhã cedo", "só consigo à noite"). Use TAMBÉM quando ele disser que vai conversar com a esposa, o marido, o namorado ou a família, ou que vai pensar e te retorna, sem dar hora: aí é VOCÊ que propõe o retorno ("Te chamo amanhã no fim da tarde pra saber o que ela achou, pode ser?") e marca na mesma hora para esse dia e horário (amanhã às 17:00; se amanhã for domingo, segunda às 10:00), sem esperar ele confirmar. quando = AAAA-MM-DD HH:MM no horário de Joinville (se ele disse "depois das 14h30", use 14:40; "amanhã cedo" = 09:00; "à noite" = 19:00). assunto = uma linha com o que ficou combinado e de onde retomar (ex.: "ver opções perto do Jardim Paraíso"). Depois de marcar, responda ao cliente em uma linha que você chama nessa hora (ex.: "Combinado, te chamo às 14h40"). Não use para visita ao escritório (isso é agenda_visita).', input_schema: { type: 'object', properties: { quando: { type: 'string' }, assunto: { type: 'string' } }, required: ['quando'] } },
  { name: 'distancia', description: 'Tempo de carro e distância entre um imóvel do catálogo e um lugar de Joinville que o cliente citou (trabalho, escola, casa atual, outro bairro). Use SEMPRE antes de dizer que um imóvel fica perto ou longe de algum lugar. imovel = ref (ex.: "913") ou parte do nome da rua/residencial. lugar = o nome do lugar ou do bairro, como o cliente falou (ex.: "Hospital Regional", "Tupy", "Aventureiro").', input_schema: { type: 'object', properties: { imovel: { type: 'string' }, lugar: { type: 'string' } }, required: ['imovel', 'lugar'] } },
  { name: 'imoveis_perto', description: 'Lista os imóveis do catálogo mais próximos de um lugar de Joinville, com o tempo de carro de cada um. Use quando o cliente disser onde trabalha, estuda ou mora, para oferecer o que fica mais perto dali. lugar = o nome do lugar ou do bairro, como ele falou.', input_schema: { type: 'object', properties: { lugar: { type: 'string' } }, required: ['lugar'] } },
  { name: 'fipe_veiculo', description: 'Consulta a tabela FIPE de um carro ou moto que o cliente quer dar na entrada e já devolve os 80% que a Euro considera para abater a entrada. Use SEMPRE que o cliente falar em dar carro ou moto no negócio e não disser quanto vale (ou para conferir o valor que ele disse), em vez de dizer que o Djhonata confirma. Mande tipo = "carro" ou "moto", marca (você sabe pela conversa ou pelo modelo: Cerato é Kia, Onix é Chevrolet, Gol é VW, CG é Honda), modelo (pode ter a versão: "cerato 1.6 automático", "onix lt 1.0") e ano = ano MODELO com 4 dígitos. Se o cliente não disse o ano, pergunte antes de consultar.', input_schema: { type: 'object', properties: { tipo: { type: 'string' }, marca: { type: 'string' }, modelo: { type: 'string' }, ano: { type: 'string' } }, required: ['marca', 'modelo'] } },
];
// Só quando quem escreve é o Djhonata (WhatsApp pessoal, modo teste desligado): seção 13 do AGENTS.md
const FERRAMENTA_DONO = { name: 'mandar_ao_cliente', description: 'Manda uma mensagem a um cliente a pedido do Djhonata, falando como o Djhonata. cliente = nome ou telefone do cliente, como o Djhonata citou (ou o do último aviso). texto = a mensagem para o cliente (pode ter [[tts:...]] para áudio e linhas com --- para separar mensagens). combinado = resumo curto da orientação do Djhonata sobre esse cliente, para seguir nas próximas conversas com ele.', input_schema: { type: 'object', properties: { cliente: { type: 'string' }, texto: { type: 'string' }, combinado: { type: 'string' } }, required: ['cliente', 'texto'] } };

function pastasTodas() {
  try { return fs.readdirSync(CATALOGO, { withFileTypes: true }).filter(d => d.isDirectory() && !d.name.startsWith('_')).map(d => d.name); } catch (e) { return []; }
}
// 26/11/2026 (check-up): só valem as pastas que estão na tabela do CATALOGO.md. Pasta de imóvel vendido, suspenso ou indisponível
// (ex.: ref 832, Coronel Vieira no Jardim Iririú) continua no disco, mas não pode ser achada nem oferecida. Sem CATALOGO.md legível, vale tudo.
let catPastasCache = { em: 0, set: null };
function pastasDoCatalogo() {
  if (Date.now() - catPastasCache.em > 5 * 60000) {
    const s = new Set(); const re = /catalogo\\(.+?)\\ficha\.md/gi; let m;
    const t = lerTexto('CATALOGO.md'); while ((m = re.exec(t))) s.add(m[1].trim());
    catPastasCache = { em: Date.now(), set: s.size >= 20 ? s : null };
  }
  return catPastasCache.set;
}
function pastasImoveis() {
  const todas = pastasTodas(), cat = pastasDoCatalogo();
  return cat ? todas.filter(n => cat.has(n)) : todas;
}
// 25/11/2026 (Djhonata): a assistente só oferece imóvel em Joinville. Imóvel de Araquari ou São Francisco do Sul (a cidade vem entre parênteses
// no bairro da tabela do CATALOGO.md, ex.: "Itinga (Araquari)") fica fora da oferta certa, dos imóveis perto e da tabela que vai para a IA.
const RE_FORA_JOI = /\((araquari|s[ãa]o francisco do sul)\)/i;
let foraCache = { em: 0, set: new Set() };
function foraDeJoinville(pasta) {
  if (Date.now() - foraCache.em > 10 * 60000) {
    const s = new Set();
    for (const l of lerTexto('CATALOGO.md').split('\n')) { if (!/^\|/.test(l) || !RE_FORA_JOI.test(l.split('|')[1] || '')) continue; const m = /catalogo\\(.+?)\\ficha\.md/i.exec(l); if (m) s.add(m[1].trim()); }
    foraCache = { em: Date.now(), set: s };
  }
  return foraCache.set.has(pasta);
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
    aval: avalDaRef(pasta) || avaliacaoDaFicha(t, preco), naoAceitaSuperior: /n[aã]o aceita avalia[çc][ãa]o superior/i.test(t)
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
// Parcela do financiamento (tabela do Djhonata, 25/11/2026): pelo VALOR FINANCIADO, R$ 6,50 por mês a cada R$ 1.000 financiados
// (200 mil = R$ 1.300; 250 mil = 1.625; 300 mil = 1.950; 350 mil = 2.275; 400 mil = 2.600; 480 mil = 3.120). Valor quebrado: mesma conta, arredondada de 10 em 10.
const PARCELA_POR_MIL = 6.5;
function parcelaEstimada(financiado) {
  const v = Number(financiado) || 0;
  return Math.round(v / 1000 * PARCELA_POR_MIL / 10) * 10;
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
    if (foraDeJoinville(p)) continue;   // 25/11/2026: só Joinville
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
  if (!f.preco) return { erro: 'Esse imóvel está sem preço na ficha: não monte simulação; diga que o valor certo você confirma e convide para o escritório.' };
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
  const nPos = Math.min(24, Math.max(0, Math.round(num(e.pos_chaves, 0))));   // 25/11/2026 (Djhonata): pós-chaves até 24 meses; passando disso, reforços   // máximo de parcelas mensais depois das chaves (a conta usa só as que precisar)
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
    if (naEntrega >= 1) L.push(`✅ Reforço na entrega das chaves: ${brl(naEntrega)} (até ${mesRot(meses + 3)})`);   // 24/11/2026 (Djhonata): entrega + 3 meses, prazo para entrar com o financiamento
    if (posLinha) L.push(posLinha);   // na ordem em que o cliente paga: entrega das chaves e, depois, as parcelas pós-chaves
    if (resto >= 1) { L.push(`✅ Falta combinar: ${brl(resto)} (${posTxt ? 'a gente vê junto como fica' : 'dá para parcelar depois das chaves'})`); falta = resto; }
    q = nBal + (naEntrega >= 1 ? 1 : 0);
    if (temResto && q && parcSem <= 3000) alt = `Sem reforço, a parcela mensal fica em ${brl(parcSem)}.`;   // só quando é uma opção de verdade (com poucos meses passa de R$ 3 mil e só confunde)
  }
  const parcFin = parcelaEstimada(financ);
  L.push(`🏦 Financiamento pela Caixa: ${brl(financ)}${obra ? ' (começa quando o imóvel ficar pronto)' : ''}`);
  // 25/11/2026 (Djhonata, caso Janaína): a parcela do financiamento NÃO vai no bloco; só é dita se o cliente perguntar (estimativa em parcFin)
  if (alt) L.push('', alt);
  if (posTxt) L.push('', 'O pós-chaves depende de a construtora aceitar e é formalizado na proposta.');
  L.push('', 'Simulação inicial, sujeita à aprovação do banco.');
  return {
    texto: L.join('\n'),
    resumo: `${f.nome}, ${brl(f.preco)}, sinal ${brl(sinal)}${parcelaUsada ? ', parcela ' + brl(parcelaUsada) : ''}${fgtsUsado ? ', FGTS ' + brl(fgtsUsado) : ''}${nBal ? `, ${nBal} reforço(s) de fim de ano de ${brl(balaoV)}` : ''}${naEntrega >= 1 ? ', na entrega das chaves ' + brl(naEntrega) : ''}${posTxt}${falta ? ', falta combinar ' + brl(falta) : ''}, financiamento ${brl(financ)} (avaliação ${brl(av)}${f.aval ? ' da ficha' : ''})`,
    financ, entrada, av, preco: f.preco, renda: renda || 0, pasta, nome: f.nome, parcelas: n, falta, parcFin, baloes: nBal, naEntrega, entregaMin,
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
// 23/11/2026 (Djhonata, caso do Soft Iris): a assistente mandava foto por foto e inventava a legenda sem ver a foto (área de festas saiu como "Sala e cozinha integradas").
// Agora, quando o cliente quer as fotos, vão TODAS as fotos do imóvel, na ordem da ficha, sem legenda.
function fotosDoImovel(pasta) {
  const l = [];
  const m = /^- Fotos[^\n]*\n((?:[ \t]+- .+\n?)+)/m.exec(lerTexto(path.join(pasta, 'ficha.md')));
  if (m) for (let x of m[1].split('\n')) { x = x.replace(/^[ \t]+- /, '').trim(); if (!x) continue; l.push(/^https?:/i.test(x) ? x : x.replace(/\\/g, '/').replace(/^[a-z]:\/users\/public\/catalogo\//i, '')); }
  try { for (const f of fs.readdirSync(path.join(CATALOGO, pasta)).filter(a => EXT_IMG.test(a) && !EH_PROJETO.test(a)).sort()) l.push(pasta + '/' + f); } catch (e) { }
  return [...new Set(l)].filter(c => EXT_IMG.test(c.split('?')[0]) && !EH_PROJETO.test(c));
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
  // 16/11/2026: 23 imóveis ficaram sem o ponto exato (rua com grafia diferente no mapa, "Rua Servidão…", "Rua Estr. Geral…", Araquari e São Francisco do Sul).
  // Segunda tentativa na busca que tolera erro de grafia, com a rua limpa e a cidade da ficha; o ponto tem que cair perto do bairro.
  if (!x) {
    const cid = /araquari/i.test(e.texto) ? 'Araquari' : /s[ãa]o francisco do sul/i.test(e.texto) ? 'São Francisco do Sul' : 'Joinville';
    const rua = e.rua.replace(/^rua\s+(?=(servid[aã]o|estr\.?|estrada|rodovia|avenida|travessa)\b)/i, '').replace(/^estr\.?\s/i, 'Estrada ');
    for (const q of [(rua + ' ' + (e.numero || '')).trim(), rua]) {
      const y = await geoPhoton(q, cid, nomeB);
      if (y && (!centro || geoHav(y.lat, y.lon, centro[0], centro[1]) <= 5000)) { x = { lat: y.lat, lon: y.lon }; break; }
    }
  }
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
async function geoPhoton(q, cidade, bairro) {   // segunda busca, tolerante a erro de grafia; só vale resultado na região de Joinville (com Araquari e São Francisco do Sul)
  try {
    const j = await geoBuscar('https://photon.komoot.io/api/?q=' + encodeURIComponent(q + (bairro ? ' ' + bairro : '') + ' ' + (cidade || 'Joinville')) + '&limit=5&bbox=-49.2,-26.5,-48.45,-26.05');
    for (const f of (j && j.features) || []) {
      const c = (f.geometry || {}).coordinates || [], pr = f.properties || {}, lat = Number(c[1]), lon = Number(c[0]);
      if (!(lat < -26.05 && lat > -26.5 && lon > -49.2 && lon < (cidade && cidade !== 'Joinville' ? -48.45 : -48.65))) continue;
      if (cidade && cidade !== 'Joinville' && pr.city && !semAcento(pr.city).includes(semAcento(cidade).split(' ')[0])) continue;
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
      const cand = pastasImoveis().filter(p => !foraDeJoinville(p)).map(p => ({ p, g: geo.imoveis[p] })).filter(x => x.g && x.g.lat).map(x => Object.assign(x, { reta: geoHav(l.lat, l.lon, x.g.lat, x.g.lon) })).sort((a, b) => a.reta - b.reta).slice(0, 24);
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
      // Renda e parcela do financiamento (13/11/2026; tabela nova 25/11/2026): a parcela é a estimativa pelo valor financiado; nada de conta pela renda.
      const avisoRenda = ` PARCELA DO FINANCIAMENTO: NÃO fale por conta própria (não vai no bloco). Só se ele perguntar, diga a estimativa deste imóvel: em torno de ${brl(r.parcFin)} por mês, pelo valor financiado de ${brl(r.financ)}, e que o valor certo sai na aprovação da Caixa; se ele perguntar de outro valor de financiamento, a conta é R$ 6,50 por mês a cada R$ 1.000 financiados (200 mil = R$ 1.300; 300 mil = R$ 1.950; 400 mil = R$ 2.600); não calcule parcela pela renda e não fale "30% da renda". NÃO diga que o financiamento "cabe na renda", "fica dentro da renda" nem que "dá para entrar": quanto a Caixa libera só sai na análise, no escritório.${r.renda > 0 && r.renda < 5000 ? ' Como a renda informada é menor que R$ 5 mil, pode perguntar se tem alguém para somar renda.' : ''}${r.temFgts ? '' : ' FGTS: não fale de FGTS agora; só se o cliente achar o fluxo pesado (aí pergunte UMA vez se ele tem FGTS para abater na entrada) ou se ele mesmo citar.'}`;
      // Depois do fluxo (decisão do Djhonata, 13/11/2026): UMA pergunta aberta; nos ajustes, mexe só no que o cliente falou, uma pergunta por vez.
      const comoAjustar = ' Se ele disser que ficou pesado, descubra O QUE pesa (a parcela, o reforço de fim de ano ou o valor na entrega das chaves) e refaça mexendo só nisso: parcela = o que ele consegue por mês; balao = 0 se não consegue reforço no fim do ano; reforco = 0 (ou o valor que consegue) e pos_chaves = 24 se não consegue o valor na entrega das chaves.';
      let depois;
      if (!repetida) depois = 'mande a CONFERÊNCIA DEPOIS DO FLUXO (regra das melhorias, 25/11/2026), de preferência em ÁUDIO ([[tts:...]]) porque é muita coisa para ler: pergunte se o imóvel é o que ele gostou e se a localização ficou boa, se o fluxo faz sentido e fica dentro da realidade dele, diga que ajusta o que ele quiser (sinal, parcela, valor das chaves) quantas vezes precisar porque quer montar uma condição que ele consiga comprar, e que se ficou tudo certo a gente marca para ele vir no escritório tirar as dúvidas com calma (e ver outras opções, se precisar). NÃO pergunte "O que pesa mais, o sinal ou a parcela?" nem "O que você achou desse fluxo?". Não pergunte de renda, FGTS, carteira assinada nem onde ele mora';
      else if (r.falta >= 1 && !r.temPos) depois = `diga que ficam faltando ${brl(r.falta)} e proponha parcelar esse valor depois das chaves (ex.: "Vamos fazer um pós-chaves então?"). Se ele topar, chame simular_fluxo de novo com os mesmos números e pos_chaves = 24 (a ferramenta usa só as parcelas que precisar)`;
      else if (r.falta >= 1) depois = `diga que ainda ficam ${brl(r.falta)} para combinar e pergunte SÓ como ele prefere acertar esse valor: um pouco mais de sinal, um reforço no fim do ano ou um valor na entrega das chaves`;
      else if (r.entregaMin) depois = `explique que, para a conta fechar, ficam ${brl(r.naEntrega)} na entrega das chaves (é o mínimo: "pelo menos ${brl(r.naEntrega)} você precisa dar na entrega das chaves") e pergunte SÓ se assim fica bom para ele`;
      else depois = 'pergunte SÓ se assim fica bom para ele';
      // 23/11/2026 (Djhonata, caso Clemair): quando o cliente pergunta "qual o valor da entrada", a resposta é o percentual (20%, ou menos quando a avaliação passa do preço)
      const pctEnt = r.av > 0 ? Math.round(1000 * r.entrada / r.av) / 10 : 0;
      const notaEntrada = pctEnt ? ` ENTRADA DESTE IMÓVEL: ${brl(r.entrada)} no total, que dá ${String(pctEnt).replace('.', ',')}% (somando sinal, parcelas, reforços e o valor das chaves). Se o cliente perguntar "qual o valor da entrada", responda com esse percentual arredondado (regra QUAL É A ENTRADA); o valor em reais só se ele pedir.` : '';
      const fecho = ` Não fale da avaliação do banco por conta própria. O convite para o escritório vem na CONFERÊNCIA DEPOIS DO FLUXO (se ficou tudo certo para ele) ou quando ele mostrar interesse em fechar ou ver de perto.${comoAjustar}${avisoRenda}${porque}${notaEntrada}`;
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
      const opT = (() => { try { const f = dadosDaFicha(p), av = avalDaRef(p); if (!(f.preco > 0) || !(av > f.preco)) return ''; const fin = Math.min(Math.round(0.8 * av), 480000), ent = Math.max(10000, f.preco - fin); return `\nOPORTUNIDADE (26/11/2026; avaliação da Caixa pela tabela do Djhonata: ${brl(av)}, ${brl(av - f.preco)} acima do preço): a ENTRADA a pedir é ${brl(ent)} (preço ${brl(f.preco)} − financiamento de ${brl(fin)}), toda na assinatura do contrato. Diga esse valor em reais, nunca "uns 20%", e siga a regra OPORTUNIDADE: PEDE A ENTRADA INTEIRA E NEGOCIA DALI PARA BAIXO.`; } catch (e) { return ''; } })();   // 26/11/2026 (Djhonata)
      const ge = geoEnderecoDaFicha(p), entornoTxt = geoEntornoTexto(p), bp = ge && ge.bairro >= 0 ? geoBairrosPerto(ge.bairro) : null;
      const local = (bp ? `\nLOCALIZAÇÃO: bairro ${GEOJOI.nomes[ge.bairro]}. Faz divisa com: ${bp.divisa.join(', ') || 'nenhum mapeado'}.${bp.perto.length ? ' Até 10 min de carro: ' + bp.perto.join(', ') + '.' : ''} Só estes bairros podem ser chamados de "perto"; para qualquer outro lugar use a ferramenta distancia.` : '') + opT
        + (entornoTxt ? `\nPERTO DESTE IMÓVEL (conferido no mapa e aprovado pelo Djhonata; distâncias aproximadas a pé): ${entornoTxt}.` : '\nPERTO DESTE IMÓVEL: ainda sem informação conferida. Se o cliente perguntar o que tem perto, diga que vai confirmar.');
      const projs = projetosDaPasta(p);
      const projTxt = projs.length
        ? projs.length > 1
          // 16/11/2026 (pedido do Djhonata): unidades diferentes (esquina, subesquina, meio) têm projeto próprio; vai o da unidade negociada, nunca o de outra
          ? `\nPROJETOS NA PASTA (${projs.length} arquivos, um por unidade ou tipo; o nome do arquivo diz de qual é): ${projs.join(' | ')}. Se o cliente pedir a planta ou o projeto, mande SÓ o arquivo da unidade que está sendo negociada, com enviar_arquivo e uma legenda curta dizendo de qual casa é, e depois convide com dois horários. Como ler o nome: "un 8" ou "unidade 8" é a casa 8; "tipo" é o projeto das casas de meio, que são iguais entre si; arquivo sem número de unidade (térreo, superior, arquitetônico) vale para o conjunto todo. Se ainda não estiver claro qual casa o cliente quer, pergunte antes, numa frase só, qual casa ele está olhando (o número, ou se é a de esquina ou a de meio) e só então mande. Nunca mande o projeto de uma unidade como se fosse de outra. Não mande sem ele pedir.`
          : `\nPROJETO NA PASTA: ${projs.join(' | ')}. Se o cliente pedir a planta ou o projeto, mande este arquivo com enviar_arquivo, com uma legenda curta, e depois convide com dois horários. Não mande sem ele pedir.`
        : `\nPROJETO: não há arquivo de projeto na pasta deste imóvel. Se o cliente pedir a planta ou o projeto, diga uma vez "Vou separar o projeto e já te mando aqui" e use avisar_djhonata com "ENVIAR PROJETO", o nome do cliente e o imóvel.`;
      const nConj = (estado.conjuntos || {})[geoRef(p)];   // 13/11/2026: quantas casas tem o geminado, informado no CRM (campo "Casas no conjunto")
      const unid = nConj ? `\nPONTA OU MEIO: este conjunto tem ${nConj} casas (informado pelo Djhonata no CRM). De ponta são a casa 1 e a casa ${nConj}; as outras são de meio. Se perguntarem, responda na hora com o número da casa e o valor, sem pedir confirmação.` : /^- Unidades dispon[íi]veis:.*\d/mi.test(ficha) ? `\nPONTA OU MEIO: de ponta são a casa 1 e a de maior número do conjunto (some as disponíveis e as vendidas das anotações); as outras são de meio. Se perguntarem, responda com o número da casa e o valor.` : '';
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
        const vidAnt = ehVideo ? lerEsp(ctx.jid).filter(m => m.tipo === 'video' && m.autor !== 'cliente' && (m.oferta === pasta || pastaDoCaminho(String(m.arquivo || '').replace(/^c\//, '')) === pasta)).pop() : null;
        if (vidAnt && (Date.now() - (vidAnt.ts || 0) < 3 * 60e3 || !/de novo|novamente|reenvi|outra vez/i.test(textoRecenteCliente(ctx.jid)))) return 'Não enviado: o vídeo deste imóvel já saiu nesta conversa. Não reenvie e não fale do envio; continue a conversa.';
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
      // 23/11/2026 (Djhonata): foto do imóvel que não é a da oferta = o cliente quer ver as fotos. Vão todas de uma vez, sem legenda (a assistente não enxerga a foto, então não descreve).
      if (pasta && !extra && !EXT_VID.test(caminho.split('?')[0])) {
        ctx.fotosTodas = ctx.fotosTodas || {};
        if (ctx.fotosTodas[pasta]) return 'Não enviado: todas as fotos deste imóvel já foram agora. Não chame enviar_arquivo de novo para fotos dele.';
        // 24/11/2026 (Djhonata): cliente pediu fotos = vai primeiro o VÍDEO do imóvel (ele junta todas as fotos). Só se o cliente insistir nas fotos depois do vídeo é que vão todas as fotos.
        { const vRel = pasta + '/video-whatsapp.mp4', vRef = 'c/' + vRel;
          if (fs.existsSync(path.join(CATALOGO, vRel)) && !lerEsp(ctx.jid).some(m => m.arquivo === vRef)) {
            let rv = ''; try { rv = await enviarArquivo(ctx.jid, vRel, '', 'ia'); } catch (e) { rv = 'erro: ' + e.message; }
            if (rv === 'Enviado.') { ctx.fotosTodas[pasta] = 1; ctx.notas.push(`[enviei o vídeo do imóvel ${pasta} no lugar das fotos]`); log('fotos: foi o vídeo', ctx.jid, pasta);
              return 'Enviado o VÍDEO deste imóvel (ele mostra todas as fotos). Diga em uma frase curta que mandou o vídeo com as fotos dele e siga com a pergunta do próximo passo. Não descreva o que aparece. Se o cliente disser que o vídeo não abre ou insistir nas fotos, chame enviar_arquivo de novo com uma foto e o sistema manda todas.'; }
            log('fotos: o vídeo não foi, seguem as fotos', pasta, rv);
          } }
        const jaFoi = new Set(lerEsp(ctx.jid).map(m => m.arquivo)), refDe = c => /^https?:\/\//i.test(c) ? c : 'c/' + c.replace(/^[\\/]+/, '').replace(/\\/g, '/');
        const falta = fotosDoImovel(pasta).filter(c => !jaFoi.has(refDe(c))).slice(0, 30);
        ctx.fotosTodas[pasta] = 1;
        if (!falta.length) return 'Não enviado: este cliente já recebeu todas as fotos deste imóvel nesta conversa. Não reenvie; continue a conversa.';
        let n = 0, erro = '';
        for (const c of falta) { let rr = ''; try { rr = await enviarArquivo(ctx.jid, c, '', 'ia'); } catch (e) { rr = 'foto fora do ar: ' + e.message; log('fotos: pulei uma foto que não abriu', pasta, String(c).slice(-40)); }   // 24/11/2026 (caso Ricardo, Imbuia): uma foto fora do ar no Loft derrubava o envio de todas
          if (rr === 'Enviado.') n++; else { erro = rr; if (/desconectado|bloqueado|limite/i.test(rr)) break; } }
        log('fotos: todas', ctx.jid, pasta, n + '/' + falta.length, erro);
        if (!n) return erro || 'Não enviado.';
        ctx.notas.push(`[enviei as ${n} fotos do imóvel ${pasta}, sem legenda]`);
        return `Enviadas TODAS as fotos deste imóvel (${n} fotos, sem legenda). Não chame enviar_arquivo de novo para fotos dele. Você NÃO enxerga as fotos: não descreva o que aparece nelas e não diga qual cômodo é. Siga a regra DEPOIS DAS FOTOS: uma frase curta e natural ("Mandei as fotos, Fulano. O que tu achou?").`;
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
      if (/projeto|planta/i.test(txt) && !ctx.dono) { const ult = lerEsp(ctx.jid).filter(m => m.oferta).pop(), pj = ult ? projetosDaPasta(ult.oferta) : []; if (pj.length) return (pj.length > 1 ? `Aviso não enviado: os projetos deste imóvel estão na pasta (${pj.join(' | ')}). Mande você mesmo agora o da unidade que o cliente está negociando (o nome do arquivo diz de qual é; se não souber a unidade, pergunte antes), com enviar_arquivo e uma legenda curta.` : `Aviso não enviado: o projeto deste imóvel está na pasta (${pj[0]}). Mande você mesmo agora, com enviar_arquivo e uma legenda curta.`) + AVISO_INTERNO; }
      const tipoAv = tipoDoAviso(txt);
      estado.avisos = [...(estado.avisos || []), { id: 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), ts: Date.now(), jid: ctx.jid, nome: ctx.nome || '', telefone: ctx.telefone || '', texto: txt.slice(0, 600), tipo: tipoAv }].slice(-80); salvarEstado();
      if (tipoAv === 'info') { log('aviso só informativo: não foi para o Djhonata', ctx.jid); return 'Aviso não enviado: o Djhonata só recebe aviso de visita marcada ou desmarcada, cliente que pede para falar com uma pessoa, indicação, permuta, projeto que você não tem para mandar e cliente quente que esfriou. Continue atendendo o cliente normalmente.' + AVISO_INTERNO; }
      if (tipoAv === 'duvida') { log('dúvida de cliente anotada para o CRM', ctx.jid); return 'Dúvida anotada para o Djhonata responder pelo CRM (não foi para o celular dele). Diga ao cliente UMA vez que passa essa informação quando ele vier ao escritório e continue a conversa com uma pergunta do próximo passo.' + AVISO_INTERNO; }
      if (estado.teste && estado.teste.ativo) {   // no teste o "cliente" é o próprio Djhonata: o aviso fica só no CRM
        registrarEspelho(ctx.jid, { id: 'av' + Date.now().toString(36), autor: 'aviso', tipo: 'text', texto: '🔔 Aviso ao Djhonata (não enviado, modo teste): ' + txt, ts: Date.now() });
        log('teste: aviso ao Djhonata ficou só no CRM');
        return 'Aviso registrado para o Djhonata. Continue atendendo o cliente normalmente.' + AVISO_INTERNO;
      }
      // 24/11/2026 (pente fino): o mesmo cliente gerou 6 avisos seguidos sobre o mesmo assunto. Um aviso por cliente a cada 3 horas, salvo visita marcada/desmarcada/remarcada ou URGENTE.
      { const muda = /URGENTE|desmarc|cancel|remarc|visita\s+(?:agendada|marcada)/i.test(txt);
        const antes = (estado.avisos || []).filter(a => a.jid === ctx.jid && a.enviado && Date.now() - (a.ts || 0) < 3 * 3600e3);
        if (!muda && antes.length) { log('aviso repetido do mesmo cliente: não foi para o Djhonata', ctx.jid); return 'Aviso NÃO enviado: você já avisou o Djhonata sobre este cliente há pouco. Não avise de novo; continue atendendo.' + AVISO_INTERNO; }
        const ult = (estado.avisos || [])[(estado.avisos || []).length - 1]; if (ult && ult.jid === ctx.jid) ult.enviado = true; }
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
    if (nome === 'fipe_veiculo') {
      try { return await fipeConsultar(entrada || {}); }
      catch (e) { log('fipe: falhou', e.message); return 'Não consegui consultar a tabela FIPE agora. Pergunte ao cliente se ele sabe o valor da FIPE (ou o modelo, o ano e a versão) e use 80% desse valor para abater a entrada; diga que a conta fecha no escritório.'; }
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
      // 14/11/2026 (Daiane): a ferramenta não sabia que o horário ocupado era do próprio cliente. Ela marcou terça 8h, a assistente consultou de novo,
      // viu o horário como "não livre", disse que a visita não tinha ficado marcada e marcou outro: ficaram quatro horários presos para a mesma cliente.
      // Agora é um cliente, um horário: o horário dele é reconhecido, marcar o mesmo de novo não faz nada e marcar outro TROCA a visita
      // (o evento leva agendaValer e o CRM libera o horário antigo na agenda).
      const vMinha = ctx.jid ? (estado.visitas || {})[ctx.jid] : null;
      const minha = vMinha && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(vMinha.q || '') && quandoMs(vMinha.q) > Date.now() ? vMinha.q : '';
      const minhaTxt = minha ? `${diaTxt(minha.slice(0, 10))} às ${minha.slice(11)}` : '';
      if (!marcar && minha) return opcoes + ` ATENÇÃO: este cliente JÁ TEM visita marcada em ${minhaTxt}${ocup.has(minha) ? ' (esse horário aparece ocupado na agenda porque é o DELE)' : ''}. Ela continua valendo: não diga que não ficou marcada e não ofereça outro horário, a não ser que ELE peça para trocar. Para trocar, chame agenda_visita com acao "marcar" e o novo dia e hora (a antiga é cancelada sozinha). Se ele só desmarcar, use registrar_crm com novoStatus remarcar.`;
      if (!marcar) {
        // Pacote de 12/11/2026: para não oferecer os mesmos dois horários a todos os clientes, sugere os menos oferecidos nas últimas 24h
        // (um neste dia e outro no próximo dia com vaga). Quem marcar primeiro leva; os outros já receberam horários diferentes.
        // 23/11/2026 (Djhonata, caso Nilza): cliente que trabalha em horário comercial recebe horário depois do expediente. aPartirDe = hora (ex.: 18).
        const apd = Math.round(Number(String(entrada.aPartirDe || '').replace(/[^\d.]/g, '')) || 0), tarde = (l) => apd >= 9 && apd <= 19 ? l.filter(h => h >= apd) : l;
        const of = estado.ofertasAg = estado.ofertasAg || {}; for (const k of Object.keys(of)) if (Date.now() - (of[k].ts || 0) > 24 * 3600e3) delete of[k];
        const menos = (dia, l) => l.slice().sort((x, y) => (((of[dia + ' ' + x] || {}).n || 0) - ((of[dia + ' ' + y] || {}).n || 0)) || x - y)[0];
        const meus = estado.ofertasCli = estado.ofertasCli || {}; for (const k of Object.keys(meus)) if (Date.now() - (meus[k].ts || 0) > 6 * 3600e3) delete meus[k];
        const ant = ctx.jid ? meus[ctx.jid] : null;
        // 13/11/2026 (final 4424): em duas respostas seguidas ela ofereceu horários diferentes ao mesmo cliente. Enquanto ele não responde, valem os mesmos.
        // 13/11/2026 (Keyla): cliente quente ouviu "quinta ou sexta" da outra semana com vaga no dia seguinte. Se o dia consultado fica depois dos dois
        // próximos dias com vaga e não foi o cliente quem pediu esse dia, a sugestão sai dos dias mais próximos.
        const pedido = /^(s|true|1)/i.test(String(entrada.pedido || '')), perto = [], [yh, mh, dh] = iso(agoraSP()).split('-').map(Number);
        for (let i = 0; i < 14 && perto.length < 2; i++) { const dia = iso(new Date(yh, mh - 1, dh + i)); if (tarde(agendaLivres(ocup, dia)).length) perto.push(dia); }
        const longe = !pedido && perto.length === 2 && data > perto[1], base = longe ? perto[0] : data, livresB = tarde(longe ? agendaLivres(ocup, base) : livres);
        if (ant && ant.sug.length === 2 && !(apd && ant.sug.some(([, h]) => h < apd)) && (longe || ant.sug.some(([dia]) => dia === data || data <= ant.sug[0][0])) && ant.sug.every(([dia, h]) => agendaLivres(ocup, dia).includes(h)))
          return opcoes + ` Você JÁ ofereceu a este cliente ${ant.sug.map(([dia, h]) => `${diaTxt(dia)} às ${hh(h)}`).join(' ou ')} há ${Math.max(1, Math.round((Date.now() - ant.ts) / 60e3))} min: se for citar horário, use ESSES MESMOS, não ofereça outros. Se ele ainda não respondeu a esse convite, não repita a pergunta. Se o cliente pediu outro dia ou horário e ele está livre, vale o que ele pediu. Quando o cliente escolher, chame agenda_visita com acao "marcar".`;
        const sug = [], [y0, mo0, d0] = base.split('-').map(Number);
        if (livresB.length) sug.push([base, menos(base, livresB)]);
        for (let i = 1; i < 14 && sug.length < 2; i++) { const dia = iso(new Date(y0, mo0 - 1, d0 + i)), l = tarde(agendaLivres(ocup, dia)); if (l.length) sug.push([dia, menos(dia, l)]); }
        if (sug.length) { sug.forEach(([dia, h]) => { const k = dia + ' ' + h; of[k] = { n: ((of[k] || {}).n || 0) + 1, ts: Date.now() }; }); if (ctx.jid && sug.length === 2) meus[ctx.jid] = { sug, ts: Date.now() }; salvarEstado(); }
        const dica = sug.length === 2 ? (longe ? ` O dia consultado fica longe e há vaga antes. Se o cliente NÃO pediu ${diaTxt(data)},` : ' Para não oferecer o mesmo horário a todos os clientes,') + ` ofereça AGORA estes dois: ${sug.map(([dia, h]) => `${diaTxt(dia)} às ${hh(h)}`).join(' ou ')}. Se o cliente pediu outro dia ou horário e ele está livre, vale o que ele pediu.` : '';
        return opcoes + (apd >= 9 && apd <= 19 ? ` Como o cliente só pode a partir das ${apd}h, ofereça só horário das ${apd}h em diante (nunca meio do dia).` : '') + dica + ' Quando o cliente escolher, chame agenda_visita com acao "marcar".';
      }
      const hm = /^(\d{1,2})(?:\s*(?:[:h]|horas?)\s*(\d{2})?)?/i.exec(String(entrada.hora || '').trim()), h = hm ? Number(hm[1]) : NaN;
      const pedida = hm && (!hm[2] || hm[2] === '00') ? `${data}T${hh(h)}` : '';
      if (minha && pedida === minha && ocup.has(minha)) return `Este cliente JÁ ESTÁ marcado em ${minhaTxt}: a visita está valendo e não precisa marcar de novo. Não diga que não ficou marcado e não ofereça outro horário. Se for o caso, só confirme o dia, a hora e o endereço (Rua Dona Francisca, 1222 - Saguaçu).`;
      const segue = minha ? ` A visita que ele já tem (${minhaTxt}) continua marcada enquanto ele não escolher outro horário livre.` : '';
      if (!hm || (hm[2] && hm[2] !== '00') || !livres.includes(h)) return `O horário pedido NÃO está livre (a agenda é de hora em hora e precisa de ${AG_ANTECEDENCIA_H} horas de antecedência). ${opcoes} Ofereça esses ao cliente e não confirme o que ele pediu.` + segue;
      if (estado.teste && estado.teste.ativo) return `Modo teste: ${diaTxt(data)} às ${hh(h)} está livre (nada foi gravado na agenda). Confirme ao cliente normalmente.`;
      // 23/11/2026 (Djhonata): na agenda e no CRM vai o nome que o cliente disse, nunca o nome do perfil do WhatsApp (ex.: perfil "JoãoPdro 😎" -> "João").
      if (!String(entrada.nome || '').trim()) return 'NÃO marquei: falta o nome. Chame "marcar" de novo com nome = o primeiro nome que o cliente disse nesta conversa (ex.: "João"), nunca o nome do perfil do WhatsApp. Se ele ainda não disse o nome, pergunte antes ("Pra eu deixar certo na agenda, como é o teu nome?") e só marque depois.';
      const nomeCli = String(entrada.nome).replace(/[^\p{L}\s'.-]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || 'Cliente', tel = String(ctx.telefone || '').replace(/\D/g, '');
      const local = String(entrada.local || '').replace(/\s+/g, ' ').trim().slice(0, 90), noImovel = local ? ' · NO IMÓVEL: ' + local : '';   // 18/11/2026 (Djhonata): visita direto no imóvel aparece na agenda com o endereço
      let resp = '';
      try { const r = await fetch(`${AGENDA_HOOK}?acao=marcar&data=${data}&hora=${encodeURIComponent(hh(h))}&nome=${encodeURIComponent((nomeCli + noImovel).slice(0, 150))}&whatsapp=${encodeURIComponent(tel || '0')}`, { signal: AbortSignal.timeout(20000) }); resp = (await r.text()).trim(); }
      catch (e) { log('agenda: não marcou', e.message); return falhou; }
      if (!/^ok/i.test(resp)) return `Esse horário acabou de ser ocupado. ${livres.filter(x => x !== h).length ? `Ainda livres em ${diaTxt(data)}: ${livres.filter(x => x !== h).map(hh).join(', ')}.` : `Próximos livres: ${proximos(data, 3)}.`} Ofereça esses ao cliente.` + segue;
      const trocou = !!minha && minha !== pedida;
      guardarVisita(ctx.jid, data, hh(h), 'assistente', local);
      if (!local) ctx.fotoEscritorio = true;   // 24/11/2026: visita marcada no escritório leva a foto da fachada
      try { fs.appendFileSync(path.join(DADOS, 'eventos-crm.jsonl'), JSON.stringify(Object.assign({ rid: 'ag' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), ts: new Date().toISOString(), telefone: ctx.telefone ? formatoBR(ctx.telefone) : '', nome: ctx.nome || '', novoStatus: 'visita_marcada', data, hora: hh(h), agendaValer: pedida, resultado: trocou ? `Visita REMARCADA pela assistente: de ${minhaTxt} para ${diaTxt(data)} às ${hh(h)} (vale só a nova)` + noImovel : `Visita marcada pela assistente na agenda: ${diaTxt(data)} às ${hh(h)}` + noImovel }, entrada.nome ? { nomeReal: nomeCli } : {})) + '\n'); } catch (e) { }
      if (ctx.jid) aplicarEtiquetaStatus(ctx.jid, 'visita_marcada').catch(() => { });
      if (ctx.notas) ctx.notas.push(trocou ? `[visita remarcada na agenda: de ${minha.replace('T', ' ')} para ${data} ${hh(h)}; a antiga foi cancelada]` : `[visita marcada na agenda: ${data} ${hh(h)}${noImovel}]`);
      log(trocou ? 'agenda: visita remarcada' : 'agenda: visita marcada', ctx.telefone || ctx.jid, trocou ? minha + ' ->' : '', data, hh(h));
      enviarTexto(DONO + '@s.whatsapp.net', trocou ? `🔁 Visita REMARCADA pela assistente: ${nomeCli}${ctx.telefone ? ' (' + formatoBR(ctx.telefone) + ')' : ''}, de ${minhaTxt} para ${diaTxt(data)} às ${hh(h)}${noImovel}. Vale só a nova; o horário antigo é liberado na agenda.` : `🔔 Visita marcada pela assistente: ${nomeCli}${ctx.telefone ? ' (' + formatoBR(ctx.telefone) + ')' : ''}, ${diaTxt(data)} às ${hh(h)}${noImovel}.`, 'aviso').catch(() => { });
      if (trocou) return `Remarcado: agora vale ${diaTxt(data)} às ${hh(h)}, em nome de ${nomeCli}. A visita antiga (${minhaTxt}) foi cancelada e o horário antigo é liberado sozinho na agenda. Confirme ao cliente só o novo dia, a hora e o endereço (${local ? 'NO IMÓVEL: ' + local + '; o Djhonata encontra ele lá' : 'Rua Dona Francisca, 1222 - Saguaçu'}) e diga que o horário antigo foi cancelado. Não mande o link nem peça comprovante.`;
      return `Marcado na agenda: ${diaTxt(data)} às ${hh(h)}, em nome de ${nomeCli}${noImovel}. Confirme ao cliente o dia, a hora e o endereço (${local ? 'NO IMÓVEL: ' + local + '; diga que o Djhonata encontra ele lá' : 'Rua Dona Francisca, 1222 - Saguaçu'}). Não mande o link nem peça comprovante: já está marcado.`;
    }
    if (nome === 'registrar_crm') {   // visitas: guardadas para os lembretes (também no modo teste, só para o número de teste)
      // "Em negociação" é só de quem já veio ao escritório: quem move para lá é o Djhonata, no CRM. A assistente fica em atendimento.
      if (/^negocia/i.test(String(entrada.novoStatus || ''))) { entrada.novoStatus = 'atendimento'; log('registrar_crm: a assistente pediu negociacao, ficou em atendimento'); }
      const st = String(entrada.novoStatus || '').toLowerCase();
      if (st === 'visita_marcada' && entrada.data) guardarVisita(ctx.jid, String(entrada.data), String(entrada.hora || ''), 'assistente');
      if (['remarcar', 'sem_interesse', 'sem_perfil', 'pausado', 'desistiu', 'negociacao'].includes(st)) cancelarVisita(ctx.jid, st);
      if (st === 'sem_perfil') { estado.pausas[ctx.jid] = Date.now() + 182 * 864e5; ctx.autoTrava = true; salvarEstado(); log('sem perfil: assistente travada nesta conversa', ctx.telefone || ctx.jid); }   // 23/11/2026 (Djhonata): sem perfil fica travado na hora
      // 23/11/2026 (Djhonata, cliente Jakyson): quando ela passa a conversa para ele (pausado), trava na hora, sem esperar o CRM abrir. A resposta desta vez ainda sai (autoTrava).
      // 23/11/2026 (Djhonata, cliente final 5803): cliente que recusou vai para Desistiu na hora e a conversa trava; a despedida desta vez ainda sai (autoTrava).
      if ((st === 'desistiu' || st === 'sem_interesse') && ctx.jid && !ctx.dono) { entrada.novoStatus = 'desistiu'; estado.pausas[ctx.jid] = Date.now() + 182 * 864e5; ctx.autoTrava = true; salvarEstado(); log('desistiu: card movido e assistente travada nesta conversa', ctx.telefone || ctx.jid); }
      if (st === 'pausado' && ctx.jid) { estado.pausas[ctx.jid] = Date.now() + 7 * 864e5; ctx.autoTrava = true; salvarEstado(); log('pausado pela assistente: conversa travada, o Djhonata assume', ctx.telefone || ctx.jid); }
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
// 26/11/2026: uma vez só, recupera do backup das 9h15 quem tinha "Corretor 1" ou "Corretor 2" (essas etiquetas saíram antes de virar "Corretor parceiro")
if (!estado.parceirosDoBackup) {
  try {
    const b = lerJson(path.join(DADOS, 'backups', '2026-11-26-0915', 'etiquetas.json'), null);
    if (b && b.labels && b.chats) {
      const ids = new Set(Object.entries(b.labels).filter(([, l]) => /^corretor\s*\d+$/i.test(String((l || {}).nome || '').trim())).map(([id]) => id));
      estado.parceiros = estado.parceiros || {}; let n = 0;
      for (const [j, l] of Object.entries(b.chats)) if ((l || []).some(id => ids.has(String(id))) && !estado.parceiros[j]) { estado.parceiros[j] = Date.now(); n++; }
      estado.parceirosDoBackup = n; gravarJson(ESTADO_F, estado);
    }
  } catch (e) { }
}
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
  if (m.autor === 'cliente' && !m.auto && m.ts > (c.ultCliente || 0)) c.ultCliente = m.ts;
  if (m.autor !== 'cliente' && c.ultNossa !== undefined && m.ts > c.ultNossa) c.ultNossa = m.ts;   // 25/11/2026: última mensagem nossa (Djhonata, assistente ou aviso) para o cliente   // 24/11/2026: resposta automática de conta comercial não conta como "o cliente escreveu"
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
function lembrarEnvio(r) { const id = r && r.key && r.key.id; if (id) { try { entregaAnotar(id, r.key.remoteJid); } catch (e) { } enviados.add(id); if (enviados.size > 5000) enviados.delete(enviados.values().next().value); } return id; }

// ---------- mensagem entregue ou não (17/11/2026) ----------
// Cada mensagem que sai fica anotada até o WhatsApp avisar que foi entregue (dois tiques). Se as mensagens para um número ficam 2 dias ou mais sem entrega,
// o número pode ter bloqueado, trocado de chip ou saído do WhatsApp. O WhatsApp não diz qual dos três; o que dá para saber é que não está chegando.
function entregaAnotar(id, jid) {
  if (!id || !jid || String(jid).endsWith('@g.us')) return;
  const P = estado.entregaPend = estado.entregaPend || {}; P[id] = { j: acharJid(jid), t: Date.now() };
  const ks = Object.keys(P); if (ks.length > 4000) for (const k of ks.sort((a, b) => P[a].t - P[b].t).slice(0, ks.length - 3500)) delete P[k];
}
function entregaConfirmar(id) {
  const P = estado.entregaPend || {}, p = P[id]; if (!p) return;
  const c = chats[p.j] || chats[acharJid(p.j)]; if (c) c.ultEntregue = Date.now();
  delete P[id]; for (const k of Object.keys(P)) if (P[k].j === p.j && P[k].t <= p.t) delete P[k];   // entregou esta: as mais antigas para o mesmo número não contam mais
  salvarEstado();
}
function semEntregaDias(jid) {
  try { const j = acharJid(jid), P = estado.entregaPend || {}, ue = (chats[j] || {}).ultEntregue || 0; let t0 = 0;
    for (const k of Object.keys(P)) if (P[k].j === j && P[k].t > ue && (!t0 || P[k].t < t0)) t0 = P[k].t;
    if ((chats[j] || {}).ultCliente > t0) return 0;   // ele escreveu depois: está recebendo
    const d = t0 ? Math.floor((Date.now() - t0) / 864e5) : 0; return d >= 2 ? d : 0; } catch (e) { return 0; }
}

// ---------- proteção contra banimento ----------
const LIM_MIN = Number(ENV.LIMITE_POR_MINUTO || 12), LIM_HORA = Number(ENV.LIMITE_POR_HORA || 180);
const envios = [];               // horários dos envios automáticos (assistente)
let ultimoEnvio = 0;
const dorme = (ms) => new Promise(r => setTimeout(r, ms));
const acaso = (a, b) => a + Math.floor(Math.random() * (b - a));
function tel8De(jid, tel) { return String(tel || (chats[jid] || {}).telefone || (pnDe(jid) || '').split('@')[0] || '').replace(/\D/g, '').slice(-8); }
function podeResponder(jid, tel) {   // ligada para todos, ou modo teste e é o número de teste; e não pausada nessa conversa
  if ((estado.pausas[jid] || 0) > Date.now()) return false;
  // 18/11/2026 (Djhonata, cliente Jairo): a trava do CRM tem que valer na hora. O CRM manda a lista de telefones travados assim que o card muda
  // (arrastou para Em negociação, marcou o cadeado, desistiu, fechado...), sem esperar a sincronização do computador do escritório.
  if ((estado.travaCrm || []).length) { const t8 = tel8De(jid, tel); if (t8.length === 8 && estado.travaCrm.includes(t8)) return false; }
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
// 23/11/2026 (Djhonata): responder citando a pergunta do cliente (a "setinha" do WhatsApp). A mensagem pode começar com [[cita: trecho]]
// (trecho = começo da mensagem do cliente, ou o id dela); o servidor acha essa mensagem na conversa e manda a resposta citando ela.
const RE_CITA = /\[\[\s*cita\s*:\s*([^\]]{1,200})\]\]/i;
function acharCitada(jid, alvo) {
  // 25/11/2026: "trecho A || trecho B" = tenta A; se não achar, B
  if (/\|\|/.test(String(alvo || ''))) { for (const parte of String(alvo).split('||')) { const r = parte.trim() && acharCitada(jid, parte.trim()); if (r) return r; } return null; }
  const norm = (x) => semAcento(String(x || '')).replace(/[^a-z0-9]+/g, ' ').trim();
  const a = norm(alvo); if (!a) return null;
  let l = lerEsp(jid); if (!l.length) { try { const j2 = acharJid(jid); if (j2 && j2 !== jid) { l = lerEsp(j2); jid = j2; } } catch (e) { } }
  const cli = l.filter(m => m.autor === 'cliente' && m.id && String(m.texto || '').trim()).slice(-60).reverse();
  let m = cli.find(x => x.id === String(alvo).trim()) || cli.find(x => { const t = norm(x.texto); return t && (t.includes(a.slice(0, 60)) || a.includes(t.slice(0, 60))); });
  // 25/11/2026 (Djhonata, caso Ley): resposta de pendência tem que sair citando a mensagem do cliente sobre aquele assunto. Se o trecho não bate
  // ao pé da letra (a pergunta veio reescrita), vale a mensagem do cliente com mais palavras em comum (pelo menos 2); no empate, a mais recente.
  if (!m) {
    const STOP = new Set(['para', 'pela', 'pelo', 'esse', 'essa', 'isso', 'como', 'qual', 'quanto', 'quanta', 'voce', 'dele', 'dela', 'mais', 'tambem', 'ainda', 'sobre', 'quando', 'onde', 'porque', 'fica', 'ficou', 'tenho', 'temos', 'estou', 'aqui', 'entao', 'certo', 'cliente']);
    const pal = (x) => new Set(norm(x).split(' ').filter(w => w.length >= 4 && !STOP.has(w)));
    const pa = pal(alvo); let bs = 0;
    for (const x of cli) { let s = 0; for (const w of pal(x.texto)) if (pa.has(w)) s++; if (s > bs) { bs = s; m = x; } }
    if (bs < 2) m = null;
  }
  return m ? { key: { remoteJid: jid, id: m.id, fromMe: false }, message: { conversation: String(m.texto).slice(0, 1000) } } : null;
}
async function enviarTexto(jid, texto, autor = 'ia', extra) {
  if (!sock || !conectado || !String(texto || '').trim()) return null;
  let citada = null; { const mc = RE_CITA.exec(String(texto)); if (mc) { try { citada = acharCitada(jid, mc[1]); } catch (e) { } } texto = String(texto).replace(new RegExp(RE_CITA.source, 'gi'), '').replace(/^\s+/, ''); }
  if (!String(texto || '').trim()) return null;
  if (autor === 'ia') texto = semDiminutivo(semJoinha(texto));
  try { await guardaEnvio(jid, autor, texto, 'text'); } catch (e) { log('envio barrado', jid, e.message); return null; }
  const r = citada ? await sock.sendMessage(jid, { text: String(texto).trim() }, { quoted: citada }) : await sock.sendMessage(jid, { text: String(texto).trim() });
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
const FALA_TESTE = 'Oi, tudo bem? Aqui é o Djhonata, da Euro. Olha, sobre a simulação: a entrada dá pra parcelar, e o restante a gente financia pela Caixa. Pra eu te passar o valor certo, eu preciso ver a sua renda... então o ideal é você vir aqui no escritório, sem compromisso, tá? Me fala qual dia fica melhor pra você.';
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
// Reações (pedido do Djhonata, 16/11/2026): ele reage às mensagens dos clientes com 🙏🏼 e ✅ e a assistente faz igual.
// A IA escreve [[reagir:🙏🏼]] ou [[reagir:✅]] e o servidor reage à última mensagem do cliente (só esses dois emojis; nunca joinha).
const RE_REAGIR = /\[\[\s*reag(?:ir|e|ão|ao)\s*:\s*([^\]]*?)\s*\]\]/gi;
const emojiReacao = (e) => /🙏|bencao|benção|obrigad/i.test(String(e)) ? '🙏🏼' : /✅|✔|☑|👍|ok/i.test(String(e)) ? '✅' : '';
async function reagir(jid, emoji) {
  const e = emojiReacao(emoji); if (!e || !sock) return false;
  const ult = lerEsp(jid).filter(m => m.autor === 'cliente' && m.id && m.tipo !== 'reacao').pop();
  if (!ult || Date.now() - (ult.ts || 0) > 24 * 3600e3) return false;
  estado.reagidos = estado.reagidos || {}; if (estado.reagidos[jid] === ult.id) return false;   // uma reação por mensagem
  try { await sock.sendMessage(jid, { react: { text: e, key: { remoteJid: jid, fromMe: false, id: ult.id } } }); }
  catch (err) { log('reação não saiu', jid, err.message); return false; }
  estado.reagidos[jid] = ult.id; salvarEstado(); log('reagiu', e, jid);
  return e;
}
// ===== REVISOR ANTES DE ENVIAR (pedido do Djhonata, 16/11/2026) =====
// Os erros que mais tiram nota já têm regra escrita e continuam saindo: abrir com "Entendi"/"Faz sentido", cumprimentar de novo no meio da conversa
// e fazer duas ou três perguntas na mesma mensagem. O servidor confere a resposta pronta e conserta antes de ela ir para o cliente.
const RV_MAIUSC = (t) => t.replace(/^(\s*)(\p{Ll})/u, (m, e, c) => e + c.toUpperCase());
const RV_ABRE = /^(\s*)(?:entendi|entendo|compreendo|faz sentido(?: sim)?|certo,? entendi|perfeito,? entendi|ah,? entendi)(?:,?\s+\p{Lu}[\p{L}]{1,20})?\s*(?:[.!]+\s+|,\s+|\s*\n+)/iu;
const RV_OI = /^(\s*)(?:oi+|ol[áa]|opa|bom dia|boa tarde|boa noite)(?:,?\s+\p{Lu}[\p{L}]{1,20})?\s*[!,.]+\s*(?:tudo bem\??\s*)?/iu;
function revisorFixo(t, jaConversando) {   // consertos que não precisam da IA; devolve { texto, feitos }
  const feitos = [];
  const emPartes = (fn) => { t = t.replace(/(\[\[tts:)([\s\S]*?)(\]\])/g, (m, a, meio, z) => a + fn(meio) + z); if (!/^\s*\[\[tts:/.test(t)) t = fn(t); };
  const tira = (re, nome) => emPartes((x) => { const y = x.replace(re, '$1'); if (y !== x && y.trim().length >= 8) { if (!feitos.includes(nome)) feitos.push(nome); return RV_MAIUSC(y); } return x; });
  if (jaConversando) tira(RV_OI, 'cumprimento repetido');
  tira(RV_ABRE, 'abertura "entendi"');
  return { texto: t, feitos };
}
const rvPerguntas = (t) => (String(t).split('\n').filter(l => !RE_LINK_AGENDA.test(l) && !linhaDaAgenda(l)).join('\n').match(/\?/g) || []).length;
// Lê na resposta dela uma promessa de chamar depois ("te chamo no fim da tarde", "amanhã às 10h eu te chamo") ou um adiamento deixado na mão do cliente ("quando puder, me chama") e devolve quando chamar ('AAAA-MM-DDTHH:MM'), dentro do horário das rotinas. '' = nada a marcar.
function retornoDaFrase(t, agora) {
  const s = semAcento(String(t || '')).replace(/\s+/g, ' '), n = agora || agoraSP();
  const promete = /\b(te chamo|eu te chamo|te ligo|volto a te chamar|volto a falar (contigo|com voce))\b/.test(s);
  const solta = /\bquando (voce |tu |voces )?(achar|puder|puderem|tiver|tiverem|quiser|quiserem|decidir|decidirem)\b[^.?!]{0,70}\b(me chama|me chamem|me avisa|me fala|e so (me )?chamar)\b/.test(s);
  if (!promete && !solta) return '';
  // 24/11/2026 (caso James): "não vou chamar agora" é o contrário de prometer retorno
  if (/\bnao (?:vou|irei) (?:te |lhe )?(?:chamar|incomodar|ligar)\b|\bnao te chamo\b|\bnao (?:precisa|preciso) (?:te )?chamar\b/.test(s)) return '';
  const dia = (d) => { const x = new Date(n.getTime() + d * 864e5); return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0'); };
  const amanha = /\bamanha\b/.test(s); let d = amanha ? 1 : 0, h = -1, mi = 0;
  const ex = promete && /\b(?:as|a partir das|depois das|la pelas|pelas) (\d{1,2})(?:h|:| horas)(\d{2})?/.exec(s);
  if (ex) { h = Number(ex[1]); mi = Number(ex[2] || 0); }
  else if (solta && !promete) { d = 1; h = 10; }
  else if (/\b(fim|final) d[ae] tarde\b/.test(s)) { h = 17; mi = 30; }
  else if (/\b(a noite|de noite|hoje a noite|mais a noite)\b/.test(s)) h = 19;
  else if (/\bdepois do almoco\b/.test(s)) h = 14;
  else if (/\b(cedo|de manha|pela manha)\b/.test(s)) { h = 9; if (!amanha && n.getHours() >= 9) d = 1; }
  else if (/\b(a tarde|de tarde)\b/.test(s)) h = 14;
  else if (/\b(mais tarde|daqui a pouco|logo mais|ainda hoje)\b/.test(s)) { h = n.getHours() + 3; }
  else if (amanha) h = 10;
  else return '';
  if (h < 0 || h > 23) return '';
  const ini = minutos(ROT_INI), fim = minutos(ROT_FIM);
  // 24/11/2026 (caso Manoel): "te chamo depois das 18h" dito às 19h39 é amanhã depois das 18h, e não amanhã às 9h
  if (h * 60 + mi > fim) { d += 1; h = 9; mi = 0; }
  else if (d === 0 && h * 60 + mi <= n.getHours() * 60 + n.getMinutes() + 5) { d += 1; if (!ex) { h = 9; mi = 0; } }
  if (h * 60 + mi < ini) { h = Math.ceil(ini / 60); mi = 0; }
  if (new Date(n.getTime() + d * 864e5).getDay() === 0) d += 1;   // domingo não chama
  return dia(d) + 'T' + String(h).padStart(2, '0') + ':' + String(mi).padStart(2, '0');
}
async function revisarSaida(f, t) {
  try {
    if (!t || f.dono) return t;
    // Mensagem em dobro (16/11/2026): a mesma resposta, ou quase, que já saiu para este cliente nos últimos 4 minutos não sai de novo.
    try { const pal = (x) => new Set(semAcento(String(x)).replace(/\[\[tts:|\]\]/g, ' ').split(/[^a-z0-9]+/).filter(w => w.length >= 4));
      const A = pal(t); if (A.size >= 8 && !f.rotina) for (const m of lerEsp(f.jid).filter(m => m.autor === 'ia' && Date.now() - (m.ts || 0) < 4 * 60e3 && String(m.texto || '').length > 40).slice(-4)) { const B = pal(m.texto); let c = 0; for (const w of A) if (B.has(w)) c++; if (c / Math.max(1, Math.min(A.size, B.size)) >= 0.75) { log('revisor: mensagem em dobro segurada', f.telefone || f.jid); estado.revisor = estado.revisor || {}; const dia = agoraSP().toISOString().slice(0, 10); const d = estado.revisor[dia] = estado.revisor[dia] || {}; d['mensagem em dobro'] = (d['mensagem em dobro'] || 0) + 1; salvarEstado(); return ''; } } } catch (e) { }
    // Prometeu confirmar (16/11/2026): se ela disse "vou confirmar" e não registrou a dúvida, o servidor registra, para a pergunta aparecer na lista do CRM e ter resposta no dia.
    try { const pm = /[^.!?\n]*\b(?:vou|deixa eu|preciso) (?:confirmar|verificar|checar|conferir|ver (?:isso|certinho|com))[^.!?\n]*|[^.!?\n]*\bj[áa] te (?:falo|retorno|confirmo|aviso)\b[^.!?\n]*/i.exec(t);
      if (pm && !f.rotina && !(estado.avisos || []).some(a => a.jid === f.jid && a.tipo === 'duvida' && !a.feito && Date.now() - (a.ts || 0) < 6 * 3600e3)) { const uc = lerEsp(f.jid).filter(m => m.autor === 'cliente' && String(m.texto || '').trim()).pop();
        estado.avisos = [...(estado.avisos || []), { id: 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), ts: Date.now(), jid: f.jid, nome: f.nome || '', telefone: f.telefone || '', texto: ('Ela prometeu confirmar e não anotou a dúvida. O que ela disse: "' + pm[0].trim().slice(0, 220) + '". Última mensagem do cliente: "' + String((uc || {}).texto || '').replace(/\s+/g, ' ').slice(0, 220) + '"').slice(0, 600), tipo: 'duvida', auto: true }].slice(-80); salvarEstado(); log('revisor: promessa de confirmar anotada para o CRM', f.telefone || f.jid); } } catch (e) { }
    // Retorno prometido sem marcar (17/11/2026, caso da Elaine: "te chamo no fim da tarde" e ninguém chamou; e da Daiane: "quando achar um horário, me chama"). Se ela prometeu chamar, ou deixou para o cliente chamar, e não usou agendar_retorno, o servidor marca o retorno.
    try { if (!f.rotina && !(estado.retornos || {})[f.jid] && !(estado.visitas || {})[f.jid]) { const q = retornoDaFrase(t); if (q) { estado.retornos = estado.retornos || {}; estado.retornos[f.jid] = { q, assunto: 'Retorno marcado pelo servidor: ela disse "' + String(t).replace(/\s+/g, ' ').slice(0, 140) + '"', criado: Date.now(), auto: true }; salvarEstado(); log('revisor: retorno marcado pelo servidor', f.telefone || f.jid, q); } } } catch (e) { }
    // 24/11/2026 (Djhonata, caso Maxsuéli): (1) "no escritório quem te atende sou eu mesmo" confunde: quem atende é o Djhonata.
    // (2) cliente disse "vou ver com ele e te retorno" (sem perguntar nada): agradece e espera, sem empurrar horário.
    try { if (!f.rotina) {
      t = String(t).replace(/(quem (?:te )?atende) (?:sou eu(?: mesm[oa])?|[ée] (?:eu|comigo)(?: mesm[oa])?)/gi, '$1 é o próprio Djhonata');
      const l = lerEsp(f.jid), fala = []; for (let i = l.length - 1; i >= 0 && fala.length < 4; i--) { const m = l[i]; if (m.autor === 'aviso' || m.tipo === 'reacao') continue; if (m.autor === 'cliente') fala.push(String(m.texto || '')); else break; }   // 24/11/2026: o texto do áudio transcrito está em m.texto (m.transc é só a marca)
      const cli = semAcento(fala.join(' ').toLowerCase());
      if (cli && /\b(vou ver com|vou falar com|vou conversar com|vejo com|vou ver aqui e|te retorno|te dou um retorno|te dou retorno|te aviso|te falo|retorno pra voce|retorno para voce)/.test(cli) && !/\?|que horas|qual horario|horario/.test(cli) && /\b\d{1,2}h\b|\bas \d{1,2}\b/.test(semAcento(String(t).toLowerCase()))) {
        t = 'Combinado ✅ Fico no aguardo do seu retorno. Qualquer dúvida, é só me chamar.'; log('revisor: cliente vai dar retorno, horário segurado', f.telefone || f.jid);
      }
      // 24/11/2026 (Djhonata, caso Joseane: "esse valor dá pra fazer direto com a construtora?"): pergunta sobre o PAGAMENTO do imóvel. Direto com a
      // construtora fica só a entrada; o restante é pela Caixa. Se a IA responder sem falar do financiamento ("é direto com a gente"), sai a resposta certa.
      // Pergunta sobre com quem é a NEGOCIAÇÃO (sem falar de valor, pagar, parcelar ou financiar) não passa por aqui.
      if (cli && /\bdiret[oa] (?:com|na|pela|c\/)\s?(?:a |o )?construtora\b/.test(cli) && /\b(valor|pagar|pagamento|parcel\w*|financ\w*|prestac\w*|sem (?:o )?banco)\b/.test(cli) && !/\b(comprei|compramos|fechei|fechamos)\b/.test(cli)) {
        const st = semAcento(String(t).toLowerCase());
        if (f._direto) { if (/direto com a gente|intermediari|nao paga comissao/.test(st)) return ''; }
        else if (!/caixa|banco|financiamento|financiad/.test(st)) { f._direto = true; t = 'Direto com a construtora fica só a entrada. O restante é financiado pela Caixa: todo imóvel nosso passa pelo financiamento em algum momento. Quer que eu te mostre como fica a entrada?'; log('revisor: pagamento direto com a construtora, resposta corrigida', f.telefone || f.jid); }
      } } } catch (e) { }
    if (/📋/.test(t)) return t;
    const ja = jaFalouCom(f.jid), conversando = !!(ja && Date.now() - (ja.ts || 0) < 6 * 3600e3);
    const r = revisorFixo(t, conversando); let novo = r.texto; const feitos = r.feitos.slice();
    if (rvPerguntas(novo) >= 2) {
      try {
        const sis = 'Você revisa uma mensagem de WhatsApp escrita por um corretor de imóveis para um cliente. Reescreva a mensagem mantendo o mesmo conteúdo, o mesmo tom, as mesmas palavras sempre que possível e todas as marcações exatamente como estão ([[tts:...]], linhas com ---, links, emojis, quebras de linha). A única mudança: ela tem de terminar com UMA única pergunta, a que mais faz a conversa andar (normalmente a última). As outras perguntas saem ou viram uma afirmação curta. Não acrescente informação, não explique nada e não use aspas. Responda só com a mensagem reescrita.';
        const rr = String(await claudeTexto(sis, novo, 1500, 0) || '').trim();
        const mesmasMarcas = (a, b) => ['[[tts:', '---', 'http'].every(m => (a.split(m).length === b.split(m).length));
        if (rr && rvPerguntas(rr) === 1 && rr.length > novo.length * 0.55 && rr.length < novo.length * 1.15 && mesmasMarcas(novo, rr) && !/^NO_REPLY/.test(rr)) { novo = rr; feitos.push('uma pergunta só'); }
      } catch (e) { log('revisor: não deu para reescrever as perguntas', e.message); }
    }
    if (feitos.length) { log('revisor consertou', f.telefone || f.jid, feitos.join(' + ')); estado.revisor = estado.revisor || {}; const dia = agoraSP().toISOString().slice(0, 10); const d = estado.revisor[dia] = estado.revisor[dia] || {}; for (const k of feitos) d[k] = (d[k] || 0) + 1; for (const k of Object.keys(estado.revisor)) if (k < new Date(Date.now() - 15 * 864e5).toISOString().slice(0, 10)) delete estado.revisor[k]; salvarEstado(); }
    return novo;
  } catch (e) { log('revisor', e.message); return t; }
}
// 23/11/2026 (Djhonata): nada de diminutivo na fala dele ("certinho", "juntinho"). A regra está no REGRAS-ATENDIMENTO; aqui é a rede de segurança para texto e áudio.
const DIMINUTIVOS = [['restinhos', 'restos'], ['restinho', 'resto'], ['restinha', 'resta'], ['tempinho', 'tempo'], ['esperadinha', 'esperada'], ['seguradinha', 'segurada'], ['certinhos', 'certos'], ['certinhas', 'certas'], ['certinho', 'certo'], ['certinha', 'certa'], ['juntinhos', 'juntos'], ['juntinhas', 'juntas'], ['juntinho', 'junto'], ['juntinha', 'junta'], ['rapidinho', 'rápido'], ['rapidinha', 'rápida'], ['pertinho', 'perto'], ['pouquinho', 'pouco'], ['direitinho', 'direito'], ['prontinho', 'pronto'], ['prontinha', 'pronta'], ['minutinhos', 'minutos'], ['minutinho', 'minuto'], ['horinha', 'hora'], ['olhadinha', 'olhada'], ['passadinha', 'passada'], ['ajudinha', 'ajuda'], ['cedinho', 'cedo'], ['baratinho', 'barato'], ['baratinha', 'barata'], ['parcelinhas', 'parcelas'], ['parcelinha', 'parcela'], ['valorzinho', 'valor'], ['casinha', 'casa'], ['tranquilinho', 'tranquilo'], ['devagarinho', 'devagar'], ['agorinha', 'agora'], ['momentinho', 'momento'], ['instantinho', 'instante'], ['segundinho', 'segundo'], ['bonitinho', 'bonito'], ['bonitinha', 'bonita'], ['novinho', 'novo'], ['novinha', 'nova'], ['lindinha', 'linda'], ['lindinho', 'lindo'], ['precinho', 'preço'], ['conversinha', 'conversa'], ['perguntinha', 'pergunta'], ['detalhezinho', 'detalhe'], ['tudinho', 'tudo'], ['obrigadinho', 'obrigado']];
// 24/11/2026 (pente fino do Djhonata): rascunho de pendência saiu com "[DADO: ...]", com dia que já passou ("quarta, dia 18") e falando do Djhonata em terceira pessoa.
// Texto assim não sai: volta com o motivo para ser ajustado.
function problemaNoRascunho(t) {
  t = String(t || '');
  const marca = /\[(?:DADO|dado)[^\]]*\]|\[\[(?!tts:|cita:|reagir:)[^\]]*\]\]/.exec(t); if (marca) return `Não enviei: o texto tem uma marcação que não pode ir para o cliente (${marca[0].slice(0, 60)}). Ajuste e envie de novo.`;
  if (falaEmTerceira(t)) return 'Não enviei: o texto fala do Djhonata como se fosse outra pessoa ("confirmo com o Djhonata"). Quem fala com o cliente é o próprio Djhonata. Ajuste e envie de novo.';
  const agora = new Date(Date.now() - 3 * 3600e3), hojeN = agora.getUTCFullYear() * 10000 + (agora.getUTCMonth() + 1) * 100 + agora.getUTCDate();
  const SEM = { domingo: 0, segunda: 1, 'terça': 2, terca: 2, quarta: 3, quinta: 4, sexta: 5, 'sábado': 6, sabado: 6 };
  let m; const re1 = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/g;
  while ((m = re1.exec(t))) {
    const d = +m[1], mes = +m[2]; if (!d || d > 31 || !mes || mes > 12) continue;
    let ano = m[3] ? (+m[3] < 100 ? 2000 + +m[3] : +m[3]) : agora.getUTCFullYear(); if (!m[3] && mes < agora.getUTCMonth() + 1 - 6) ano++;
    if (ano * 10000 + mes * 100 + d < hojeN && ano * 10000 + mes * 100 + d > hojeN - 10000) {
      const antes = t.slice(Math.max(0, m.index - 40), m.index).toLowerCase();
      if (/(visita|escrit[óo]rio|hor[áa]rio|às|segunda|terça|terca|quarta|quinta|sexta|s[áa]bado|domingo|amanh[ãa]|hoje)\W*$/.test(antes) || /\b(segunda|terça|terca|quarta|quinta|sexta|s[áa]bado|domingo)\b/.test(antes)) return `Não enviei: o texto oferece uma data que já passou (${m[0]}). Ajuste e envie de novo.`;
    }
  }
  const re2 = /\b(domingo|segunda|ter[çc]a|quarta|quinta|sexta|s[áa]bado)(?:-feira)?,?\s*(?:dia\s*)?(\d{1,2})\b(?!\s*\/)/gi;
  while ((m = re2.exec(t))) {
    const sem = SEM[m[1].toLowerCase()], d = +m[2]; if (sem === undefined || !d || d > 31) continue;
    const cand = new Date(Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth(), d));
    if (cand.getUTCMonth() === agora.getUTCMonth() && cand.getUTCDay() === sem && d < agora.getUTCDate()) return `Não enviei: o texto oferece um dia que já passou (${m[0]}). Ajuste e envie de novo.`;
  }
  return '';
}
function semDiminutivo(t) {
  let s = String(t || '');
  for (const [a, b] of DIMINUTIVOS) s = s.replace(new RegExp('(?<![\\p{L}])' + a + '(?![\\p{L}])', 'giu'), (m) => m[0] === m[0].toUpperCase() ? b[0].toUpperCase() + b.slice(1) : b);
  return s;
}
async function enviarSaida(jid, texto, autor = 'ia', extra) {   // devolve o que saiu (para a memória da conversa)
  const feitos = [];
  { let pedida = null; texto = String(texto || '').replace(RE_REAGIR, (m, e) => { if (!pedida) pedida = e; return ''; }).replace(/\n{3,}/g, '\n\n');
    if (pedida && autor === 'ia') { const r = await reagir(jid, pedida); if (r) feitos.push('[[reagir:' + r + ']]'); }
    if (!String(texto).trim()) return feitos; }
  if (autor === 'ia') texto = semDiminutivo(generoDoDono(texto));
  texto = String(texto).replace(/\*\*([^*\n]+)\*\*/g, '*$1*');   // 24/11/2026: "**negrito**" (Markdown) chegava ao cliente com asterisco sobrando
  // 24/11/2026 (caso Ivonildes): marcação interna da IA ("[[bloco da simulação]]") chegou ao cliente como texto. Só [[tts:]], [[cita:]] e [[reagir:]] valem; o resto sai.
  if (autor === 'ia') { texto = String(texto).replace(/\[\[(?!tts:|cita:|reagir:)[^\]\n]{0,80}\]\]/gi, '').replace(/\n{3,}/g, '\n\n'); if (!texto.trim()) return feitos; }
  const proprio = String(texto || '').split('\n').filter(l => !RE_LINK_AGENDA.test(l) && !linhaDaAgenda(l)).join('\n');   // o texto da IA sem o bloco da agenda
  for (const p of partesResposta(String(texto || ''))) {
    if (p.tipo === 'audio') {
      p.t = String(p.t).replace(new RegExp(RE_CITA.source, 'gi'), '').trim();
      const ok = await enviarAudio(jid, p.t, autor, extra);
      if (ok === true) { feitos.push('[[tts:' + p.t + ']]'); continue; }   // na memória fica com a marcação certa, para a IA não aprender outra
      if (ok === 'barrado') continue;
    }
    let citaPend = '';   // [[cita:...]] sozinho numa linha vale para o pedaço seguinte
    for (const parte of p.t.split(/\n\s*---\s*\n/)) for (const sub0 of separarFluxo(parte)) for (const sub of separarAgenda(sub0)) {
      let s = sub.replace(/^\s*---\s*$/gm, '').trim(); if (!s) continue;
      if (!s.replace(new RegExp(RE_CITA.source, 'gi'), '').trim()) { citaPend = (RE_CITA.exec(s) || [])[0] || ''; continue; }
      if (citaPend) { if (!RE_CITA.test(s)) s = citaPend + ' ' + s; citaPend = ''; }
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

// 24/11/2026 (pente fino nos clientes): resposta automática de conta comercial ("Rezende Material de Construção agradece sua mensagem. Não estamos
// disponíveis no momento.", "Studio X agradece seu contato. Como podemos ajudar?") não é o cliente falando: não conta como "voltou a conversar",
// não marca o follow-up como respondido e a assistente não responde. O texto chega aqui já sem acento.
const RE_RESPOSTA_AUTO = /\bagradece (?:a |o )?(?:sua|seu) (?:mensagem|contato)|\bnao estamos em horario de atendimento|\bfora do (?:nosso )?horario de atendimento|\bmensagem automatica\b|\bbem[- ]vind[oa](?:\(a\))? ao nosso atendimento|\b(?:retornaremos|responderemos) (?:assim que|o mais breve|em breve|o quanto antes)|\bassim que possivel (?:retornaremos|responderemos)/;
// fila por conversa: junta as mensagens do cliente e responde depois de alguns segundos de silêncio
const filas = new Map();

async function aoReceber(m, tipoUpsert) {
  const jid = m.key.remoteJid || '';
  if (!jidValido(jid)) return;
  const cifrada = !m.message && m.messageStubType === 2;   // chegou cifrada e ainda não foi decifrada
  const x = desembrulhar(m);
  // 16/11/2026 (Djhonata): cliente que reagiu a uma mensagem também interagiu: o follow-up pronto dele não sai (e o enviado conta como respondido)
  if (x.reactionMessage && !m.key.fromMe && x.reactionMessage.text) { try { const tel = String((chats[jid] || {}).telefone || '').replace(/\D/g, ''); fuClienteFalou(jid, tel, Math.floor(tsDe(m) / 1000) * 1000); estado.reacoesCli = estado.reacoesCli || {}; estado.reacoesCli[jid] = tsDe(m); salvarEstado(); } catch (e) { } }
  if (x.protocolMessage || x.reactionMessage || (x.senderKeyDistributionMessage && Object.keys(x).length === 1)) return;
  const texto = cifrada ? '🔒 (mensagem ainda não decifrada — veja no celular)' : textoDe(x);
  const tipo = tipoDe(x);
  const ts = tsDe(m);
  // "append" = o WhatsApp entregou atrasado o que chegou enquanto a conexão caía e voltava (ou o servidor reiniciava)
  const atrasada = tipoUpsert === 'append';
  const recente = Date.now() - ts < (atrasada ? JANELA_ATRASADA : 180e3);
  const telefone = telefoneDe(m);
  const autoResp = !m.key.fromMe && !cifrada && RE_RESPOSTA_AUTO.test(semAcento(texto || ''));   // 24/11/2026: resposta automática de conta comercial
  if (!m.key.fromMe && !cifrada && tipoUpsert !== 'historico') marcarOrigem(jid, x, texto, ts);
  if (!m.key.fromMe && tipoUpsert === 'notify' && !x.reactionMessage && !autoResp && (chats[jid] || {}).arquivado) setTimeout(() => arquivarChat(jid, false).then(() => log('desarquivada: o cliente escreveu de novo', tel8Chat(jid))).catch(e => log('desarquivar', e.message)), 2500);

  // espelho: grava tudo (menos o que a própria ponte já gravou ao enviar)
  if (!(m.key.fromMe && enviados.has(m.key.id))) {
    let midia = null;
    if (tipo !== 'text' && tipo !== 'contact' && tipo !== 'location' && recente) midia = await guardarMidia(m, x, tipo);
    m._midia = midia;
    registrarEspelho(jid, {
      id: m.key.id, autor: m.key.fromMe ? 'celular' : 'cliente', tipo, texto,
      arquivo: midia ? midia.arquivo : undefined, nomeArquivo: x.documentMessage ? x.documentMessage.fileName : undefined,
      nome: m.key.fromMe ? undefined : (m.pushName || undefined), telefone: telefone || undefined, ts, auto: autoResp || undefined
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
    // 26/11/2026 (Djhonata): #zerar escrito pelo WhatsApp da Euro numa conversa = a assistente esquece tudo dessa conversa e atende como cliente novo (para testar o atendimento do zero)
    if (/^#zerar\b/i.test(texto.trim())) { esquecerConversa(jid); filas.delete(jid); quitarResposta(jid); delete estado.pausas[jid]; salvarEstado(); emitir('chat', chatPublico(jid)); log('conversa zerada pelo #zerar', jid); return; }
    if (texto || tipo !== 'text') anotar(jid, 'assistant', `(Djhonata escreveu) ${texto || (m._transc ? '[mandou um áudio] ' + m._transc : '[' + tipo + ']')}`);
    if (PAUSA_HORAS > 0) { estado.pausas[jid] = Date.now() + PAUSA_HORAS * 3600e3; salvarEstado(); filas.delete(jid); emitir('chat', chatPublico(jid)); }
    return;
  }
  if (tipoUpsert !== 'notify' && !atrasada) return;

  const dono = telefone && normal(telefone) === normal(DONO);
  if (!dono && telefone && lerBloqueados().has(normal(telefone))) { log('bloqueado, ignorado', telefone); return; }
  if (autoResp && !dono) { log('resposta automática de conta comercial: não conta como conversa', telefone || jid); return; }
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
  try { const cit = textoCitado(x); if (cit) entrada = `[${quemFala === 'do cliente' ? 'o cliente' : 'o Djhonata'} respondeu citando esta mensagem da conversa: "${cit}"]\n` + entrada; } catch (e) { }
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
let adsMapa = lerJson(ADS_ARQ, null) || {};
const AVAL_ARQ = path.join(DADOS, 'avaliacoes.json');   // 26/11/2026: avaliação da Caixa por imóvel, gravada pelo CRM
let avalRef = lerJson(AVAL_ARQ, null) || {};
function avalDaRef(pasta) { const m = /\(ref (\d+)/.exec(String(pasta || '')); return (m && Number(avalRef[m[1]])) || 0; }   // { código do anúncio: { nome, pasta, generico, em } }
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
// 23/11/2026 (Djhonata, caso Mauro): o cliente respondeu citando uma mensagem ("Esse aqui" em cima da oferta). A assistente precisa saber qual foi.
function textoCitado(x) {
  for (const k of Object.keys(x || {})) {
    const ci = x[k] && typeof x[k] === 'object' ? x[k].contextInfo : null, q = ci && ci.quotedMessage; if (!q) continue;
    const t = q.conversation || (q.extendedTextMessage && q.extendedTextMessage.text) || (q.imageMessage && q.imageMessage.caption) || (q.videoMessage && q.videoMessage.caption) || (q.documentMessage && (q.documentMessage.caption || q.documentMessage.fileName)) || (q.imageMessage ? '(uma foto, sem legenda)' : q.videoMessage ? '(um vídeo, sem legenda)' : q.audioMessage ? '(um áudio)' : '');
    const txt = String(t || '').replace(/\s+/g, ' ').trim().slice(0, 400); if (txt) return txt;
  }
  return '';
}
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
// ---------- ENSAIO (26/11/2026, Djhonata): roda uma conversa inventada pela assistente, com as regras e ferramentas de verdade, sem mandar nada no WhatsApp ----------
let ensaio = { rodando: false, saida: [] };
const ENSAIO_LEITURA = new Set(['ler_ficha', 'simular_fluxo', 'distancia', 'imoveis_perto', 'fipe_veiculo']);
async function ensaioFerramenta(nome, entrada, ctx) {
  if (nome === 'ler_regra') return lerRegraDemanda(entrada || {});
  if (nome === 'enviar_arquivo' && ctx.demanda) { const c = String((entrada || {}).caminho || ''); if (/\.mp4$/i.test(c)) { ctx.videos = ctx.videos || new Set(); if (ctx.videos.has(c)) return 'Esse vídeo já foi enviado nesta conversa: não mande de novo. Siga a conversa só com texto.'; ctx.videos.add(c); } }
  if (ENSAIO_LEITURA.has(nome)) return executar(nome, entrada, ctx);
  // 26/11/2026: no ensaio a resposta tem que ser igual à de verdade; antes dizia "nada saiu de verdade" e a IA achava que o vídeo tinha falhado
  if (nome === 'enviar_arquivo') return 'Enviado.';
  if (nome === 'agenda_visita') return /consult|livre|ver/i.test(String((entrada || {}).acao || '')) ? 'Horários livres nesse dia: 9h, 10h, 13h, 14h, 15h, 16h e 17h.' : 'Horário livre e marcado na agenda. Confirme ao cliente.';
  if (nome === 'mandar_ao_cliente') return 'Enviado.';
  return 'Feito.';
}
async function rodarEnsaio(p) {
  const jid = 'ensaio' + Date.now() + '@s.whatsapp.net';
  const ctx = { jid, telefone: '', nome: String(p.nome || ''), dono: false, notas: [], audioAgora: !!p.audio, rotina: '', ensaio: true };
  if (p.alt) { ctx.regrasAlt = {}; for (const f of ARQS_REGRAS) { try { ctx.regrasAlt[f] = fs.readFileSync(path.join(REGRAS_TESTE, f), 'utf8'); } catch (e) { } } ensaio.alt = Object.keys(ctx.regrasAlt); }
  let ferr = FERRAMENTAS;   // 26/11/2026: teste das regras sob demanda (só o título de cada melhoria vai junto; o texto ela lê com ler_regra)
  if (p.demanda) { ctx.regrasAlt = Object.assign(ctx.regrasAlt || {}, { 'MELHORIAS-APROVADAS.md': indiceDemanda() }); ferr = FERRAMENTAS.concat([FERR_LER_REGRA]); ensaio.demanda = true; ctx.demanda = true; }
  const system = sistema(ctx), messages = [];
  for (const m of p.msgs.slice(0, 30)) {
    const txt = String(m); ensaio.saida.push({ autor: 'cliente', texto: txt });
    const ult = messages[messages.length - 1];
    if (ult && ult.role === 'user') ult.content.push({ type: 'text', text: txt }); else messages.push({ role: 'user', content: [{ type: 'text', text: txt }] });
    for (let volta = 0; volta < 9; volta++) {
      const resp = await claude(system, messages, ferr);
      { const u = resp.usage || {}; (ensaio.tokens = ensaio.tokens || []).push((u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0)); ensaio.custo = Math.round(((ensaio.custo || 0) + custoUso(u)) * 1e4) / 1e4; }
      messages.push({ role: 'assistant', content: (resp.content || []).length ? resp.content : [{ type: 'text', text: '(sem resposta)' }] });
      const resultados = [];
      for (const bl of resp.content || []) {
        if (bl.type === 'text') { const t = tirarMarcacao(bl.text || ''); if (t && !/^NO_REPLY\b/.test(t)) ensaio.saida.push({ autor: 'ia', texto: t }); }
        else if (bl.type === 'tool_use') {
          const r = await ensaioFerramenta(bl.name, bl.input || {}, ctx);
          ensaio.saida.push({ autor: 'ferramenta', texto: bl.name + ' ' + JSON.stringify(bl.input || {}).slice(0, 300) + ' => ' + String(r).slice(0, 400) });
          resultados.push({ type: 'tool_result', tool_use_id: bl.id, content: String(r).slice(0, 20000) });
        }
      }
      if (!resultados.length) break;
      messages.push({ role: 'user', content: resultados });
    }
  }
}

// ---------- CONSOLIDAÇÃO DAS REGRAS (26/11/2026, Djhonata): versão enxuta SÓ DE TESTE do MELHORIAS-APROVADAS ----------
// Nada muda no atendimento: a versão vai para dados/regras-teste e só é usada no ensaio com alt: true. Só entra no ar com { aplicar: true }, com cópia antes.
const REGRAS_TESTE = path.join(DADOS, 'regras-teste'), CONS_MODELO = ENV.MODELO_CONSOLIDAR || 'claude-opus-5-5';
let consolidacao = { rodando: false };
const FERR_LER_REGRA = { name: 'ler_regra', description: 'Lê o texto completo das regras aprovadas pelo Djhonata sobre um assunto. Chame ANTES de responder sempre que a conversa tocar num assunto da lista de títulos (entrada, sinal, simulação, parcela, FGTS, visita, agenda, horário, fotos, vídeo, objeção, nome, outra cidade, casal, permuta, crédito aprovado etc.). Pode passar várias palavras ou os números [R..] da lista.', input_schema: { type: 'object', properties: { assunto: { type: 'string' } }, required: ['assunto'] } };
function tirarMarcacao(t) { return String(t || '').replace(/<\/?(?:antml:)?(?:invoke|parameter|function_calls)\b[^>]*>/g, '').replace(/\n{3,}/g, '\n\n').trim(); }
function regrasDemanda() { return enxBlocos(lerTexto('MELHORIAS-APROVADAS.md')).filter(b => b.regra).map((b, i) => ({ id: 'R' + i, titulo: enxTitulo(b.texto), texto: b.texto })); }
function indiceDemanda() {
  return 'REGRAS APROVADAS PELO DJHONATA (valem tanto quanto as regras principais e, quando são mais novas, valem acima delas). Aqui vai só o TÍTULO de cada uma. Antes de responder, chame ler_regra com o assunto da mensagem do cliente (pode chamar mais de uma vez) e siga o texto completo que voltar.\n' + regrasDemanda().map(r => `- [${r.id}] ${r.titulo}`).join('\n');
}
function lerRegraDemanda(e) {
  const rs = regrasDemanda(), q = semAcento(String(e.assunto || '')).toLowerCase();
  const ids = q.match(/r\d+/g) || [], pal = q.split(/[^a-z0-9]+/).filter(w => w.length > 3);
  const pont = rs.map(r => { const tt = semAcento(r.titulo).toLowerCase(), tx = semAcento(r.texto).toLowerCase(); let s = ids.includes(r.id.toLowerCase()) ? 100 : 0; for (const w of pal) { if (tt.includes(w)) s += 5; else if (tx.includes(w)) s += 1; } return { r, s }; }).filter(x => x.s > 0).sort((a, b) => b.s - a.s).slice(0, 6);
  if (!pont.length) return 'Nenhuma regra com esse assunto. Siga as regras principais.';
  let out = ''; for (const { r } of pont) { if (out.length > 9000) break; out += `[${r.id}] ${r.texto}\n\n`; }
  return out;
}
async function regrasConsolidar() {
  const f = 'MELHORIAS-APROVADAS.md', txt = lerTexto(f), principais = lerTexto('REGRAS-ATENDIMENTO.md');
  if (txt.length < 5000) throw new Error('arquivo vazio');
  const partes = []; let cur = '';
  for (const b of enxBlocos(txt)) { if (cur.length + b.texto.length > 26000 && cur.trim()) { partes.push(cur); cur = ''; } cur += b.texto + '\n'; }
  if (cur.trim()) partes.push(cur);
  consolidacao.total = partes.length; consolidacao.feitas = 0; consolidacao.mantidas = [];
  const sis = `Você reescreve UMA PARTE do arquivo MELHORIAS-APROVADAS.md (regras da assistente de WhatsApp do corretor de imóveis Djhonata, da Euro Consultoria) para ficar MAIS CURTA SEM MUDAR NADA DO COMPORTAMENTO dela. O corretor prefere pagar mais caro a perder qualquer regra.
1. MANTENHA toda instrução que ainda vale: cada ação, ordem de passos, número, valor, percentual, prazo, horário, nome de ferramenta (simular_fluxo, agenda_visita, enviar_arquivo, registrar_crm etc.), status do CRM, exceção, condição ("só se", "nunca", "sempre"), frase de exemplo que a assistente deve usar (entre aspas, igual) e frase proibida.
2. PODE TIRAR: histórico e justificativa ("caso da cliente X", "sugerida pela avaliação das conversas de...", "revisada com ele contra as regras novas", "escrito por ele no CRM"), repetição dentro da mesma regra, listas do tipo "reforça X, Y e Z", e exemplos de erro longos (deixe no máximo um exemplo curto do erro, se ajudar).
3. Regra INTEIRAMENTE substituída por outra mais nova (do arquivo completo ou das regras principais), que diz o oposto ou já contém tudo dela: troque por uma linha "- (saiu: TÍTULO; vale TÍTULO DA NOVA)". Se a mais nova muda só uma parte, mantenha a parte que ainda vale. Na dúvida, MANTENHA a regra inteira.
4. Mantenha o TÍTULO EM MAIÚSCULAS de cada regra e a data entre parênteses, curta (ex.: "(Djhonata, 23/11/2026)"), porque outras regras citam pelo título e a data decide qual vale. Mantenha também "vale acima de TAL" quando existir, de forma curta.
5. Mantenha a ordem, os títulos de seção (#) e o formato: cada regra começa com "- " numa linha nova.
6. Não invente regra, não junte com regras de outras partes, não mude o sentido, não use diminutivos.
Responda SÓ com o texto reescrito da parte, sem comentário antes ou depois.

===== REGRAS PRINCIPAIS (REGRAS-ATENDIMENTO.md), só para consulta =====
${principais}

===== ARQUIVO COMPLETO MELHORIAS-APROVADAS.md, só para consulta =====
${txt}`;
  const saida = [];
  for (let i = 0; i < partes.length; i++) {
    let novo = '';
    try {
      const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, body: jsonLimpo({ model: CONS_MODELO, max_tokens: 16000, system: [{ type: 'text', text: sis, cache_control: { type: 'ephemeral' } }], messages: [{ role: 'user', content: `Reescreva só esta parte (${i + 1} de ${partes.length}):\n\n${partes[i]}` }] }), signal: AbortSignal.timeout(9 * 60e3) });
      if (!r.ok) throw new Error('API ' + r.status + ' ' + (await r.text()).slice(0, 200));
      const j = await r.json(); if (j.usage) registrarUso(j.usage);
      novo = (j.content || []).map(x => x.text || '').join('').trim();
      if (j.stop_reason === 'max_tokens') novo = '';
    } catch (e) { log('consolidação parte', i + 1, e.message); novo = ''; }
    if (!novo || novo.length < partes[i].length * 0.2 || novo.length > partes[i].length * 1.05) { novo = partes[i].trim(); consolidacao.mantidas.push(i + 1); }   // deu errado: fica a parte original
    saida.push(novo); consolidacao.feitas = i + 1;
  }
  const final = saida.join('\n\n') + '\n';
  fs.mkdirSync(REGRAS_TESTE, { recursive: true }); fs.writeFileSync(path.join(REGRAS_TESTE, f), final);
  return { antes: txt.length, depois: final.length, partes: partes.length, mantidas: consolidacao.mantidas, quando: Date.now() };
}

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
  const todas = lerConv(jid), h = todas.slice(-24);   // 18/11/2026 (Djhonata): 24 últimas mensagens (era 40); das mais antigas vai só o que o cliente disse, encurtado
  const antigas = todas.slice(-80, -24).filter(it => it.role !== 'assistant').map(it => String(it.texto || '').replace(/\s+/g, ' ').slice(0, 160)).filter(Boolean);
  const msgs = [];
  for (const it of h) {
    const role = it.role === 'assistant' ? 'assistant' : 'user';
    const txt = role === 'assistant' ? String(it.texto || '').replace(/^\[áudio\] (.*)$/gm, '[[tts:$1]]') : it.texto;   // áudios guardados no formato antigo
    if (msgs.length && msgs[msgs.length - 1].role === role) msgs[msgs.length - 1].content[0].text += '\n' + txt;
    else msgs.push({ role, content: [{ type: 'text', text: txt }] });
  }
  // 23/11/2026 (Djhonata, caso Mauro): quando a memória começa com mensagem NOSSA (oferta do CRM, follow-up), ela era cortada aqui e a assistente
  // não sabia o que o cliente tinha acabado de receber ("tem foto por dentro?" -> "qual imóvel?"). Agora o que foi mandado antes vai junto, como contexto.
  let antesNosso = '';
  while (msgs.length && msgs[0].role !== 'user') { antesNosso += (antesNosso ? '\n' : '') + msgs[0].content[0].text; msgs.shift(); }
  if (antesNosso && msgs.length) msgs[0].content[0].text = `(Contexto: antes da mensagem abaixo, VOCÊ mandou a este cliente o seguinte. Se ele pedir fotos, valor ou entrada, ou disser "esse", sem dizer o nome, é sobre isto.)\n${antesNosso.slice(-3000)}\n\n(Mensagem do cliente:)\n` + msgs[0].content[0].text;
  if (antigas.length && msgs.length) { let r = antigas.join(' | '); if (r.length > 1500) r = '…' + r.slice(-1500); msgs[0].content[0].text = `(Mensagens mais antigas desta pessoa, encurtadas, só para contexto: ${r})\n\n` + msgs[0].content[0].text; }
  if (rotina) {   // rotina automática (lembrete/retomada): instrução do sistema no fim, como última "mensagem"
    if (msgs.length && msgs[msgs.length - 1].role === 'user') msgs[msgs.length - 1].content[0].text += '\n\n' + rotina;
    else msgs.push({ role: 'user', content: [{ type: 'text', text: rotina }] });
  }
  if (!msgs.length || msgs[msgs.length - 1].role !== 'user') msgs.push({ role: 'user', content: [{ type: 'text', text: '(sem mensagem nova)' }] });
  const ult = msgs[msgs.length - 1];
  for (const im of imagens.slice(-3)) ult.content.unshift({ type: 'image', source: { type: 'base64', media_type: im.mime, data: im.data } });
  return msgs;
}

// 22/11/2026: emoji cortado no meio (metade de um par UTF-16) quebrava o JSON da API ("unexpected end of hex escape") e o cliente ficava sem resposta
function jsonLimpo(o) {
  return JSON.stringify(o).replace(/(^|[^\\])((?:\\\\)*)\\u(d[89ab][0-9a-f]{2})(?!\\ud[c-f][0-9a-f]{2})/gi, '$1$2').replace(/(^|[^\\])((?:\\\\)*)(\\ud[89ab][0-9a-f]{2})?\\u(d[c-f][0-9a-f]{2})/gi, (m, a, b, alto) => alto ? m : a + b);
}
async function claude(system, messages, ferramentas = FERRAMENTAS) {
  for (let tentativa = 0; tentativa < 3; tentativa++) {
    let r;
    try {
      r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        // a IA pensa antes de responder: 1500 era pouco e às vezes acabava só pensando (max_tokens)
        body: jsonLimpo({ model: MODELO, max_tokens: 4000, system, tools: ferramentas, messages })
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
  // chamadas que passaram de 100 mil tokens de entrada (pagam 5x) e a maior entrada do dia: para ver no status se as instruções voltaram a estourar
  { const ent = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0); if (ent > PRECO_IA.limite) d.acima100k = (d.acima100k || 0) + 1; d.maiorEntrada = Math.max(d.maiorEntrada || 0, ent); d.ultimaEntrada = ent; }
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
const AVISO_INTERNO = ' O cliente não sabe desse aviso: para ele, quem está falando é você, o Djhonata. Se for dizer que vai conferir algo, diga em primeira pessoa ("isso eu não tenho aqui agora; te passo quando tu vier aqui no escritório") e siga a conversa com uma pergunta; nunca escreva "pedi para o Djhonata", "o Djhonata vai ver" nem "assim que ele responder".';
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
        if (!podeResponder(f.jid, f.telefone) && !ctx.autoTrava) { log('resposta descartada (pausada no meio)', f.jid); return; }
        saida.push(...await enviarSaida(f.jid, await revisarSaida(f, tirarMarcacao(t)), 'ia', f.extra));   // 26/11/2026: tira pedaço de código que a IA às vezes deixa no texto
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
  // 24/11/2026 (Djhonata, cliente Edemir: "eu comprei uma casa"): a assistente deu parabéns e o card não mudou. Cliente que já comprou ou fechou
  // com outro vai para Desistiu / comprou com outro na hora, pelo código, mesmo que a IA esqueça de registrar.
  if (!f.dono && !f.rotina && !ctx.autoTrava && f.jid) {
    try {
      const l = lerEsp(f.jid), fala = []; let viu = false;
      for (let i = l.length - 1; i >= 0 && fala.length < 4; i--) { const m = l[i]; if (m.autor === 'aviso' || m.tipo === 'reacao') continue; if (m.autor === 'cliente') { viu = true; fala.push(String(m.texto || '')); } else if (viu) break; }
      const tx = fala.reverse().join(' / ');
      if (RE_COMPROU_OUTRO.test(semAcento(tx)) && !/\b(quero|vou|pretendo|queria|penso em|gostaria de) compr/i.test(semAcento(tx))) {
        await executar('registrar_crm', { novoStatus: 'desistiu', resultado: 'Comprou com outro: "' + tx.slice(0, 200) + '"', resumo: 'Cliente disse que já comprou (ou fechou) um imóvel por outro caminho.' }, ctx);
        log('comprou com outro: card movido pelo código', f.telefone || f.jid, tx.slice(0, 80));
      }
    } catch (e) { log('comprou com outro: falhou', e.message); }
  }
  // 24/11/2026 (Djhonata: "você está esquecendo de encaminhar a foto do escritório para os clientes"): o convite agora sai com dois horários (sem o link
  // da agenda), e a foto só ia junto com o link. Agora vai no convite com horários e quando a visita é marcada; uma vez a cada 7 dias por conversa.
  if (!f.dono && f.jid && saida.length) {
    try {
      const txt = saida.join('\n'), convite = /escrit[oó]rio/i.test(txt) && /(\b\d{1,2}h\b|\bàs \d{1,2}|\bas \d{1,2})/i.test(txt);
      if ((ctx.fotoEscritorio || convite) && !mandouHaPouco(f.jid, m => m.arquivo === 'c/' + FOTO_ESCRITORIO, AGENDA_VALE) && fs.existsSync(path.join(CATALOGO, FOTO_ESCRITORIO))) {
        if (await enviarArquivo(f.jid, FOTO_ESCRITORIO, 'Esse é o nosso escritório, pra você achar fácil ✅', 'ia', f.extra) === 'Enviado.') log('foto do escritório enviada', f.telefone || f.jid);
      }
    } catch (e) { log('foto do escritório: falhou', e.message); }
  }
  log('respondido', f.telefone || f.jid, saida.length, 'mensagens');
  if (saida.length && !f.dono) { try { cardAutomatico(f.jid); } catch (e) { } }
}
const RE_COMPROU_OUTRO = /\b(ja )?(comprei|compramos)\b.{0,40}\b(casa|ap|apto|apartamento|imovel|sobrado|geminad\w*|outr[oa]|kit ?net|lugar)\b|\bja (comprei|compramos|fechei|fechamos|achamos|achei|estou fechando|estamos fechando)\b|\b(fechei|fechamos) com\b|\bestamos fechando\b|\bcomprei com outr|\bcompramos com outr|\bja (escolhi|escolhemos)\b|\b(escolhi|escolhemos|peguei|pegamos) outr/;   // 24/11/2026: Rai "Ja escolhi outro imóvel"

// ---------- rascunho das pendências (23/11/2026, Djhonata: "eu preciso que venha a informação, não fique ali o [DADO]") ----------
// O CRM pede o retorno de uma pendência; a assistente pesquisa com as ferramentas de consulta (ficha, simulação, distância, imóveis perto, FIPE),
// com todas as regras dela, e devolve SÓ o texto. Nada é enviado ao cliente: quem manda é o Djhonata, no botão Enviar.
const RASC_FERR = ['ler_ficha', 'simular_fluxo', 'distancia', 'imoveis_perto', 'fipe_veiculo'];
const rascunhos = { fila: [], rodando: false, prontos: {} };
async function rascunhoFazer(item) {
  const alvo = item.jid;
  const c = chats[alvo] || {};
  const ctxSis = { jid: alvo, telefone: c.telefone || '', nome: c.nome || '', notas: [], rotina: 'rascunho' };
  const system = sistema(ctxSis) + `\n\n===== MODO RASCUNHO (pedido do Djhonata pelo CRM) =====\nVocê NÃO está mandando nada ao cliente agora: escreva o texto do retorno que o Djhonata vai revisar e enviar. Ficou uma pendência nesta conversa. Pesquise a resposta com as ferramentas (ler_ficha, simular_fluxo, distancia, imoveis_perto, fipe_veiculo), as regras e o catálogo que você tem. Responda a pergunta do cliente com a informação de verdade (números, medidas, nomes, distâncias, opções de imóvel). Nunca escreva [DADO] nem qualquer marcação entre colchetes. Se faltar algo que só o Djhonata ou a construtora sabem, diga com naturalidade que passa essa informação quando o cliente vier ao escritório, e siga com a pergunta do próximo passo. Nunca escreva "confirmo com o Djhonata": você É o Djhonata. Nunca repita dias ou horários oferecidos antes nesta conversa: eles já passaram. Primeira pessoa, como o Djhonata, curto (até 4 frases, ou o bloco da simulação quando for conta), só os emojis ✅ e 🙏🏼, sem oferecer dia ou data fixos (pergunte qual dia da semana fica melhor). Se houver mais de um imóvel com nome ou rua parecidos, use o que bate com o preço e o bairro citados na pendência e na conversa (confira com ler_ficha e passe a ref certa no simular_fluxo); nunca troque de imóvel. Se o imóvel que o cliente quer não está mais no catálogo, ou o preço não bate com nenhum (ex.: vendido), diga isso com naturalidade ("essa unidade de R$ 380 mil já foi vendida") e ofereça a opção mais parecida, deixando claro que é outra casa. Quando forem duas mensagens (ex.: o bloco da simulação e depois a pergunta), separe com uma linha só com ---. Devolva SÓ o texto que vai para o cliente: nada de observações para o Djhonata, "Obs.:", "(Em outra mensagem:)" ou comentários.`;
  const messages = montarMensagens(alvo, [], `(sistema) PENDÊNCIA: ${item.oque || ''}\nPergunta para responder: ${item.pergunta || ''}\nRascunho anterior (pode melhorar): ${item.mensagem || ''}\nEscreva agora o retorno.`);
  const ferr = FERRAMENTAS.filter(t => RASC_FERR.includes(t.name));
  const ctxF = { jid: 'rascunho-' + alvo, telefone: c.telefone || '', nome: c.nome || '', notas: [], rotina: 'rascunho' };
  let texto = '';
  for (let volta = 0; volta < 6; volta++) {
    const resp = await claude(system, messages, ferr);
    messages.push({ role: 'assistant', content: (resp.content || []).length ? resp.content : [{ type: 'text', text: '(sem resposta)' }] });
    const res = [];
    for (const bl of resp.content || []) {
      if (bl.type === 'text' && String(bl.text || '').trim()) texto = String(bl.text).trim();
      else if (bl.type === 'tool_use') { let r = ''; try { r = RASC_FERR.includes(bl.name) ? await executar(bl.name, bl.input || {}, ctxF) : 'Ferramenta indisponível no rascunho.'; } catch (e) { r = 'erro: ' + e.message; } res.push({ type: 'tool_result', tool_use_id: bl.id, content: String(r).slice(0, 20000) }); }
    }
    if (res.length) { messages.push({ role: 'user', content: res }); texto = ''; continue; }
    break;
  }
  return texto.replace(/^NO_REPLY\b.*$/m, '').trim();
}
async function rascunhoTrabalhar() {   // até 3 ao mesmo tempo
  rascunhos.ativos = rascunhos.ativos || 0;
  while (rascunhos.ativos < 3 && rascunhos.fila.length) {
    const it = rascunhos.fila.shift(); rascunhos.ativos++; rascunhos.rodando = true;
    (async () => {
      try { const t = await rascunhoFazer(it); rascunhos.prontos[it.chave] = { ok: !!t, mensagem: semDiminutivo(t), em: Date.now() }; }
      catch (e) { rascunhos.prontos[it.chave] = { ok: false, erro: e.message, em: Date.now() }; log('rascunho', it.chave, e.message); }
      finally { rascunhos.ativos--; rascunhos.rodando = rascunhos.ativos > 0; rascunhoTrabalhar(); }
    })();
  }
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
// ---------- Tabela FIPE (pedido do Djhonata, 14/11/2026): carro ou moto na entrada conta por 80% da FIPE ----------
// A cliente disse que tinha um Cerato 2011 quitado e a assistente respondeu que o Djhonata ia confirmar o valor. Agora ela consulta e faz a conta.
const FIPE_API = ENV.FIPE_API || 'https://fipe.parallelum.com.br/api/v2', FIPE_PCT = 0.8, fipeCache = new Map();
async function fipeJson(caminho, horas) {
  const c = fipeCache.get(caminho); if (c && Date.now() - c.ts < (horas || 24) * 3600e3) return c.v;
  const r = await fetch(FIPE_API + caminho, { signal: AbortSignal.timeout(15000), headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error('FIPE respondeu ' + r.status + ' em ' + caminho);
  const v = await r.json(); fipeCache.set(caminho, { v, ts: Date.now() });
  if (fipeCache.size > 500) fipeCache.delete(fipeCache.keys().next().value);
  return v;
}
function fipeNorm(s) { return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9.]+/g, ' ').replace(/(^| )\.+|\.+( |$)/g, ' ').replace(/\s+/g, ' ').trim(); }
function fipeMarca(lista, marca) {
  const q = fipeNorm(marca); if (!q) return null;
  const apelido = { chevrolet: 'gm chevrolet', gm: 'gm chevrolet', vw: 'vw volkswagen', volks: 'vw volkswagen', volkswagen: 'vw volkswagen', kia: 'kia motors', mercedes: 'mercedes benz', citroen: 'citroen', caoa: 'caoa chery' }[q] || q;
  const cand = lista.map(m => ({ m, n: fipeNorm(m.name) })).filter(x => x.n === apelido || x.n === q || x.n.split(' ').includes(q) || x.n.startsWith(apelido) || apelido.split(' ').every(t => x.n.includes(t)));
  cand.sort((a, b) => (b.n === apelido || b.n === q) - (a.n === apelido || a.n === q) || a.n.length - b.n.length);
  return cand.length ? cand[0].m : null;
}
function fipeModelos(lista, modelo) {   // modelos da marca que batem com o que o cliente disse (família + versão, quando ele deu)
  const sin = { automatico: 'aut', automatica: 'aut', auto: 'aut', manual: 'mec', mecanico: 'mec', mecanica: 'mec', sedan: 'sed', hatch: 'hatch' };
  const toks = fipeNorm(modelo).split(' ').filter(Boolean).map(t => sin[t] || t).filter(t => !['flex', 'gasolina', 'alcool', 'etanol', 'completo', 'basico', 'quitado', 'carro', 'moto'].includes(t));
  if (!toks.length) return [];
  const fam = toks[0], resto = toks.slice(1);
  const tem = (n, t) => (' ' + n + ' ').includes(' ' + t + ' ') || (' ' + n + ' ').includes(' ' + t + '.') || (t.length >= 3 && n.replace(/ /g, '').includes(t) && !/^\d+$/.test(t));
  let cand = lista.map(m => ({ m, n: fipeNorm(m.name) })).filter(x => tem(x.n, fam) || x.n.replace(/ /g, '').startsWith(fam.replace(/ /g, '')));
  cand.forEach(x => { x.pts = resto.filter(t => tem(x.n, t)).length; });
  const max = Math.max(0, ...cand.map(x => x.pts));
  if (max > 0) cand = cand.filter(x => x.pts === max);   // o cliente deu a versão: ficam as que mais batem
  return cand.sort((a, b) => a.n.localeCompare(b.n)).map(x => x.m);
}
async function fipeConsultar({ tipo, marca, modelo, ano }) {
  const t = /moto/i.test(String(tipo || '')) ? 'motorcycles' : /caminh/i.test(String(tipo || '')) ? 'trucks' : 'cars', oQue = t === 'motorcycles' ? 'moto' : t === 'trucks' ? 'caminhão' : 'carro';
  const A = (/\b(19[5-9]\d|20\d\d)\b/.exec(String(ano || '')) || /\b(19[5-9]\d|20\d\d)\b/.exec(String(modelo || '')) || [])[1] || '';
  if (!String(marca || '').trim() || !String(modelo || '').trim()) return 'Mande a marca e o modelo (ex.: marca "Kia", modelo "Cerato 1.6", ano "2011"). Se o cliente não disse, pergunte qual é o ' + oQue + ', o ano e a versão.';
  const marcas = await fipeJson(`/${t}/brands`, 24 * 30), mk = fipeMarca(marcas, marca);
  if (!mk) return `Não achei a marca "${marca}" na tabela FIPE de ${oQue}s. Confira a marca com o cliente (ou se é moto/carro) e consulte de novo.`;
  const modelos = await fipeJson(`/${t}/brands/${mk.code}/models`, 24 * 7), cand = fipeModelos(modelos, String(modelo).replace(/\b(19[5-9]\d|20\d\d)\b/g, ' '));
  if (!cand.length) return `Não achei "${modelo}" entre os modelos ${mk.name} da tabela FIPE. Confira o nome do modelo com o cliente e consulte de novo.`;
  if (!A) return `Achei ${cand.length} versão(ões) de ${mk.name} ${modelo} na FIPE (${cand.slice(0, 6).map(m => m.name).join('; ')}${cand.length > 6 ? '; ...' : ''}). Falta o ANO MODELO: pergunte ao cliente o ano e consulte de novo com ano.`;
  const achados = []; let anosVistos = new Set(), falhas = 0;
  for (const m of cand.slice(0, 10)) {
    let anos; try { anos = await fipeJson(`/${t}/brands/${mk.code}/models/${m.code}/years`, 24 * 7); } catch (e) { falhas++; continue; }
    (anos || []).forEach(y => { const a4 = String(y.code).slice(0, 4); if (/^(19|20)\d\d$/.test(a4)) anosVistos.add(a4); });
    for (const y of (anos || []).filter(y => String(y.code).startsWith(A + '-')).slice(0, 2)) {
      try {
        const p = await fipeJson(`/${t}/brands/${mk.code}/models/${m.code}/years/${y.code}`, 24);
        const v = Number(String(p.price || '').replace(/[^0-9,]/g, '').replace(',', '.'));
        if (v > 0) achados.push({ nome: `${p.model || m.name} ${p.modelYear || A}${p.fuel ? ' (' + p.fuel + ')' : ''}`, v, ref: p.referenceMonth || '', cod: p.codeFipe || '' });
      } catch (e) { falhas++; }
    }
    if (achados.length >= 8) break;
  }
  if (!achados.length) {
    if (falhas && !anosVistos.size) throw new Error('sem resposta da FIPE');
    const anos = [...anosVistos].sort();
    return `Não achei ${mk.name} ${modelo} ano ${A} na tabela FIPE.${anos.length ? ' Anos que existem para esse modelo: ' + anos.slice(0, 1)[0] + ' a ' + anos.slice(-1)[0] + '.' : ''} Confira o ano e a versão com o cliente.`;
  }
  const R = (n) => 'R$ ' + Math.round(n).toLocaleString('pt-BR');
  achados.sort((a, b) => a.v - b.v);
  const linhas = achados.map(a => `- ${a.nome}: FIPE ${R(a.v)} → 80% = ${R(a.v * FIPE_PCT)}`).join('\n');
  const min = achados[0], max = achados[achados.length - 1];
  const faixa = achados.length > 1 ? `Há ${achados.length} versões nesse ano: a FIPE vai de ${R(min.v)} a ${R(max.v)}, então na entrada conta de ${R(min.v * FIPE_PCT)} a ${R(max.v * FIPE_PCT)}. Se o cliente não disse a versão, fale essa faixa e pergunte a versão (motor, manual ou automático).` : `Na entrada conta ${R(min.v * FIPE_PCT)}.`;
  log('fipe: consulta', mk.name, modelo, A, achados.length, 'versões');
  return `Tabela FIPE (${min.ref || 'mês atual'}), ${mk.name} ${A}:\n${linhas}\n${faixa} A Euro considera 80% da FIPE para abater o complemento da entrada (se o veículo tiver saldo devedor, desconta o que falta pagar). O que ainda faltar da entrada pode ir para a entrega das chaves, ser pago em dinheiro ou com FGTS. Diga ao cliente que é uma estimativa e que a conta fecha no escritório. Não diga que o Djhonata vai confirmar o valor.`;
}
// ---------- Agenda do escritório: a assistente consulta e marca (pedido do Djhonata, 11/11/2026). Mesmas regras do link do cliente. ----------
const AGENDA_HOOK = ENV.AGENDA_HOOK || 'https://hook.us2.make.com/ifgf6ai79h57nseenakwqw18kvjj9u41';
const AG_SEMANA = [8, 9, 10, 13, 14, 15, 16, 17, 18, 19], AG_SABADO = [8, 9, 10, 11, 12, 13, 14, 15], AG_ANTECEDENCIA_H = 4;
async function agendaOcupados() {   // chaves ocupadas ou fechadas: "AAAA-MM-DD" (dia inteiro) ou "AAAA-MM-DDTHH:00"
  const r = await fetch(AGENDA_HOOK + '?acao=horarios&t=' + Date.now(), { signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error('agenda respondeu ' + r.status);
  return new Set((await r.text()).split(',').map(s => s.trim()).filter(Boolean));
}
function agendaLivres(ocup, data) {   // horas livres (números) de um dia AAAA-MM-DD
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(data || ''); if (!m) return [];
  const w = new Date(+m[1], +m[2] - 1, +m[3]).getDay(); if (w === 0 || ocup.has(data)) return [];
  const lim = agoraSP().getTime() + AG_ANTECEDENCIA_H * 3600e3;
  return (w === 6 ? AG_SABADO : w === 3 ? AG_SEMANA.filter(h => h < 19) : AG_SEMANA).filter(h => new Date(+m[1], +m[2] - 1, +m[3], h, 0).getTime() >= lim && !ocup.has(`${data}T${String(h).padStart(2, '0')}:00`));
}
function guardarVisita(jid, data, hora, origem, local) {
  if (!jid || !/^\d{4}-\d{2}-\d{2}$/.test(data || '')) return;
  const h = /^(\d{1,2}):(\d{2})/.exec(hora || ''); const q = data + (h ? 'T' + h[1].padStart(2, '0') + ':' + h[2] : '');
  estado.visitas = estado.visitas || {};
  const v = estado.visitas[jid];
  if (v && v.q === q) { let mud = false; if (origem === 'crm' && !v.crm) { v.crm = true; mud = true; } if (local && v.local !== local) { v.local = local; mud = true; } if (mud) salvarEstado(); return; }
  estado.visitas[jid] = { q, origem, criado: Date.now(), enviados: {}, crm: origem === 'crm' };
  if (local) estado.visitas[jid].local = String(local);
  salvarEstado(); log('visita guardada para lembretes', jid, q, origem);
}
// 16/11/2026 (Djhonata): cliente que não veio nem avisou. Quando ele move o card para "Remarcar visita" depois da hora da visita,
// a assistente manda UMA mensagem pedindo para remarcar. A visita que já passou fica guardada 6 dias para isso, porque o CRM
// move sozinho para "Remarcar visita" quem ficou 3 dias em "Visita marcada" depois da hora da visita.
const NAO_VEIO_DIAS = 6;
function guardarPassada(jid, v) {
  const T = v && quandoMs(v.q); if (!jid || !T || T > Date.now() || Date.now() - T > NAO_VEIO_DIAS * 864e5) return;
  estado.visitasPassadas = estado.visitasPassadas || {};
  if (!estado.visitasPassadas[jid] || estado.visitasPassadas[jid].q !== v.q) estado.visitasPassadas[jid] = { q: v.q, em: Date.now(), local: v.local || undefined };
}
function cancelarVisita(jid, motivo) { if (estado.visitas && estado.visitas[jid]) { guardarPassada(jid, estado.visitas[jid]); delete estado.visitas[jid]; salvarEstado(); log('lembretes cancelados', jid, motivo || ''); } }
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
    if (v.crm || (st && st !== 'visita' && Date.now() - (v.criado || 0) > 20 * 60e3)) { guardarPassada(jid, v); delete estado.visitas[jid]; log('lembretes cancelados (CRM)', jid); }
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
  // 24/11/2026: retorno que o cliente pediu ("me chama em janeiro") e ordem do Djhonata valem mesmo com a conversa arquivada ou em Perdido:
  // quem fica 7 dias sem falar vira Perdido e é arquivado à noite, e o retorno marcado para depois ficava preso.
  const pedido = tipo === 'retorno' || tipo === 'ordem';
  if ((c.arquivado && !pedido) || filas.has(jid) || ocupado.has(jid)) return false;
  if (t8 && t8 === String(DONO).slice(-8) && !(estado.teste && estado.teste.ativo)) return false;
  if (t8 && [...lerBloqueados()].some(n => n.endsWith(t8))) return false;
  if (t8 && (estado.equipe || []).includes(t8)) return false;
  const st = t8 ? (estado.crmStatus || {})[t8] || '' : '';
  if (['negociacao', 'fechado', 'pausado', 'desistiu', 'semperfil', 'sem_perfil', 'corretor', 'corretor_euro', 'construtor', 'pessoal'].includes(st)) return false;   // 24/11/2026: Sem perfil agora também não recebe nada automático
  if (st === 'perdido' && !pedido) return false;   // perdido é com o Djhonata; só sai o retorno que o próprio cliente pediu ou o que o Djhonata mandar
  if (tipo === 'retomada' && st === 'visita') return false;
  const cl = (estado.classes || {})[jid]; if (cl && ['comprou', 'corretor', 'construtor', 'pessoal'].includes(cl.cat)) return false;
  if (etiquetasDe(jid).some(e => (pedido ? /pausad|desist|fechad|finaliz|comprou|corretor|constru|capta|pessoa|negocia/ : /pausad|perdid|desist|fechad|finaliz|comprou|corretor|constru|capta|pessoa|negocia/).test(semAcento(e.nome)))) return false;
  return true;
}
const RE_SO_OK = /^(certo|ok+|okay|blz|beleza|ta|ta bom|ta certo|tudo bem|entendi|hum+|uhum|aham|show|top|legal|sim|isso|\p{Extended_Pictographic}+)[\s.!]*$/iu;   // resposta de uma palavra que não pede nada
// O cliente confirmou a visita? Vale o que ele escreveu DEPOIS do último lembrete: "sim", "confirmo", "combinado" = confirmou; "não vou conseguir", "desmarcar", "imprevisto" = disse que não vem.
const RE_VIS_NAO = /\b(nao (vou|vamos|consigo|conseguimos|posso|podemos|vai dar|da pra|poderei)|desmarc|remarc|cancel|imprevisto|outro dia|deixa pra)\b/, RE_VIS_SIM = /\b(confirm\w*|sim|ok+|okay|certo|combinado|blz|beleza|estarei|estaremos|vou sim|vamos sim|pode deixar|fechado|ta bom|to indo|estou indo|ate la|show|perfeito|com certeza|pode ser)\b|\u{1F44D}|\u{2705}|\u{1F64F}/u;
function visitaConfirmacao(jid, v) {
  const base = Math.max((v.enviados || {}).l24 || 0, (v.enviados || {}).l2 || 0); if (!base) return { conf: '', em: 0, texto: '' };
  let r = { conf: '', em: 0, texto: '' };
  for (const m of lerEsp(jid)) { if (m.autor !== 'cliente' || (m.ts || 0) <= base) continue; const t = semAcento(String(m.texto || '')); if (!t.trim()) continue;
    if (RE_VIS_NAO.test(t)) r = { conf: 'nao', em: m.ts, texto: String(m.texto).slice(0, 80) }; else if (RE_VIS_SIM.test(t) && (r.conf !== 'nao' || /\b(confirm\w*|estarei|estaremos|vou sim|vamos sim|to indo|estou indo|consigo sim|vou conseguir)\b/.test(t))) r = { conf: 'sim', em: m.ts, texto: String(m.texto).slice(0, 80) }; }   // 17/11/2026: depois de um "não vou conseguir", um "ok/show, obrigado" é só educação e não vira confirmação
  return r;
}
// 17/11/2026 (Djhonata): a agenda precisa mostrar a justificativa do cliente ("tive um imprevisto, não sei que horas saio"), não só confirmou/não confirmou.
function visitaResposta(jid, base) {   // tudo que o cliente escreveu depois do último lembrete, em uma linha
  if (!base) return { resp: '', respEm: 0 };
  const p = []; let em = 0;
  for (const m of lerEsp(jid)) { if (m.autor !== 'cliente' || (m.ts || 0) <= base) continue; const t = String(m.texto || '').replace(/\s+/g, ' ').trim(); if (!t || m.tipo === 'image' && !m.transc && t.length < 3) continue; p.push(t); em = m.ts; }
  return { resp: p.slice(-4).join(' · ').slice(0, 220), respEm: em };
}
function visitaSolta(t8) {   // cliente que está na agenda mas já não tem lembrete ativo aqui (a assistente liberou depois da resposta dele): acha o último lembrete dos últimos 2 dias
  const jid = jidPorTel8(t8); if (!jid || (estado.visitas || {})[jid]) return null;
  let base = 0; for (const m of lerEsp(jid)) if (m.autor === 'ia' && m.rotina === 'lembrete' && (m.ts || 0) > Date.now() - 2 * 864e5) base = m.ts;
  if (!base) return null;
  const c = visitaConfirmacao(jid, { enviados: { l2: base } }), r = visitaResposta(jid, base);
  return { tel8: t8, q: '', solta: true, criado: 0, l1: 0, l2: base, conf: c.conf, confEm: c.em, confTexto: c.texto, resp: r.resp, respEm: r.respEm };
}
// 24/11/2026 (Djhonata, caso Ricardo Cardoso: "semana que vem, a partir de terça, vou estar mais tranquilo"): quando o cliente disse QUANDO
// pode falar, nada de follow-up antes: a assistente marca o retorno para essa data e só chama nela. Sem data clara ("te aviso", "mais pra frente"),
// também não insiste: fica com o Djhonata.
const RE_ADIA = /\b(semana que vem|pr[oó]xima semana|m[eê]s que vem|pr[oó]ximo m[eê]s|in[ií]cio do m[eê]s|come[cç]o do m[eê]s|amanh[aã]|depois de amanh[aã]|segunda|ter[cç]a|quarta|quinta|sexta|s[aá]bado|domingo|fim de semana|final de semana|depois do dia|a partir do dia|dia \d{1,2}\b|daqui a \d+ dias?|depois do feriado|mais pra frente|mais para frente|outro dia|te aviso|eu te aviso|te chamo|eu te chamo|eu chamo|eu falo|te falo|te retorno|quando receber|quando sair|quando der|mais tranquil|estou corrid|t[oô] corrid|t[oô] sem tempo|estou sem tempo|d[aá] uma segurad|segura a[ií]|terminar de receber|quando (?:eu )?receber|receber (?:uma|um|o|a|meu|minha) |grana|(?:esperar|aguardar|deixar|retomar|voltar a falar|falamos|conversamos|a gente (?:se fala|conversa|ve))[^.?!]{0,40}\b(?:janeiro|fevereiro|mar[cç]o|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)\b|s[oó] (?:em|l[aá] (?:pra|para|por|em)|depois de|a partir de) (?:janeiro|fevereiro|mar[cç]o|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)\b|l[aá] (?:pra|para|por) (?:janeiro|fevereiro|mar[cç]o|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)\b|ano que vem|pr[oó]ximo ano|depois d[ao]s? (?:festas|natal|ano novo|virada))/i;   // 24/11/2026: Leonardo "dá uma segurada, deixa eu terminar de receber uma grana"
// 24/11/2026 (pente fino nos clientes): (1) caso Ricardo: depois de "semana que vem, a partir de terça" ele ainda mandou "Blz" e "Obrigado", e o
// retorno não foi marcado porque só a última fala era lida. Agora procura a fala de adiamento nas últimas falas do cliente (até 3 dias antes da
// última) e só desiste dela se depois veio assunto novo. (2) A data conta a partir do dia em que o cliente falou, não de hoje (antes, "amanhã"
// virava um retorno novo a cada dia). (3) Entende mês pelo nome (caso Taty: "esperar até janeiro... depois do dia 20" tinha virado 21/12).
// (4) Áudio transcrito: o texto fica em m.texto (m.transc é só a marca de que foi transcrito); antes o áudio era lido como "true".
// (5) Quem está combinando visita ("pode ser quinta", "posso ir sábado?") não está adiando.
const RE_LEVE = /^(?:muito |ok,? |ta,? |blz,? |certo,? )?(?:obrigad[oa]o?|obg|obgd[oa]?|brigad[oa]|valeu|vlw|tmj|agradeco|agradecid[oa]|amem|deus (?:te )?abencoe|ate (?:mais|logo)|abraco|boa (?:tarde|noite)|bom dia|kk+|rs+)[\s.!,\p{Extended_Pictographic}\u{1F3FB}-\u{1F3FF}]*$/iu;
const RE_COMBINANDO = /\b(pode ser|posso ir|podemos ir|consigo ir|conseguimos ir|vou ir|vou ai|passo ai|quero ir|queria ir|vamos marcar|pode marcar|quero marcar|marca pra|agenda pra|confirmad[oa]|ta marcado|fica marcado)\b/;
const MESES_NOME = { janeiro: 0, fevereiro: 1, marco: 2, abril: 3, maio: 4, junho: 5, julho: 6, agosto: 7, setembro: 8, outubro: 9, novembro: 10, dezembro: 11 };
function adiamentoDoCliente(jid) {   // { texto, q } se o cliente adiou a conversa; q = 'AAAA-MM-DDTHH:MM' quando dá para saber o dia
  const cli = lerEsp(jid).filter(m => m.autor === 'cliente' && m.tipo !== 'reacao' && !m.auto); if (!cli.length) return null;
  const fim = cli[cli.length - 1].ts, rec = cli.filter(m => fim - m.ts < 3 * 864e5).slice(-8);
  const tx = (m) => semAcento(String(m.texto || '')).trim();
  let k = -1; for (let i = rec.length - 1; i >= 0; i--) { if (RE_ADIA.test(tx(rec[i]))) { k = i; break; } }
  if (k < 0 || RE_COMBINANDO.test(tx(rec[k]))) return null;
  for (let i = k + 1; i < rec.length; i++) { const s = tx(rec[i]); if (s && !RE_SO_OK.test(s) && !RE_LEVE.test(s)) return null; }   // depois veio assunto novo: a conversa seguiu
  const txt = semAcento(rec.slice(Math.max(0, k - 3), k + 1).filter(m => rec[k].ts - m.ts < 6 * 3600e3).map(m => String(m.texto || '')).join(' '));
  const sp = new Date(rec[k].ts - 3 * 3600e3), hoje = new Date(Date.UTC(sp.getUTCFullYear(), sp.getUTCMonth(), sp.getUTCDate(), 12));   // o dia em que o cliente falou (horário de Brasília)
  const ymd = (d) => d.toISOString().slice(0, 10), mais = (n) => { const d = new Date(hoje); d.setUTCDate(d.getUTCDate() + n); return d; };
  const SEM = { domingo: 0, segunda: 1, terca: 2, quarta: 3, quinta: 4, sexta: 5, sabado: 6 }; let alvo = null, mm;
  const proxSemana = /semana que vem|proxima semana/.test(txt);
  const mesNome = /\b(janeiro|fevereiro|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)\b/.exec(txt);
  const anoQueVem = /ano que vem|proximo ano|depois d[ao]s? (?:festas|natal|ano novo|virada)/.test(txt);
  const diaM = /(?:(depois d[oe]|a partir d[oe]) (?:dia )?|\bdia )(\d{1,2})\b(?! ?(?:dias?\b|h\b|horas?\b|mil\b|x\b|%|parcelas?\b|reais\b|anos?\b))/.exec(txt);
  const diaOk = diaM && +diaM[2] >= 1 && +diaM[2] <= 31 ? +diaM[2] : 0, depois = !!(diaM && diaM[1] && /depois/.test(diaM[1]));
  if (mesNome || anoQueVem) {
    const mes = mesNome ? MESES_NOME[mesNome[1]] : 0;
    const dia = diaOk ? diaOk + (depois ? 1 : 0) : (/quinzena|meados|metade d|meio d/.test(txt) ? 15 : /\b(?:fim|final) d/.test(txt) ? 25 : 5);
    let ano = hoje.getUTCFullYear(); if (!mesNome || mes < hoje.getUTCMonth() || (mes === hoje.getUTCMonth() && dia <= hoje.getUTCDate())) ano++;
    alvo = new Date(Date.UTC(ano, mes, dia, 12));
  }
  else if ((mm = /\b(segunda|terca|quarta|quinta|sexta|sabado|domingo)\b/.exec(txt))) { const w = SEM[mm[1]], hw = hoje.getUTCDay(); const n = proxSemana ? ((8 - hw) % 7 || 7) + ((w + 6) % 7) : ((w - hw + 7) % 7 || 7); alvo = mais(n); }
  else if (/depois de amanha/.test(txt)) alvo = mais(2);
  else if (/amanha/.test(txt)) alvo = mais(1);
  else if ((mm = /(?:daqui a|daqui uns|depois de|em uns) (\d+) dias?\b/.exec(txt))) alvo = mais(Math.min(60, +mm[1]));
  else if (diaOk) { const d = new Date(Date.UTC(hoje.getUTCFullYear(), hoje.getUTCMonth(), diaOk, 12)); if (d <= hoje) d.setUTCMonth(d.getUTCMonth() + 1); if (depois) d.setUTCDate(d.getUTCDate() + 1); alvo = d; }
  else if (proxSemana) alvo = mais((8 - hoje.getUTCDay()) % 7 || 7);
  else if (/mes que vem|proximo mes|inicio do mes|comeco do mes/.test(txt)) alvo = new Date(Date.UTC(hoje.getUTCFullYear(), hoje.getUTCMonth() + 1, 2, 12));
  if (alvo) { while (alvo.getUTCDay() === 0) alvo.setUTCDate(alvo.getUTCDate() + 1); }
  return { texto: String(rec[k].texto || '').replace(/\s+/g, ' ').slice(0, 160), q: alvo ? ymd(alvo) + 'T10:00' : '' };
}
function adiouEMarca(jid) {   // true = não fazer retomada/follow-up automático agora
  if ((estado.visitas || {})[jid]) return false;   // 24/11/2026: com visita marcada vale o fluxo da visita (lembretes), não o adiamento
  const a = adiamentoDoCliente(jid); if (!a) return false;
  if (a.q && !(estado.retornos || {})[jid] && quandoMs(a.q) > Date.now()) { estado.retornos = estado.retornos || {}; estado.retornos[jid] = { q: a.q, assunto: 'o cliente disse: "' + a.texto + '"', criado: Date.now(), auto: true }; salvarEstado(); log('retorno marcado pelo que o cliente disse', jid, a.q, a.texto); }
  return true;
}
function conversaParada(jid) {   // última mensagem (sem contar avisos internos) foi da assistente e o cliente não respondeu
  const l = lerEsp(jid); let ult = null, ultCli = 0, agenda = false, ack = 0;
  for (let i = l.length - 1; i >= 0; i--) {
    const m = l[i]; if (m.auto) continue;   // resposta automática de conta comercial não é fala do cliente
    if (m.autor === 'cliente') { if (!ult && !ack && RE_SO_OK.test(semAcento(String(m.texto || '')).trim())) { ack = m.ts; continue; } ultCli = m.ts; break; }   // 17/11/2026: "Certo" da Antonia ficou sem resposta e sem retomada
    if (m.autor === 'aviso') continue;
    if (!ult) ult = m;
    if (m.autor === 'ia' && /make\.com|marque seu hor[aá]rio/i.test(m.texto || '')) agenda = true;
  }
  return ult && ult.autor === 'ia' && ultCli && ult.ts > ultCli ? { ultIa: ack || ult.ts, ultCli: ack || ultCli, agenda, jaRetomou: !ack && !!ult.rotina } : null;
}
async function verificarRotinas() {
  if (!ROTINAS || rotinas.rodando || !sock || !conectado || !API_KEY) return;
  const dia = agoraSP().toISOString().slice(0, 10); if (rotinas.dia !== dia) Object.assign(rotinas, { dia, lembretes: 0, retomadas: 0 });
  rotinas.rodando = true;
  try {
    const agora = Date.now(), fila = [], janela = dentroRotina();
    for (const [jid, v] of Object.entries(estado.visitas || {})) {
      const T = quandoMs(v.q); if (!T) continue;
      if (agora > T + 3 * 3600e3) { guardarPassada(jid, v); delete estado.visitas[jid]; salvarEstado(); continue; }
      if (!janela || !rotinaPermitida(jid, 'lembrete')) continue;
      v.enviados = v.enviados || {};
      if (!v.enviados.l24 && agora >= T - 24 * 3600e3 && agora <= T - 12 * 3600e3 && (v.criado || 0) <= T - 22 * 3600e3 && agora - (v.criado || 0) >= 6 * 3600e3) fila.push({ jid, tipo: 'l24', v });   // 16/11/2026: visita marcada há menos de 6 horas não recebe o lembrete da véspera (o Salomão marcou às 18h15 e recebeu o lembrete às 18h16); fica só o do dia
      else if (v.q.includes('T') && !v.enviados.l2 && agora >= T - 3 * 3600e3 && agora <= T - 50 * 60e3) fila.push({ jid, tipo: 'l2', v });
    }
    // 23/11/2026 (Djhonata): quem recebeu o pedido de confirmação e não respondeu até ~1h antes vira aviso no WhatsApp do Djhonata (ligar ou liberar o horário).
    for (const [jid, v] of Object.entries(estado.visitas || {})) { const T = quandoMs(v.q); if (!T || !v.pediuConf || v.avisoSemConf || agora < T - 70 * 60e3 || agora > T) continue;
      if (visitaResposta(jid, v.pediuConf).resp) { v.avisoSemConf = -1; salvarEstado(); continue; }
      v.avisoSemConf = agora; salvarEstado(); const c = chats[jid] || {}, nm = nomeDoCrm(jid) || c.nome || 'Cliente';
      enviarTexto(DONO + '@s.whatsapp.net', `⚠ ${nm}${c.telefone ? ' (' + formatoBR(c.telefone) + ')' : ''} NÃO confirmou a visita de ${descreverQuando(v.q)}: não respondeu o lembrete de ontem nem o áudio de hoje. Vale uma ligação agora; se não atender, pode liberar o horário.`, 'aviso').catch(() => { }); }
    // Não veio: a visita já passou, o card está em "Remarcar visita" e o cliente não falou mais nada. Uma mensagem só, pedindo para remarcar.
    for (const [jid, v] of Object.entries(estado.visitas || {})) { const T = quandoMs(v.q); if (T && agora > T + 45 * 60e3) { const t8 = tel8Chat(jid); if (t8 && (estado.crmStatus || {})[t8] === 'novo') { guardarPassada(jid, v); delete estado.visitas[jid]; salvarEstado(); } } }
    for (const [jid, n] of Object.entries(estado.visitasPassadas || {})) {
      const T = quandoMs(n.q), t8 = tel8Chat(jid), st = t8 ? (estado.crmStatus || {})[t8] || '' : '';
      if (!T || agora > T + NAO_VEIO_DIAS * 864e5 || n.feito || ['negociacao', 'fechado', 'desistiu', 'perdido'].includes(st) || ((estado.visitas || {})[jid] && estado.visitas[jid].q !== n.q) || ultCli(jid) > T - 30 * 60e3) { delete estado.visitasPassadas[jid]; salvarEstado(); continue; }   // já falou depois da visita, veio, remarcou ou saiu do funil
      if (st !== 'novo' || agora < T + 45 * 60e3 || !janela || !rotinaPermitida(jid, 'retomada')) continue;
      fila.push({ jid, tipo: 'naoveio', n });
    }
    for (const [jid, r] of Object.entries(estado.retornos || {})) {   // retorno combinado com o cliente ("falo depois das 14h30")
      const T = quandoMs(r.q), uc = ultCli(jid);
      if (!T || agora > T + 6 * 3600e3) { delete estado.retornos[jid]; salvarEstado(); continue; }                                   // passou muito da hora: desiste
      if (agora >= T - 30 * 60e3 && uc > (r.criado || 0) + 10 * 60e3 && agora - uc < 2 * 3600e3) { delete estado.retornos[jid]; salvarEstado(); continue; }   // ele já voltou a falar por conta própria
      if (agora < T || !janela || !rotinaPermitida(jid, 'retorno')) continue;
      fila.push({ jid, tipo: 'retorno', r });
    }
    if (janela && dentroRetomada()) {
      for (const jid of Object.keys(chats)) {
        const c = chats[jid];
        if (!(['ia', 'aviso'].includes(c.ultAutor) || (c.ultAutor === 'cliente' && RE_SO_OK.test(semAcento(String(c.ultTexto || '')).trim()))) || !c.ult || agora - c.ult > 22 * 3600e3 || agora - c.ult < 2 * 3600e3) continue;
        if ((estado.visitas || {})[jid]) continue;            // tem visita marcada: quem cuida são os lembretes
        if ((estado.retornos || {})[jid]) continue;           // tem retorno combinado: ela chama na hora marcada, não antes
        const p = conversaParada(jid); if (!p || p.jaRetomou) continue;
        if (agora - p.ultCli > 22 * 3600e3) continue;          // fora das 24h do cliente: não puxa conversa
        if (agora - p.ultIa < (p.agenda ? 2 : 3) * 3600e3) continue;
        const r = (estado.retomadas || {})[jid], diaDe = (ms) => new Date(ms - 3 * 3600e3).toISOString().slice(0, 10);
        if (r && (r.base === p.ultCli || diaDe(r.em || 0) === diaDe(agora))) continue;   // já retomou desde a última mensagem dele, ou já retomou hoje (13/11/2026: o Ge recebeu duas na mesma manhã)
        if (!rotinaPermitida(jid, 'retomada')) continue;
        if (adiouEMarca(jid)) continue;   // o cliente disse quando pode: chama na data, não antes
        fila.push({ jid, tipo: 'retomada', p });
      }
      // 24/11/2026 (Djhonata, caso Alessandro final 5134): nos 7 dias depois da última fala do cliente, a assistente insiste sozinha para não deixar
      // esfriar. Correção dele no mesmo dia: são 3 tentativas seguidas e pronto: a retomada do mesmo dia (~3 h), o dia seguinte e o outro dia.
      // Sem resposta, para: daí em diante é com ele (CRM, oferta e, depois de 7 dias, o follow-up com aprovação).
      const INSISTIR_DIAS = [1, 2];
      for (const jid of Object.keys(chats)) {
        const c = chats[jid]; if (!c || !c.ult || !['ia', 'aviso'].includes(c.ultAutor)) continue;
        if ((estado.visitas || {})[jid] || (estado.retornos || {})[jid]) continue;
        const p = conversaParada(jid); if (!p) continue;
        const dias = (agora - p.ultCli) / 864e5; if (dias < 1 || dias >= 3) continue;   // só nos 2 dias seguintes; quem já passou disso é com o Djhonata
        if (agora - p.ultIa < 20 * 3600e3) continue;                                  // já mandamos algo nas últimas 20 horas
        if (Object.values(estado.insistir || {}).filter(r => agora - (r.em || 0) < 864e5).length >= 60) break;   // trava: no máximo 60 tentativas automáticas por dia
        const reg = (estado.insistir || {})[jid], feitas = reg && reg.base === p.ultCli ? reg.n || 0 : 0;
        if (feitas >= INSISTIR_DIAS.length || dias < INSISTIR_DIAS[feitas]) continue;
        const r = (estado.retomadas || {})[jid], diaDe = (ms) => new Date(ms - 3 * 3600e3).toISOString().slice(0, 10);
        if (r && diaDe(r.em || 0) === diaDe(agora)) continue;                        // já retomou hoje
        if (!rotinaPermitida(jid, 'retomada')) continue;
        if (adiouEMarca(jid)) continue;   // o cliente disse quando pode: chama na data, não antes
        fila.push({ jid, tipo: 'insistir', p, n: feitas + 1, dias: Math.floor(dias) });
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
  } else if (it.tipo === 'insistir') {
    const foco = it.n === 1 ? 'retome de onde parou com algo novo: a resposta da dúvida dele, um fato do imóvel que ele viu (ou o vídeo, se ainda não mandou) ou a conta com o sinal, e uma pergunta' : 'convide para vir ao escritório (ou ver o imóvel) com dois horários livres de agenda_visita a partir de amanhã; é a última tentativa automática, sem dizer isso a ele';
    instr = `[ROTINA AUTOMÁTICA — não é mensagem do cliente] Follow-up automático ${it.n} de 2 (depois da retomada do primeiro dia): o cliente parou de responder há ${it.dias} dia${it.dias === 1 ? '' : 's'}. Releia a conversa inteira. Mande UMA mensagem curta (até 2 frases), natural, na voz do Djhonata: ${foco}. Nunca repita frase, pergunta, dia ou horário que já mandou (os horários antigos já passaram), nunca "e aí, pensou?", nunca cobre resposta. Responda só NO_REPLY se: ele disse que não quer, desistiu, comprou com outro, está sem perfil, combinou de retornar numa data, ou a conversa terminou com despedida.`;
    extra = { rotina: 'retomada' };
    estado.insistir = estado.insistir || {}; estado.insistir[jid] = { base: it.p.ultCli, n: it.n, em: Date.now() };
    for (const [k, r] of Object.entries(estado.insistir)) if (Date.now() - (r.em || 0) > 10 * 864e5) delete estado.insistir[k];
    estado.retomadas = estado.retomadas || {}; estado.retomadas[jid] = { base: it.p.ultCli, em: Date.now() };
    salvarEstado();
    liberado24h.add(jid);
  } else if (it.tipo === 'naoveio') {
    instr = `[ROTINA AUTOMÁTICA — não é mensagem do cliente] Não compareceu: o cliente tinha visita marcada para ${descreverQuando(it.n.q)}, ${it.n.local ? 'no imóvel (' + it.n.local + ')' : 'no escritório'}, e não veio nem avisou. O Djhonata colocou o card em "Remarcar visita". Releia a conversa e mande UMA mensagem curta, leve e sem cobrança: diga que ficou esperando ele no dia da visita (se a visita foi hoje, diga "hoje"), que imprevisto acontece, e pergunte qual dia e horário fica melhor para remarcar (pode sugerir dois horários livres, consultando agenda_visita). Não mande o link, não repita a apresentação do imóvel e não diga que ele faltou ou que desmarcou. Se ele responder com dia e hora, marque com agenda_visita.`;
    extra = { rotina: 'retomada' };
    it.n.feito = Date.now(); estado.retomadas = estado.retomadas || {}; estado.retomadas[jid] = { base: c.ultCliente || 0, em: Date.now() }; salvarEstado();
    liberado24h.add(jid);
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
    instr = `[ROTINA AUTOMÁTICA — não é mensagem do cliente] Lembrete de visita (${it.tipo === 'l24' ? '1 de 2, cerca de 24 horas antes' : '2 de 2, no dia, algumas horas antes'}). A visita está marcada para ${descreverQuando(it.v.q)}, ${it.v.local ? 'NO IMÓVEL: ' + it.v.local + ' (o Djhonata encontra o cliente lá; não fale do escritório)' : 'no escritório da Euro (Rua Dona Francisca, 1222 - Saguaçu)'}. Releia a conversa. Se o cliente cancelou, desmarcou, disse que não vai ou pediu para remarcar, NÃO mande lembrete: use registrar_crm com novoStatus remarcar e responda NO_REPLY. Se não, mande um lembrete curto e simpático com o dia, o horário e o endereço, sem valores, sem material novo e sem a agenda. Termine pedindo para ele confirmar (ex.: "Me confirma se fica de pé?").`;
    // 23/11/2026 (Djhonata): muita gente marca e não vem. Quem não confirmou o lembrete da véspera recebe o do dia EM ÁUDIO, pedindo confirmação.
    if (it.tipo === 'l2' && (it.v.enviados || {}).l24) { const cf = visitaConfirmacao(it.jid, { enviados: { l24: it.v.enviados.l24 } });
      if (cf.conf !== 'sim') { instr += ' IMPORTANTE: ele AINDA NÃO CONFIRMOU o lembrete de ontem. Mande este lembrete EM ÁUDIO ([[tts:...]]), curto (uns 15 segundos), caloroso e natural, como o Djhonata falaria: "tô te esperando hoje às ...", o endereço, e peça para ele confirmar respondendo aqui; se não puder vir, sem problema, é só avisar que a gente remarca. Depois do áudio, mande em texto só o endereço.'; it.v.pediuConf = Date.now(); } }
    // Nome antes da visita (pedido do Djhonata, 17/11/2026): quem está na agenda sem nome de verdade ("Sem nome" no CRM, perfil que não é nome de gente) recebe a pergunta do nome junto com o lembrete.
    { const t8n = tel8Chat(it.jid), cn = t8n ? String((estado.crmNomes || {})[t8n] || '') : '';
      if (/^sem nome/i.test(cn.trim()) || (!nomeDoCrm(it.jid) && !/^\p{Lu}?\p{Ll}{2,}( \p{L}+)*$/u.test(String((chats[it.jid] || {}).nome || '').trim())))
        instr += ' ATENÇÃO: o Djhonata ainda NÃO sabe o nome de verdade deste cliente (o perfil dele não é nome de gente). Se ele ainda não disse o nome nesta conversa, NÃO o chame pelo apelido do perfil e, nesta mesma mensagem, logo depois do lembrete, peça o nome: "Pra eu deixar certo na agenda, como é o teu nome?". Essa é a única pergunta da mensagem (não peça para confirmar junto). Quando ele responder, use registrar_crm com nomeReal.'; }
    extra = { rotina: 'lembrete' };
    it.v.enviados = it.v.enviados || {}; it.v.enviados[it.tipo] = Date.now(); salvarEstado();
    liberado24h.add(jid);
  }
  ocupado.add(jid); emitir('digitando', { jid, on: true });
  try {
    await responder({ jid, telefone: c.telefone || '', nome: c.nome || '', dono: false, imagens: [], rotina: instr, extra });
    if (it.tipo === 'retomada' || it.tipo === 'insistir' || it.tipo === 'ordem' || it.tipo === 'retorno' || it.tipo === 'naoveio') rotinas.retomadas++; else rotinas.lembretes++;
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
const FU_DIA = Number(ENV.FOLLOWUP_DIA || 50), FU_INI = '09:00', FU_FIM = '19:00', FU_FIM_SAB = '12:00';
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
// Quem está em "Remarcar visita" no CRM sai antes dos perdidos (pedido do Djhonata, 17/11/2026: já agendaram uma vez, estão mais quentes).
const fuQuente = (v) => ((estado.crmStatus || {})[String(v.tel8 || v.tel || '').replace(/\D/g, '').slice(-8)] === 'novo' ? 1 : 0);
function fuFilaAprovada() { return Object.values(fu).filter(v => v.status === 'aprovado').sort((a, b) => fuQuente(b) - fuQuente(a) || (b.prioridade || 0) - (a.prioridade || 0) || (a.aprovadoEm || 0) - (b.aprovadoEm || 0)); }
function fuNaJanela(ms) { const d = spDe(ms), m = d.getUTCHours() * 60 + d.getUTCMinutes(); return m >= minutos(FU_INI) && m <= fuFimDoDia(d.getUTCDay()); }
function fuProximaAbertura(ms) {   // próximo 9h (segunda a sábado) depois de ms
  const d = spDe(ms); let t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 9 + 3, 0);
  if (t <= ms) t += 864e5;
  while (spDe(t).getUTCDay() === 0) t += 864e5;
  return t;
}
function fuPrevisoes() {   // quando cada aprovado deve sair (estimativa: uns 20 minutos entre um e outro)
  const out = {}; let t = Math.max(Date.now(), fuUltimoEnvio() + 11 * 60e3), dia = fuDia(t), noDia = dia === fuDia(Date.now()) ? fuEnviadosHoje() : 0;
  for (const x of fuFilaAprovada()) {
    for (let g = 0; g < 500; g++) {
      if (fuDia(t) !== dia) { dia = fuDia(t); noDia = 0; }
      if (fuNaJanela(t) && noDia < FU_DIA) break;
      const d = spDe(t), m = d.getUTCHours() * 60 + d.getUTCMinutes();
      t = (d.getUTCDay() !== 0 && m < minutos(FU_INI) && noDia < FU_DIA) ? t + (minutos(FU_INI) - m) * 60e3 : fuProximaAbertura(t);
    }
    out[x.tel8] = t; noDia++; t += 11 * 60e3;
  }
  return out;
}
function fuResumo() {
  const contagem = {}; for (const v of Object.values(fu)) contagem[v.status] = (contagem[v.status] || 0) + 1;
  const prev = fuPrevisoes(), prox = Math.min(...Object.values(prev), Infinity);
  return { contagem, hoje: fuEnviadosHoje(), limiteDia: FU_DIA, gerando: (contagem.fila || 0) + (contagem.gerando || 0), proximo: isFinite(prox) ? prox : 0 };
}
// 23/11/2026 (Djhonata): última interação do cliente (qualquer mensagem, nossa ou dele) para o follow-up não repetir o que já foi mandado por pendência, oportunidade ou conversa.
function fuUltima(x) {
  try { const jid = acharJid(fuNumero(x.tel) + '@s.whatsapp.net'); if (!chats[jid]) return { em: 0, autor: '', texto: '' };
    let em = 0, autor = '', texto = '';
    for (const m of lerEsp(jid)) { if (m.autor === 'aviso' || m.tipo === 'reacao' || (m.ts || 0) <= em) continue; em = m.ts || 0; autor = m.followup ? 'followup' : m.autor; texto = String(m.texto || (m.tipo ? '[' + m.tipo + ']' : '')).replace(/\s+/g, ' ').slice(0, 90); }
    const rc = ((estado.reacoesCli || {})[jid]) || 0; if (rc > em) { em = rc; autor = 'cliente'; texto = '[reagiu a uma mensagem]'; }
    return { em, autor, texto };
  } catch (e) { return { em: 0, autor: '', texto: '' }; }
}
function fuVarrer() {   // pronto ou programado que ficou velho: o cliente escreveu, ou nós mandamos algo depois que o texto foi preparado
  let n = 0, limpos = 0;
  for (const x of Object.values(fu)) {
    if (!['pronto', 'aprovado'].includes(x.status)) continue;
    { const m2 = semDiminutivo(x.mensagem || ''); if (m2 !== (x.mensagem || '')) { x.mensagem = m2; limpos++; } }   // 23/11/2026 (Djhonata): nada de diminutivo, nem nos textos já preparados
    { const stc = (estado.crmStatus || {})[x.tel8]; if (['semperfil', 'desistiu', 'fechado', 'pausado', 'corretor', 'construtor', 'pessoal'].includes(stc)) { Object.assign(x, { status: 'cancelado', erro: 'o card está em ' + stc + ' no CRM: não recebe follow-up' }); n++; continue; } }
    const t0 = x.geradoEm || x.criadoEm || 0, u = fuUltima(x); if (!u.em || u.em <= t0 + 1000 || u.autor === 'followup') continue;
    if (u.autor === 'cliente') Object.assign(x, { status: 'cancelado', erro: 'o cliente escreveu em ' + quandoFoi(u.em) + ' (a conversa continua no atendimento)' });
    else if (Date.now() - u.em < 7 * 864e5) Object.assign(x, { status: 'cancelado', erro: 'você já mandou mensagem em ' + quandoFoi(u.em) + ' (pendência, oportunidade ou conversa): não sai para não repetir. Use Atualizar depois de 7 dias' });
    else Object.assign(x, { status: 'fila', tent: 0, erro: '' });
    n++;
  }
  if (n || limpos) { salvarFu(); setTimeout(fuTrabalhar, 500); log('follow-up: varredura tirou ou refez', n, limpos ? '| textos sem diminutivo ' + limpos : ''); }
  return n;
}
setInterval(() => { try { fuVarrer(); } catch (e) { log('follow-up varrer', e.message); } }, 10 * 60e3);
setTimeout(() => { try { fuVarrer(); } catch (e) { } }, 90e3);
// 24/11/2026 (Djhonata): na lista do follow-up o que importa é quando o CLIENTE escreveu pela última vez (e o que ele escreveu).
function fuJid(x) { const j = x.jid && chats[x.jid] ? x.jid : acharJid(fuNumero(x.tel) + '@s.whatsapp.net'); return chats[j] ? j : ''; }
function fuCliEm(x) { const j = fuJid(x); return j ? ultCli(j) : 0; }
function fuCliTexto(x) { const j = fuJid(x); if (!j) return ''; const l = lerEsp(j); for (let i = l.length - 1; i >= 0; i--) { const m = l[i]; if (m.autor !== 'cliente') continue; const s = String(m.texto || '').replace(/\s+/g, ' ').trim(); return s ? s.slice(0, 160) : (m.tipo === 'audio' ? '(áudio)' : m.tipo === 'image' ? '(foto)' : '(mensagem)'); } return ''; }
function fuPublico(x, prev) {
  const u = fuUltima(x);
  return { cliEm: fuCliEm(x), cliTexto: fuCliTexto(x), ultimaEm: u.em, ultimaAutor: u.autor, ultimaTexto: u.texto, velho: !!(u.em && u.em > (x.geradoEm || x.criadoEm || 0) + 1000 && u.autor !== 'followup'), tel8: x.tel8, tel: x.tel, id: x.id, nome: x.nome, status: x.status, decisao: x.decisao || '', motivo: x.motivo || '', analise: x.analise || '', mensagem: x.mensagem || '', prioridade: x.prioridade || 0, imovel: x.imovel || '', criadoEm: x.criadoEm, geradoEm: x.geradoEm || 0, aprovadoEm: x.aprovadoEm || 0, enviadoEm: x.enviadoEm || 0, respondeuEm: x.respondeuEm || 0, erro: x.erro || '', jid: x.jid || '', previsao: (prev && prev[x.tel8]) || 0 };
}
function fuEvento(x, novoStatus, resultado) {   // vai para o CRM pelo mesmo caminho dos eventos da assistente
  try { fs.appendFileSync(path.join(DADOS, 'eventos-crm.jsonl'), JSON.stringify({ rid: 'fu' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), ts: new Date().toISOString(), telefone: formatoBR(fuNumero(x.tel)), nome: x.nome || '', novoStatus, resultado }) + '\n'); } catch (e) { }
}
// 23/11/2026 (Djhonata, caso Gabriele): a oferta de quarta não ficou anotada no card e o CRM deixou mandar o mesmo imóvel de novo, cinco dias depois.
// A verdade é a conversa: daqui sai cada imóvel que o cliente já recebeu de nós (legenda ou texto com "🏠 Nome").
const RE_CASA_NOME = /🏠\s*([^\n\/|]{3,80})/gu;
let ofEnvCache = { em: 0, mapa: {} };
function nomesMandados(jid) {   // { nome sem acento: hora da última vez }
  const o = {}; let l = []; try { l = lerEsp(jid); } catch (e) { return o; }
  for (const m of l) { if (m.autor === 'cliente' || m.autor === 'aviso' || !m.texto) continue; for (const x of String(m.texto).matchAll(RE_CASA_NOME)) { const n = semAcento(x[1]).trim(); if (n && (!o[n] || (m.ts || 0) > o[n])) o[n] = m.ts || 1; } }
  return o;
}
function jaRecebeuImovel(jid, nome) {   // hora em que este cliente recebeu o imóvel (0 = nunca); olha todas as conversas do mesmo telefone
  const alvo = semAcento(nome).trim(), t8 = tel8De(jid); if (!alvo) return 0; let ja = 0;
  for (const j of new Set([jid, ...Object.keys(chats).filter(k => t8 && t8.length === 8 && tel8De(k) === t8)])) { const o = nomesMandados(j); if (o[alvo]) ja = Math.max(ja, o[alvo]); }
  return ja;
}
function ofertasEnviadas(quer) {   // { final do telefone: { nome: hora } } de todas as conversas (refaz no máximo a cada 3 min)
  if (Date.now() - ofEnvCache.em > 3 * 60e3) {
    const mapa = {};
    for (const j of Object.keys(chats)) { const t8 = tel8De(j); if (!t8 || t8.length !== 8) continue; const o = nomesMandados(j); for (const n of Object.keys(o)) { const d = mapa[t8] = mapa[t8] || {}; if (!d[n] || o[n] > d[n]) d[n] = o[n]; } }
    ofEnvCache = { em: Date.now(), mapa };
  }
  if (!quer || !quer.size) return ofEnvCache.mapa;
  const out = {};
  for (const [t8, o] of Object.entries(ofEnvCache.mapa)) for (const [n, ts] of Object.entries(o)) if (quer.has(n)) (out[t8] = out[t8] || {})[n] = ts;
  return out;
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
${(estado.crmStatus || {})[x.tel8] === 'novo' ? 'FOLLOW-UP DE CLIENTE EM "REMARCAR VISITA". Este cliente já marcou visita no escritório e não veio ou desmarcou. O objetivo é ele marcar de novo. Leia na conversa por que não veio (se disse) e quando foi isso.' : 'FOLLOW-UP DE CLIENTE PERDIDO. O Djhonata quer retomar o contato com este cliente, que parou de responder há mais de 7 dias (está em "Perdido" no CRM).'} A mensagem só sai depois que o Djhonata aprovar.

DADOS DO CRM
${dados || '(nada anotado)'}

CONVERSA NO WHATSAPP (a mais recente por último)
${conversa || '(não há conversa deste cliente neste WhatsApp: use só os dados do CRM)'}

O QUE FAZER
1) Decida:
- "desistiu": o cliente disse claramente que não quer mais, que já comprou (com outro corretor, imobiliária ou construtora), pediu para não receber mais mensagens, ou adiou ("agora não", "vou deixar para frente", "sem condições no momento"). Não escreva mensagem.
- "sem_perfil": pelas regras SEM PERFIL AGORA e TERRENO E PERMUTA (renda bruta somada abaixo de R$ 4 mil, só consegue pagar uns R$ 500 por mês, quer imóvel fora de Joinville, ou só quer vender terreno/imóvel sem permuta). Só use se isso estiver dito na conversa ou no CRM. Não escreva mensagem.
- "nao_cliente": é corretor, construtor, fornecedor, contato pessoal, ou a conversa não é sobre comprar imóvel. Não escreva mensagem.
- "enviar": nos outros casos.
2) Se for "enviar", escreva UMA mensagem de WhatsApp curta (no máximo 3 frases), na voz do Djhonata, em primeira pessoa, retomando de onde parou, com o gancho que mais pode converter este cliente:
 REGRA PRINCIPAL (23/11/2026, Djhonata; caso Nilza): se o cliente demonstrou interesse num imóvel que já recebeu (achou bom, perguntou do financiamento, da entrada ou da visita desse imóvel) e não disse que desistiu dele, a mensagem é sobre ESSE imóvel: retome de onde parou (a dúvida dele, a conta ou o dia de vir), pelo gancho c). NÃO ofereça outro imóvel, para não confundir o cliente. Imóvel novo (gancho a) é só para quem não demonstrou interesse em nenhum, ou disse que não gostou do que recebeu. Se o que travou foi o horário (trabalha direto, não sabia se conseguia vir), pergunte que horas ele sai do trabalho, para você ver um horário depois disso; não afirme nada sobre o horário de trabalho dele que ele não disse. Nunca repita dias ou horários oferecidos antes na conversa: eles já passaram (24/11/2026: o follow-up do Fabricio ofereceu de novo "quarta, dia 18" e "quinta, dia 19" uma semana depois). Para convidar, pergunte qual dia da semana fica melhor para ele vir.
 a) um imóvel do catálogo atual (CATALOGO.md) que encaixa no que ele procurava (bairro, valor, tipo, quartos, pronto ou na planta), citando o nome ou a rua e o bairro, só com dados do catálogo. O imóvel TEM que ter foto para mandar: nunca cite um da lista IMÓVEL COM CADASTRO INCOMPLETO (sem foto ou sem dormitórios), porque se o cliente pedir as fotos a gente precisa mandar na hora (23/11/2026: o follow-up do Jean citou o Samara III, que não tem foto, e ele pediu as fotos); ou
 b) se a dificuldade foi a entrada ou o valor: que agora dá para montar com entrada menor (sinal flexível, entrada parcelada até a entrega, FGTS, financiamento pela avaliação do banco), sem números que não estejam no catálogo e sem prometer aprovação; ou
 c) se ele já tinha gostado de um imóvel e só faltou marcar: um convite para passar no escritório tirar as dúvidas.
 NÃO PODE PARECER ROBÔ (25/11/2026, Djhonata): a primeira frase muda sempre e soa como ele escrevendo na hora. Leia as mensagens nossas na conversa acima e NUNCA comece igual ou parecido com uma delas. Proibido "Lembrei de você porque", "acabou de entrar um imóvel novo", "que é a região que você procurava" e lista de dados do imóvel (quartos, vagas, preço, entrega todos juntos): fale o essencial em linguagem de conversa. Se já conversamos com ele antes neste WhatsApp, não se apresente de novo nem comece com "Oi! Tudo bem? Aqui é o Djhonata, da Euro": entre direto, pelo nome se tiver (ex.: "Gabriel, olha esse que entrou no Comasa: 2 quartos, 2 vagas e a entrada parcelada até 2028."). Termine com uma pergunta simples que convide a responder. Não prometa mandar nada depois ("vou separar as fotos", "confirmo e te falo"): se citar um imóvel, as fotos dele precisam existir para mandar quando ele pedir. Não diga que ele sumiu, que parou de responder ou que é um follow-up. Não mande link nem agenda nesta mensagem (se ele responder, a conversa continua). Só use 🙏🏼 (agradecer) ou ✅ (confirmar) como emoji, nunca 👍, sem negrito e sem lista. Chame pelo primeiro nome só se for nome de pessoa (do CRM ou dito na conversa). Se nunca conversaram neste WhatsApp, apresente-se em poucas palavras ("aqui é o Djhonata, da Euro Consultoria"). Se a última mensagem da conversa já é do Djhonata e ficou sem resposta (ex.: "Estou com imóveis novos em Joinville. Qual bairro você busca?"), não repita a mesma ideia: traga algo concreto e novo.
EM DIA COM O WHATSAPP (26/11/2026, Djhonata: "o follow-up tem que estar em sintonia com o que está acontecendo no WhatsApp"; caso Inês):
 - Cliente SEM conversa neste WhatsApp (veio importado de antes) NÃO é desistência nem falta de base: decida "enviar" e use os dados do CRM, pelo gancho a); sem dado nenhum, pergunte de forma simples se ainda procura casa e em qual bairro.
 - O que está na conversa do WhatsApp vale acima das anotações do CRM, que podem estar velhas. A data de hoje está no começo das instruções, e cada mensagem da conversa mostra quando foi: leia as datas.
 - Nunca responda a uma mensagem antiga do cliente como se ela tivesse chegado agora. Erro: a Inês disse em 07/11 que não vinha por causa da chuva, e o follow-up de 26/11 começou com "sem problema com a chuva". O que ele disse há dias pode ser lembrado, mas como passado.
 - Se a nossa última mensagem ficou sem resposta, a nova NÃO pode repetir a ideia dela nem com outras palavras (erro: em 17/11 mandamos "quando quiser, a gente vê com calma no escritório a troca do seu sobrado... qual dia da semana fica melhor?" e o follow-up novo repetia isso). Traga um ângulo novo e concreto: uma pergunta curta e fácil de responder (sim ou não), resolver um passo por aqui mesmo (ex.: "quer que eu te mande a conta da troca por aqui?"), uma informação nova e verdadeira do imóvel que ele gostou, ou perguntar se ele ainda está procurando.
3) Prioridade de 1 a 5: 5 = muito quente (marcou visita, pediu simulação, perguntou de entrada ou financiamento com os dados dele, gostou de um imóvel); 3 = pediu informações e conversou; 1 = só a primeira mensagem do anúncio, sem conversa.
Responda SOMENTE com um JSON válido, sem texto antes ou depois:
{"decisao": "enviar|desistiu|sem_perfil|nao_cliente", "motivo": "frase curta", "analise": "1 ou 2 frases: o que ele procurava, onde parou e qual gancho você usou", "prioridade": 1, "imovel": "imóvel citado ou vazio", "mensagem": "texto da mensagem ou vazio"}`;
}
function fuParecido(a, b) {   // 26/11/2026: quanto das palavras da mensagem nova já estava numa mensagem nossa (0 a 1)
  const w = (s) => new Set(semAcento(String(s || '')).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(p => p.length > 3));
  const A = w(a), B = w(b); if (A.size < 4 || B.size < 4) return 0; let i = 0; for (const p of A) if (B.has(p)) i++; return i / Math.min(A.size, B.size);
}
async function fuGerarUm(x) {
  x.status = 'gerando'; x.tent = (x.tent || 0) + 1;
  try {
    const jid = acharJid(fuNumero(x.tel) + '@s.whatsapp.net'), temChat = !!chats[jid];
    const system = sistema({ jid: temChat ? jid : '', telefone: x.tel, nome: x.nome, dono: false, notas: [] });
    const txt = await claudeTexto(system, fuTarefa(x, temChat ? fuConversa(jid) : '') + (x.erro && x.tent > 1 ? '\n\nATENÇÃO: a mensagem anterior foi recusada por este motivo: ' + x.erro + ' Escreva outra sem esse problema.' : ''), 1500);
    const i = txt.indexOf('{'), j = txt.lastIndexOf('}'); if (i < 0 || j < i) { log('follow-up: resposta sem JSON', x.tel, JSON.stringify(String(txt).slice(0, 160))); throw new Error('a IA não devolveu o JSON'); }
    const r = JSON.parse(txt.slice(i, j + 1));
    if (x.status !== 'gerando') return;   // cancelado enquanto a IA pensava (ex.: o cliente voltou a escrever)
    let semPerfil = r.decisao === 'sem_perfil', dec = semPerfil ? 'desistiu' : ['enviar', 'desistiu', 'nao_cliente'].includes(r.decisao) ? r.decisao : 'enviar';
    // 26/11/2026: sem o cliente ter escrito nada neste WhatsApp, a IA não pode dar desistência (ela tinha marcado 46 perdidos importados como desistiu)
    if (dec === 'desistiu' && !(temChat && lerEsp(jid).some(m => m.autor === 'cliente' && String(m.texto || '').trim()))) throw new Error('cliente sem conversa neste WhatsApp não é desistência: decida enviar e escreva a mensagem pelo gancho a), com um imóvel do catálogo que encaixa no que o CRM diz que ele procurava (ou, sem dado nenhum, pergunte se ainda procura casa e em qual bairro)');
    Object.assign(x, { decisao: dec, motivo: String(r.motivo || '').slice(0, 300), analise: String(r.analise || '').slice(0, 700), prioridade: Math.max(1, Math.min(5, Math.round(Number(r.prioridade) || 1))), imovel: String(r.imovel || '').slice(0, 120), geradoEm: Date.now(), erro: '', jid: temChat ? jid : '' });
    if (dec === 'enviar') {
      const msg = String(r.mensagem || '').trim(); if (!msg) throw new Error('a IA não escreveu a mensagem');
      { const pr = problemaNoRascunho(msg); if (pr) throw new Error(pr.replace(/^Não enviei: /, '').replace(/ Ajuste e envie de novo\.$/, '')); }
      if (temChat) { const nossas = lerEsp(jid).filter(m => m.autor !== 'cliente' && m.autor !== 'aviso' && String(m.texto || '').length > 40).slice(-4); const igual = nossas.find(m => fuParecido(msg, m.texto) >= 0.6); if (igual) throw new Error('ficou parecida demais com uma mensagem que já mandamos ("' + String(igual.texto).slice(0, 90) + '"): escreva com um ângulo novo'); }   // 26/11/2026 (caso Inês)   // 24/11/2026: data que já passou, colchetes ou terceira pessoa: refaz
      x.mensagem = semDiminutivo(msg).slice(0, 1200); x.status = 'pronto';
    } else {
      x.mensagem = ''; x.status = dec;
      if (semPerfil) { x.motivo = 'Sem perfil: ' + (x.motivo || ''); fuEvento(x, 'sem_perfil', 'Follow-up dos perdidos: ' + x.motivo); }
      else if (dec === 'desistiu') fuEvento(x, 'sem_interesse', 'Follow-up dos perdidos: ' + (x.motivo || 'disse que não quer mais'));
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
// 24/11/2026: follow-up pronto (ou aprovado e ainda não enviado) com data que já passou, colchetes ou terceira pessoa volta para a IA refazer.
setTimeout(() => { let n = 0; for (const v of Object.values(fu)) { if (!['pronto', 'aprovado'].includes(v.status) || !v.mensagem) continue; const pr = problemaNoRascunho(v.mensagem); if (!pr) continue; Object.assign(v, { status: 'fila', tent: 1, erro: pr.replace(/^Não enviei: /, '').replace(/ Ajuste e envie de novo\.$/, ''), aprovadoEm: 0 }); n++; } if (n) { salvarFu(); log('follow-up: ' + n + ' mensagens prontas com data vencida ou marcação voltaram para a IA refazer'); } }, 25e3);
setTimeout(fuTrabalhar, 20e3);
// 24/11/2026 (Djhonata): cliente que não responde não fica recebendo mensagem para sempre. Conta as tentativas nossas (dias diferentes, 12 horas ou mais
// depois da última fala do cliente) desde que ele falou pela última vez. 3 sem resposta = pausa de 60 dias; depois 1 tentativa com novidade e, sem
// resposta, pausa de 90 dias; depois disso só volta se ele chamar. Respondeu = zera.
function fuPausa(jid) {
  if (!jid || !chats[jid]) return null;
  const uc = ultCli(jid) || 0, dias = new Map();
  for (const m of lerEsp(jid)) {
    if (m.autor === 'cliente' || m.autor === 'aviso' || m.tipo === 'reacao') continue;
    const ts = m.ts || 0; if (ts <= uc + 7 * 864e5) continue;   // as tentativas dos 7 primeiros dias (automáticas) não contam para a pausa
    const d = new Date(ts - 3 * 3600e3).toISOString().slice(0, 10); dias.set(d, Math.max(dias.get(d) || 0, ts));
  }
  const tent = [...dias.values()].sort((a, b) => a - b), n = tent.length, ult = tent[n - 1] || 0;
  if (n >= 5) return { n, ate: Infinity, motivo: n + ' tentativas sem resposta desde ' + (uc ? quandoFoi(uc) : 'sempre') + ': só volta se o cliente chamar' };
  if (n === 4) return { n, ate: ult + 90 * 864e5, motivo: '4 tentativas sem resposta (a última depois da pausa): pausa de 90 dias' };
  if (n === 3) return { n, ate: ult + 60 * 864e5, motivo: '3 tentativas sem resposta: pausa de 60 dias' };
  return { n, ate: 0 };
}
async function fuEnviar(x) {   // devolve 'enviado', 'cancelado' ou 'erro'
  const fim = (status, erro) => { Object.assign(x, { status, erro }); salvarFu(); return status; };
  const num = fuNumero(x.tel); if (num.length < 12) return fim('erro', 'telefone inválido');
  let jid = acharJid(num + '@s.whatsapp.net');
  if (chats[jid] && ultCli(jid) > (x.geradoEm || x.criadoEm || 0)) return fim('cancelado', 'o cliente voltou a escrever antes do envio');
  // Remarcar visita (17/11/2026, Djhonata): já agendou uma vez, está mais quente. Aprovou, sai: fica fora das duas regras dos 7 dias e sai antes dos perdidos.
  const remarcar = (estado.crmStatus || {})[x.tel8] === 'novo';
  { const pz = fuPausa(jid); if (pz && pz.ate > Date.now()) return fim('cancelado', 'pausado até ' + (pz.ate === Infinity ? 'o cliente chamar' : new Date(pz.ate - 3 * 3600e3).toISOString().slice(0, 10).split('-').reverse().join('/')) + ': ' + pz.motivo); }
  // follow-up em massa é só para quem está há 7 dias ou mais sem interagir (mensagem ou reação) — regra do Djhonata, 16/11/2026
  if (!remarcar) { const ultInter = Math.max(chats[jid] ? ultCli(jid) : 0, ((estado.reacoesCli || {})[jid]) || 0); if (ultInter && Date.now() - ultInter < 7 * 864e5) return fim('cancelado', 'o cliente interagiu nos últimos 7 dias'); }
  // Você (ou a assistente) já falou com o cliente depois que este texto foi preparado: o follow-up pronto ficou velho e sairia como mensagem repetida (pedido do Djhonata, 13/11/2026).
  try { const t0 = x.geradoEm || x.criadoEm || 0; if (t0 && chats[jid] && lerEsp(jid).some(m => m.autor !== 'cliente' && m.autor !== 'aviso' && !m.followup && (m.ts || 0) > t0)) return fim('cancelado', 'você já falou com o cliente depois que este follow-up foi preparado'); } catch (e) { }
  // 16/11/2026 (Djhonata): a NOSSA mensagem também conta. Quem recebeu qualquer mensagem deste WhatsApp (sua, da assistente ou outro follow-up) há menos de 7 dias não recebe follow-up agora.
  if (!remarcar) try { let un = 0; if (chats[jid]) for (const m of lerEsp(jid)) if (m.autor !== 'cliente' && m.autor !== 'aviso' && m.tipo !== 'reacao' && (m.ts || 0) > un) un = m.ts; if (un && Date.now() - un < 7 * 864e5) return fim('cancelado', 'já recebeu mensagem nossa nos últimos 7 dias'); } catch (e) { }
  const st = (estado.crmStatus || {})[x.tel8]; if (st && st !== 'perdido' && st !== 'novo') return fim('cancelado', 'saiu de Perdido no CRM');
  { const rt = (estado.retornos || {})[jid]; if (rt && quandoMs(rt.q) > Date.now() - 6 * 3600e3) return fim('cancelado', 'o cliente pediu para ser chamado ' + descreverQuando(rt.q) + ': a assistente chama nesse dia'); }   // 24/11/2026
  // Mensagem não entregue (17/11/2026): as últimas mensagens para este número ficaram só com um tique por 2 dias ou mais. Pode ter bloqueado, trocado de número ou estar sem WhatsApp: não gasta envio.
  { const dse = semEntregaDias(jid); if (dse) return fim('cancelado', 'as últimas mensagens não foram entregues há ' + dse + ' dias (pode ter bloqueado ou trocado de número)'); }
  if (lerBloqueados().has(num) || (estado.equipe || []).includes(x.tel8) || ehDono(num)) return fim('cancelado', 'número bloqueado para a assistente');
  const texto = semDiminutivo(String(x.mensagem || '').trim()); if (!texto) return fim('erro', 'mensagem vazia');
  { const pr = problemaNoRascunho(texto); if (pr) return fim('erro', pr); }
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
  if (!fuRun.proximoIntervalo) fuRun.proximoIntervalo = acaso(8, 13) * 60e3;
  if (Date.now() - fuUltimoEnvio() < fuRun.proximoIntervalo) return;
  for (const x of fuFilaAprovada()) {
    let r = 'erro'; try { r = await fuEnviar(x); } catch (e) { log('follow-up: erro ao enviar', x.tel, e.message); }
    if (r === 'enviado') { fuRun.proximoIntervalo = acaso(8, 13) * 60e3; return; }
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
    usoHoje: hoje, revisorHoje: (estado.revisor || {})[agoraSP().toISOString().slice(0, 10)] || null, modelo: MODELO, teste: estado.teste && estado.teste.ativo ? (estado.teste.numeros || []) : [],
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
    s.ev.on('messages.update', (ups) => { for (const u of ups || []) { try { if (u && u.key && u.key.fromMe && u.update && Number(u.update.status) >= 3) entregaConfirmar(u.key.id); } catch (e) { } } });
    s.ev.on('message-receipt.update', (ups) => { for (const u of ups || []) { try { if (u && u.key && u.key.fromMe) entregaConfirmar(u.key.id); } catch (e) { } } });
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
// ---------- arquivamento automático (23/11/2026, Djhonata) ----------
// Todo dia às 22h: primeiro atualiza as etiquetas pelo último status que o CRM mandou, depois arquiva quem já comprou ou desistiu,
// os perdidos, corretores, construtores e contatos pessoais. Quem está em atendimento, visita, negociação, remarcar, com etiqueta
// Importante, com mensagem não lida ou que falou nas últimas 24 h fica. Se a pessoa escrever de novo, a conversa desarquiva sozinha.
function catArquivo(jid) {
  if (!jidValido(jid) || ehDono(pnDe(jid) || jid)) return '';
  const c = chats[jid] || {}; if (c.arquivado) return '';
  const t = tel8Chat(jid), agora = Date.now(), uc = ultCli(jid);
  const etqs = etiquetasDe(jid).map(e => semAcento(e.nome));
  if (etqs.some(n => /import/.test(n))) return '';
  if (filas.has(jid) || ocupado.has(jid) || (estado.visitas || {})[jid]) return '';
  if (uc && agora - uc < 864e5) return '';
  if (c.ultAutor === 'cliente' && uc && agora - uc < 3 * 864e5) return '';   // o cliente falou por último há menos de 3 dias: fica
  if (t && (estado.equipe || []).includes(t)) return 'corretor';
  const s = t ? (estado.crmStatus || {})[t] || '' : '';
  if (['visita', 'negociacao', 'novo'].includes(s)) return '';
  if (s === 'atendimento') return (!uc || agora - uc > 7 * 864e5) ? 'perdido' : '';   // em atendimento mas 7 dias sem o cliente falar = perdido (regra dos 7 dias)
  if (s === 'fechado' || s === 'desistiu') return 'comprou';
  if (['corretor', 'corretor_euro', 'construtor', 'pessoal'].includes(s)) return s === 'corretor_euro' ? 'corretor' : s;
  if (etqs.some(n => /visita|negocia|remarcar|atendimento/.test(n))) return '';
  if (etqs.some(n => /finaliz|pago|comprou|vendid|desist/.test(n))) return 'comprou';
  if (etqs.some(n => /corretor/.test(n))) return 'corretor';
  if (etqs.some(n => /capta|constru/.test(n))) return 'construtor';
  if (etqs.some(n => /pessoal/.test(n))) return 'pessoal';
  if (s === 'perdido' || s === 'pausado') return 'perdido';
  if (!s && agora - Math.max(uc || 0, c.ult || 0) > 7 * 864e5) return 'perdido';
  return '';
}
// Dúvidas anotadas para o Djhonata (23/11/2026): saem sozinhas da lista quando alguém responde na conversa (você pelo celular,
// pelo CRM ou a assistente a teu pedido), quando o card vai para perdido, desistiu, pausado ou fechado, ou depois de 7 dias.
// ---------- vídeo do imóvel feito das fotos (23/11/2026, pedido do Djhonata: todo imóvel tem que ter vídeo, e é o vídeo que vai primeiro na oferta) ----------
// O servidor monta sozinho o video-whatsapp.mp4 de cada imóvel do catálogo que ainda não tem: as fotos da ficha passando, com o título, os dados, o preço e "Chame no WhatsApp".
const VID_TMP = path.join(DADOS, 'videos-tmp'), VID_FONTE = path.join(DADOS, 'fonte-video.ttf'), VID_MUSICA = path.join(DADOS, 'musica-video.m4a');
const VID_LIGADO = path.join(DADOS, 'videos-ligado');
const vid = { rodando: '', feitos: [], erros: {}, ultima: 0, drawtext: null, fonte: '', musica: null, parar: false };
function vidAcharFonte() {
  if (vid.fonte && fs.existsSync(vid.fonte)) return vid.fonte;
  try { if (fs.statSync(VID_FONTE).size > 20000) return vid.fonte = VID_FONTE; } catch (e) { }
  const cand = []; const anda = (d, n) => { if (n > 5) return; let l = []; try { l = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; } for (const x of l) { const p = path.join(d, x.name); if (x.isDirectory()) anda(p, n + 1); else if (/\.(ttf|otf)$/i.test(x.name)) cand.push(p); } };
  anda('/usr/share/fonts', 0); anda('/usr/local/share/fonts', 0);
  for (const re of [/Poppins-Bold\.ttf$/i, /Montserrat-Bold/i, /DejaVuSans-Bold\.ttf$/i, /LiberationSans-Bold/i, /Bold\.(ttf|otf)$/i, /./]) { const f = cand.find(c => re.test(c)); if (f) return vid.fonte = f; }
  return '';
}
async function vidPreparar() {
  if (vid.drawtext === null) { const r = await rodarFfmpeg(['-hide_banner', '-filters'], null, 15000); const t = String(r.stdout || ''); vid.drawtext = / drawtext /.test(t); vid.xfade = / xfade /.test(t); }
  if (!fs.existsSync(VID_FONTE)) { try { const r = await fetch('https://github.com/google/fonts/raw/main/ofl/poppins/Poppins-Bold.ttf', { signal: AbortSignal.timeout(30000) }); if (r.ok) { const b = Buffer.from(await r.arrayBuffer()); if (b.length > 20000) fs.writeFileSync(VID_FONTE, b); } } catch (e) { log('vídeo: não baixei a fonte', e.message); } }
  vidAcharFonte();
  if (vid.musica === null) {   // a trilha é a mesma dos vídeos que o Djhonata já usa: sai do áudio de um vídeo do catálogo
    vid.musica = '';
    try { if (fs.statSync(VID_MUSICA).size > 30000) vid.musica = VID_MUSICA; } catch (e) { }
    if (!vid.musica) {
      const com = pastasImoveis().map(p => path.join(CATALOGO, p, 'video-whatsapp.mp4')).filter(f => { try { return fs.statSync(f).size > 1e6; } catch (e) { return false; } }).slice(0, 6);
      for (const f of com) {
        const r = await rodarFfmpeg(['-hide_banner', '-loglevel', 'error', '-y', '-i', f, '-vn', '-c:a', 'aac', '-b:a', '128k', VID_MUSICA], null, 60000);
        try { if (r.status === 0 && fs.statSync(VID_MUSICA).size > 30000) { vid.musica = VID_MUSICA; break; } } catch (e) { }
      }
    }
  }
}
function vidTextos(pasta) {
  const f = lerTexto(path.join(pasta, 'ficha.md'));
  const sec = (/## Descrição pronta para o WhatsApp[^\n]*\n([\s\S]*?)(?=\n## |$)/.exec(f) || [])[1] || '';
  const limpa = s => String(s || '').replace(/[\u{1F000}-\u{1FFFF}\u{2190}-\u{2BFF}\u{FE0F}\u{200D}*_]/gu, '').replace(/\s+/g, ' ').trim();
  const ls = sec.split('\n').map(x => x.trim()).filter(Boolean);
  const pega = e => { const l = ls.find(x => x.startsWith(e)); return l ? limpa(l) : ''; };
  const cab = (/^#\s*(.+)$/m.exec(f) || [])[1] || '', [nomeCab, bairroCab] = cab.split(/\s+[—-]\s+/);
  let titulo = ls[0] && /^✨/.test(ls[0]) ? limpa(ls[0]) : ''; if (!titulo && bairroCab) titulo = 'Oportunidade no ' + limpa(bairroCab);
  return {
    titulo: titulo.replace(/[!.]+$/, '').toUpperCase().slice(0, 60),
    nome: (pega('🏠') || limpa(nomeCab)).slice(0, 60),
    dados: pega('📐').replace(/\s*\|\s*/g, ' · ').slice(0, 70),
    preco: pega('💰').replace(/,00\b/, '').slice(0, 40),
    entrega: pega('📅').slice(0, 60),
  };
}
async function vidMontar(fotos, tx, saida, dir) {
  // 24/11/2026 (Djhonata: imagem tremendo): o zoompan arredonda a posição em pixel inteiro; ampliar para 4K antes do zoom deixa o movimento liso.
  const D = 3.2, T = 0.5, DF = 4.4, FPS = 30, n = fotos.length, total = n * (D - T) + DF;
  const seq = fotos.concat([fotos[0]]), args = ['-hide_banner', '-loglevel', 'error', '-y'];
  seq.forEach((f, i) => args.push('-loop', '1', '-framerate', String(FPS), '-t', String(i === n ? DF : D), '-i', f));
  if (vid.musica) args.push('-stream_loop', '-1', '-i', vid.musica);
  let fc = '';
  seq.forEach((f, i) => {
    const fr = Math.round((i === n ? DF : D) * FPS), z = i % 2 === 0 ? `1+0.06*on/${fr}` : `1.06-0.06*on/${fr}`;
    fc += `[${i}:v]split[sa${i}][sb${i}];[sa${i}]scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,boxblur=24:4,eq=brightness=-0.12[bg${i}];[sb${i}]scale=1920:1080:force_original_aspect_ratio=decrease[fg${i}];[bg${i}][fg${i}]overlay=(W-w)/2:(H-h)/2,scale=3840:2160,zoompan=z='${z}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=1280x720:fps=${FPS},setsar=1,format=yuv420p[v${i}];`;
  });
  let ant = 'v0';
  for (let i = 1; i <= n; i++) { fc += `[${ant}][v${i}]xfade=transition=fade:duration=${T}:offset=${(i * (D - T)).toFixed(2)}[x${i}];`; ant = 'x' + i; }
  const fonte = vid.drawtext ? vidAcharFonte() : '';
  if (fonte) {
    const esc = p => p.replace(/\\/g, '/').replace(/([:'])/g, '\\$1');
    const txt = (nome, s) => { const p = path.join(dir, nome + '.txt'); fs.writeFileSync(p, s); return esc(p); };
    const tam = (s, max) => Math.max(22, Math.min(max, Math.floor(1160 / (Math.max(1, s.length) * 0.6))));
    const dt = (arq, s, y, max, a, b) => `drawtext=fontfile='${esc(fonte)}':textfile='${arq}':fontcolor=white:fontsize=${tam(s, max)}:x=(w-text_w)/2:y=${y}:shadowcolor=black@0.6:shadowx=2:shadowy=2:enable='between(t,${a.toFixed(2)},${b.toFixed(2)})'`;
    const f = [], a0 = 0.25, b0 = D - T, a1 = D - T + 0.3, b1 = 2 * (D - T), aF = n * (D - T) + 0.5, bF = total;
    if (tx.titulo || tx.nome) f.push(`drawbox=x=0:y=0:w=iw:h=170:color=black@0.45:t=fill:enable='between(t,${a0},${b0.toFixed(2)})'`);
    if (tx.titulo) f.push(dt(txt('titulo', tx.titulo), tx.titulo, 38, 46, a0, b0));
    if (tx.nome) f.push(dt(txt('nome', tx.nome), tx.nome, tx.titulo ? 104 : 60, 30, a0, b0));
    if (tx.dados && n >= 2) { f.push(`drawbox=x=0:y=ih-110:w=iw:h=110:color=black@0.45:t=fill:enable='between(t,${a1.toFixed(2)},${b1.toFixed(2)})'`); f.push(dt(txt('dados', tx.dados), tx.dados, 'h-78', 34, a1, b1)); }
    f.push(`drawbox=x=0:y=0:w=iw:h=ih:color=black@0.5:t=fill:enable='between(t,${aF.toFixed(2)},${bF.toFixed(2)})'`);
    if (tx.preco) f.push(dt(txt('preco', tx.preco), tx.preco, 'h/2-110', 76, aF, bF));
    if (tx.entrega) f.push(dt(txt('entrega', tx.entrega), tx.entrega, 'h/2', 32, aF, bF));
    f.push(dt(txt('chame', 'Chame no WhatsApp'), 'Chame no WhatsApp', 'h/2+70', 40, aF, bF));
    fc += `[${ant}]${f.join(',')}[vout]`;
  } else fc += `[${ant}]null[vout]`;
  if (vid.musica) fc += `;[${n + 1}:a]atrim=0:${total.toFixed(2)},afade=t=in:d=0.4,afade=t=out:st=${(total - 1.6).toFixed(2)}:d=1.6,volume=0.9[aout]`;
  args.push('-filter_complex', fc, '-map', '[vout]'); if (vid.musica) args.push('-map', '[aout]', '-c:a', 'aac', '-b:a', '96k');
  args.push('-t', total.toFixed(2), '-r', String(FPS), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '25', '-pix_fmt', 'yuv420p', '-threads', '2', '-movflags', '+faststart', saida);
  return rodarFfmpeg(args, null, 8 * 60e3);
}
async function vidGerar(pasta, refazer) {
  const destino = path.join(CATALOGO, pasta, 'video-whatsapp.mp4');
  if (!refazer && fs.existsSync(destino)) return 'já tem vídeo';
  await vidPreparar();
  const dir = path.join(VID_TMP, String(Date.now())); fs.mkdirSync(dir, { recursive: true });
  try {
    const fotos = [];
    for (const c of fotosDoImovel(pasta).slice(0, 8)) {
      const arq = path.join(dir, 'f' + fotos.length + '.jpg');
      try {
        if (/^https?:\/\//i.test(c)) { const r = await fetch(c, { signal: AbortSignal.timeout(30000) }); if (!r.ok) continue; const b = Buffer.from(await r.arrayBuffer()); if (b.length < 5000) continue; fs.writeFileSync(arq, b); }
        else fs.copyFileSync(path.join(CATALOGO, c), arq);
        fotos.push(arq);
      } catch (e) { }
    }
    if (fotos.length < 2) return 'sem fotos suficientes (' + fotos.length + ')';
    const saida = path.join(dir, 'video.mp4'), r = await vidMontar(fotos, vidTextos(pasta), saida, dir);
    let tam = 0; try { tam = fs.statSync(saida).size; } catch (e) { }
    if (r.status !== 0 || tam < 150e3) return 'o ffmpeg falhou: ' + String(r.stderr || '').slice(-300);
    if (tam > 15.5e6) return 'vídeo grande demais (' + Math.round(tam / 1e6) + ' MB)';
    if (fs.existsSync(destino)) fs.renameSync(destino, path.join(CATALOGO, pasta, 'video-anterior-' + Date.now() + '.mp4'));
    fs.copyFileSync(saida, destino);
    log('vídeo feito', pasta, Math.round(tam / 1e3) + ' KB', fotos.length + ' fotos');
    return 'ok';
  } finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { } }
}
function vidFaltando() {   // imóveis do catálogo (os que estão no CATALOGO.md) sem vídeo
  const cat = lerTexto('CATALOGO.md');
  return pastasImoveis().filter(p => p !== 'escritorio' && fs.existsSync(path.join(CATALOGO, p, 'ficha.md')) && !fs.existsSync(path.join(CATALOGO, p, 'video-whatsapp.mp4')))
    .filter(p => { const m = /\(ref (\d+)\)$/.exec(p); return !cat || (m ? new RegExp('\\b' + m[1] + '\\b').test(cat) : cat.toLowerCase().includes(p.toLowerCase())); });
}
async function vidRotina() {
  if (vid.rodando || !fs.existsSync(VID_LIGADO) || !temFfmpeg()) return; vid.parar = false;
  try {
    for (const p of vidFaltando()) {
      if (vid.parar) break;
      if ((vid.erros[p] || {}).n >= 2 && Date.now() - vid.erros[p].em < 12 * 3600e3) continue;
      vid.rodando = p; let r = '';
      try { r = await vidGerar(p); } catch (e) { r = 'erro: ' + e.message; }
      if (r === 'ok') { vid.feitos.push(p); delete vid.erros[p]; } else if (r !== 'já tem vídeo') { vid.erros[p] = { n: ((vid.erros[p] || {}).n || 0) + 1, em: Date.now(), msg: r }; log('vídeo: não fiz', p, r); }
      vid.ultima = Date.now();
      await dorme(4000);
    }
  } finally { vid.rodando = ''; }
}
setTimeout(() => vidRotina().catch(e => log('vídeos', e.message)), 90e3);
// 23/11/2026 (Djhonata): nada de rodar de tempo em tempo. O vídeo é feito quando o catálogo chega (ficha ou CATALOGO.md novo), 2 minutos depois do último arquivo.
let vidAviso = null;
function vidQuandoChegarCatalogo() { clearTimeout(vidAviso); vidAviso = setTimeout(() => vidRotina().catch(e => log('vídeos', e.message)), 120e3); }
async function vidAmostra(pasta) {   // 5 quadros do vídeo lado a lado, para conferência
  const r = await rodarFfmpeg(['-hide_banner', '-loglevel', 'error', '-i', path.join(CATALOGO, pasta, 'video-whatsapp.mp4'), '-vf', 'fps=1/5,scale=256:-1,tile=5x1', '-frames:v', '1', '-q:v', '6', '-f', 'image2pipe', '-c:v', 'mjpeg', 'pipe:1'], null, 60000);
  return r.status === 0 ? r.stdout.toString('base64') : '';
}
// ---------- limpeza automática das regras (24/11/2026, decisão do Djhonata: toda segunda cedo, entra sozinha, com cópia e resumo) ----------
// A IA NÃO reescreve os arquivos. Ela só aponta, pelo número, quais regras ANTIGAS foram substituídas por outra mais nova (saem) e quais repetidas viram uma só.
// Regra com data dos últimos 30 dias não pode sair nem ser reescrita. Se a limpeza tirar mais de 35% de um arquivo, nada é trocado.
const ENX_ARQS = ['REGRAS-ATENDIMENTO.md', 'MELHORIAS-APROVADAS.md'], ENX_LOG = path.join(DADOS, 'regras-limpeza.json'), ENX_MODELO = ENV.MODELO_LIMPEZA || 'claude-sonnet-5-5';
function enxBlocos(txt) {   // divide o arquivo em pedaços; regra = linha que começa com "- " (e as linhas seguintes dela)
  const out = []; let cur = null;
  for (const l of String(txt).split('\n')) {
    if (/^- \S/.test(l)) { cur = { regra: true, linhas: [l] }; out.push(cur); }
    else if (/^#{1,6} /.test(l) || (!l.trim() && !(cur && cur.regra))) { cur = { regra: false, linhas: [l] }; out.push(cur); }
    else if (cur) cur.linhas.push(l); else { cur = { regra: false, linhas: [l] }; out.push(cur); }
  }
  return out.map(b => ({ regra: b.regra, texto: b.linhas.join('\n') }));
}
function enxRecente(t, dias = 30) {
  const lim = Date.now() - dias * 864e5; let m; const re = /\b(\d{1,2})\/(\d{1,2})\/(20\d{2})\b/g;
  while ((m = re.exec(t))) { const d = Date.UTC(+m[3], +m[2] - 1, +m[1]); if (d >= lim && d <= Date.now() + 864e5) return true; }
  return false;
}
function enxData(t) { let m, max = 0; const re = /\b(\d{1,2})\/(\d{1,2})\/(20\d{2})\b/g; while ((m = re.exec(String(t)))) { const d = Date.UTC(+m[3], +m[2] - 1, +m[1]); if (d <= Date.now() + 864e5 && d > max) max = d; } return max; }
const enxTitulo = (t) => String(t).replace(/^- /, '').split(/[:(]/)[0].trim().slice(0, 70);
async function regrasEnxugar(opc = {}) {
  const arqs = ENX_ARQS.map((f, i) => { const txt = lerTexto(f); return { f, letra: 'AB'[i], txt, blocos: enxBlocos(txt) }; }).filter(a => a.txt.length > 2000);
  if (!arqs.length) return { erro: 'arquivos de regras vazios' };
  let lista = '';
  for (const a of arqs) { lista += `\n\n===== ARQUIVO ${a.letra}: ${a.f} =====\n`; a.blocos.forEach((b, i) => { if (b.regra) { b.id = a.letra + i; b.recente = enxRecente(b.texto); lista += `\n[${b.id}${b.recente ? ' RECENTE' : ''}] ${b.texto}\n`; } else if (b.texto.trim()) lista += `\n${b.texto}\n`; }); }
  const sis = `Você faz a manutenção das regras de atendimento de um corretor de imóveis (o Djhonata), lidas por uma assistente de WhatsApp. As regras estão em dois arquivos e cada regra tem um número entre colchetes. O arquivo A (REGRAS-ATENDIMENTO) vale acima do B (MELHORIAS-APROVADAS). Regra mais nova vale acima da mais antiga (a data está no texto).
Sua tarefa é SÓ apontar o que pode sair sem mudar nenhuma regra em vigor:
1. "remover": regra ANTIGA cujo conteúdo foi inteiro substituído ou contrariado por outra mais nova (diga qual, no campo "por"). Só remova se TUDO o que ela manda já está na outra ou foi revogado por ela. Na dúvida, não remova.
2. "juntar": duas ou mais regras ANTIGAS sobre o mesmo assunto que dizem a mesma coisa: escreva UMA regra com todo o conteúdo delas (campo "texto", começando com "- TÍTULO EM MAIÚSCULAS"), sem perder nenhum detalhe, número, exemplo de frase ou exceção, e sem diminutivos.
3. "conflito": duas regras marcadas RECENTE que mandam coisas OPOSTAS para a mesma situação. Em "id" vai a mais ANTIGA das duas e em "por" a mais NOVA (pela data no texto). "total": true só se a mais nova contraria TUDO o que a antiga manda; se contraria só uma parte, "total": false. Regra que só completa ou detalha a outra NÃO é conflito.
PROIBIDO: tocar em regra marcada RECENTE em "remover" ou "juntar"; inventar regra; resumir a ponto de perder conteúdo; remover regra só porque é longa.
Responda SOMENTE com JSON: {"remover":[{"id":"B12","por":"A40","motivo":"..."}],"conflito":[{"id":"A7","por":"A30","total":true,"motivo":"..."}],"juntar":[{"ids":["B5","B88"],"texto":"- ...","motivo":"..."}]}. Motivos com até 12 palavras. Escreva primeiro todo o "remover", depois o "conflito"; no "juntar", no máximo 8 grupos, os mais repetidos. Dentro dos textos use aspas simples, nunca aspas duplas.`;
  const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, body: jsonLimpo({ model: ENX_MODELO, max_tokens: 30000, system: sis, messages: [{ role: 'user', content: 'Regras atuais:' + lista }] }), signal: AbortSignal.timeout(9 * 60e3) });
  if (!r.ok) return { erro: 'API ' + r.status + ' ' + (await r.text()).slice(0, 200) };
  const j = await r.json(), bruto = (j.content || []).map(x => x.text || '').join(''); if (j.usage) registrarUso(j.usage);
  let plano; try { plano = JSON.parse(bruto.slice(bruto.indexOf('{'), bruto.lastIndexOf('}') + 1)); }
  catch (e) {   // resposta cortada ou com aspas soltas: aproveita só as remoções, que têm formato simples
    plano = { remover: [], juntar: [], conflito: [] }; let mm; const reR = /\{\s*"id"\s*:\s*"([AB]\d+)"\s*,\s*"por"\s*:\s*"([AB]\d+)"\s*,\s*"motivo"\s*:\s*"([^"]*)"\s*\}/g;
    while ((mm = reR.exec(bruto))) plano.remover.push({ id: mm[1], por: mm[2], motivo: mm[3] });
    if (!plano.remover.length) return { erro: 'a IA não devolveu um plano válido', parou: j.stop_reason, tamanho: bruto.length, bruto: bruto.slice(0, 300) };
    log('limpeza das regras: plano cortado, aproveitei só as remoções', plano.remover.length, j.stop_reason);
  }
  const porId = {}; for (const a of arqs) for (const b of a.blocos) if (b.id) porId[b.id] = b;
  const feito = { remover: [], juntar: [], conflito: [], avisar: [], recusados: [] };
  for (const x of (plano.remover || [])) {
    const b = porId[x.id], p = porId[x.por];
    if (!b || b.recente || b.sai || !p || p === b || p.sai) { feito.recusados.push('remover ' + x.id); continue; }
    b.sai = true; feito.remover.push({ titulo: enxTitulo(b.texto), por: enxTitulo(p.texto), motivo: String(x.motivo || '').slice(0, 120) });
  }
  // 24/11/2026 (Djhonata): duas regras novas que se contradizem não podem ficar as duas. Vale a de data mais nova; a outra sai e as duas aparecem no resumo. Mesma data ou conflito só em parte: ninguém sai, só aviso.
  for (const x of (plano.conflito || [])) {
    const b = porId[x.id], p = porId[x.por];
    if (!b || !p || p === b || b.sai || p.sai || !b.recente || !p.recente) { feito.recusados.push('conflito ' + x.id); continue; }
    const db = enxData(b.texto), dp = enxData(p.texto), item = { sai: b.texto.slice(0, 400), vale: p.texto.slice(0, 400), motivo: String(x.motivo || '').slice(0, 120) };
    if (x.total === true && db && dp && dp > db) { b.sai = true; b.conflito = true; feito.conflito.push(item); } else feito.avisar.push(item);
  }
  for (const x of (plano.juntar || [])) {
    const bs = (x.ids || []).map(i => porId[i]), novo = String(x.texto || '').trim();
    const soma = bs.reduce((n, b) => n + (b ? b.texto.length : 0), 0);
    if (bs.length < 2 || bs.some(b => !b || b.recente || b.sai || b.novo) || !/^- \S/.test(novo) || novo.length < soma * 0.45 || /\n- \S/.test(novo)) { feito.recusados.push('juntar ' + (x.ids || []).join('+')); continue; }
    bs[0].novo = semDiminutivo(novo); bs.slice(1).forEach(b => { b.sai = true; });
    feito.juntar.push({ titulos: bs.map(b => enxTitulo(b.texto)), novo: enxTitulo(novo), motivo: String(x.motivo || '').slice(0, 120) });
  }
  const res = { quando: Date.now(), arquivos: [], ...feito };
  for (const a of arqs) {
    const novoTxt = a.blocos.filter(b => !b.sai).map(b => b.novo || b.texto).join('\n').replace(/\n{4,}/g, '\n\n\n');
    a.novoTxt = novoTxt; res.arquivos.push({ f: a.f, antes: a.txt.length, depois: novoTxt.length });
    if (novoTxt.length < a.txt.length * 0.65) return { erro: `a limpeza tiraria mais de 35% de ${a.f}: não troquei nada`, ...res };
    for (const b of a.blocos) if (b.regra && b.recente && !b.conflito && !novoTxt.includes(b.texto)) return { erro: `uma regra recente sumiria de ${a.f}: não troquei nada`, ...res };
  }
  if (opc.testar || !(feito.remover.length + feito.juntar.length + feito.conflito.length)) return { ok: true, aplicado: false, ...res };
  const dia = new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);
  for (const a of arqs) { if (a.novoTxt === a.txt) continue; const abs = path.join(CATALOGO, a.f), copia = a.f.replace(/\.md$/, '') + '-backup-limpeza-' + dia + '.md'; fs.writeFileSync(path.join(CATALOGO, copia), a.txt); fs.writeFileSync(abs, a.novoTxt); res.arquivos.find(x => x.f === a.f).copia = copia; }
  res.aplicado = true; gravarJson(ENX_LOG, res); log('limpeza das regras: saíram', feito.remover.length, 'juntei', feito.juntar.length, JSON.stringify(res.arquivos.map(x => [x.f, x.antes, x.depois])));
  return { ok: true, ...res };
}
function enxDesfazer() {
  const u = lerJson(ENX_LOG, null); if (!u || !u.aplicado) return { erro: 'não há limpeza para desfazer' };
  const voltou = [];
  for (const a of u.arquivos || []) { if (!a.copia) continue; const c = path.join(CATALOGO, a.copia); if (fs.existsSync(c)) { fs.copyFileSync(c, path.join(CATALOGO, a.f)); voltou.push(a.f); } }
  u.aplicado = false; u.desfeito = Date.now(); gravarJson(ENX_LOG, u); log('limpeza das regras desfeita', voltou.join(', '));
  return { ok: true, voltou };
}
function enxResumo(r) {
  if (r.erro) return '🧹 Limpeza das regras: não troquei nada. ' + r.erro;
  const avisos = (r.avisar || []).length ? `\n\n⚠️ ${r.avisar.length} pares de regras novas parecem se contradizer e eu NÃO mexi (mesma data ou só em parte). Me diga qual vale:\n` + r.avisar.slice(0, 6).map((x, i) => `${i + 1}) ${x.sai.slice(0, 220)}\n   x\n   ${x.vale.slice(0, 220)}`).join('\n') : '';
  if (!r.aplicado) return avisos ? '🧹 Limpeza das regras: nada para tirar.' + avisos : '';
  const k = (n) => Math.round(n / 1000) + ' mil';
  let t = '🧹 Limpeza semanal das regras da assistente feita.\n' + r.arquivos.map(a => `${a.f.replace('.md', '')}: de ${k(a.antes)} para ${k(a.depois)} caracteres`).join('\n');
  if (r.remover.length) t += `\n\nSaíram ${r.remover.length} regras antigas, já substituídas por outra mais nova:\n` + r.remover.slice(0, 25).map(x => `• ${x.titulo} → vale: ${x.por}`).join('\n') + (r.remover.length > 25 ? `\n… e mais ${r.remover.length - 25}` : '');
  if (r.juntar.length) t += `\n\nJuntei ${r.juntar.length} grupos de regras repetidas:\n` + r.juntar.slice(0, 15).map(x => `• ${x.titulos.join(' + ')}`).join('\n');
  if ((r.conflito || []).length) t += `\n\nRegras NOVAS que se contradiziam (${r.conflito.length}): ficou a mais recente.\n` + r.conflito.slice(0, 8).map((x, i) => `${i + 1}) SAIU: ${x.sai.slice(0, 260)}\n   VALE: ${x.vale.slice(0, 260)}`).join('\n');
  t += avisos;
  return t + ((r.conflito || []).length ? '\n\nDas regras dos últimos 30 dias, só saíram as que uma mais nova contrariava por inteiro.' : '\n\nNenhuma regra dos últimos 30 dias foi tocada.') + ' A cópia anterior está guardada; para voltar atrás é só pedir.';
}
// Toda segunda-feira, entre 6h e 7h (horário de Joinville), uma vez.
setInterval(async () => {
  const d = new Date(Date.now() - 3 * 3600e3), dia = d.toISOString().slice(0, 10);
  if (d.getUTCDay() !== 1 || d.getUTCHours() !== 6 || estado.limpezaRegras === dia) return;
  estado.limpezaRegras = dia; salvarEstado();
  try { const r = await regrasEnxugar(); const t = enxResumo(r); if (t && conectado) await enviarTexto(DONO + '@s.whatsapp.net', t, 'aviso'); } catch (e) { log('limpeza das regras', e.message); }
}, 10 * 60e3);
function limparDuvidas() {
  let n = 0; const agora = Date.now();
  for (const a of estado.avisos || []) {
    if (a.tipo !== 'duvida' || a.feito) continue;
    const t8 = String(a.telefone || '').replace(/\D/g, '').slice(-8) || tel8Chat(a.jid);
    const st = t8 ? (estado.crmStatus || {})[t8] || '' : '';
    let motivo = '';
    if (['perdido', 'desistiu', 'pausado', 'fechado', 'semperfil', 'corretor', 'construtor', 'pessoal'].includes(st)) motivo = 'card em ' + st;
    else if (agora - (a.ts || 0) > 7 * 864e5) motivo = 'mais de 7 dias';
    else if (a.jid && lerEsp(a.jid).some(m => (m.ts || 0) > (a.ts || 0) && (m.autor === 'voce' || m.autor === 'celular' || (m.autor === 'ia' && m.ordem)))) motivo = 'respondida na conversa';
    if (motivo) { a.feito = agora; a.saiu = motivo; n++; }
  }
  if (n) { salvarEstado(); log('dúvidas resolvidas sozinhas', n); }
  return n;
}
setInterval(() => { try { limparDuvidas(); } catch (e) { log('limpar dúvidas', e.message); } }, 30 * 60e3);
const autoArq = { rodando: false };
async function arquivarAutomatico(simular) {
  const porCat = {}, alvos = [];
  for (const jid of Object.keys(chats)) { const k = catArquivo(jid); if (k) { porCat[k] = (porCat[k] || 0) + 1; alvos.push(jid); } }
  if (simular) { const fica = {}; for (const jid of Object.keys(chats)) { const c = chats[jid] || {}; if (c.arquivado || catArquivo(jid)) continue; const t = tel8Chat(jid); const s = t ? (estado.crmStatus || {})[t] || 'sem card' : 'sem telefone'; fica[s] = (fica[s] || 0) + 1; } return { total: alvos.length, porCat, ficam: fica }; }
  if (autoArq.rodando || !sock || !conectado) return { total: 0, porCat, erro: 'ocupado ou desconectado' };
  autoArq.rodando = true; let feitos = 0, falhas = 0;
  try { for (const jid of alvos.slice(0, 400)) { if (!sock || !conectado) break; if (!catArquivo(jid)) continue; try { await arquivarChat(jid, true); feitos++; } catch (e) { falhas++; } await dorme(400); } }
  finally { autoArq.rodando = false; }
  log('arquivamento automático:', feitos, 'arquivadas', falhas ? 'falhas ' + falhas : '', JSON.stringify(porCat));
  return { total: alvos.length, feitos, falhas, porCat };
}
setInterval(async () => {
  try {
    const d = agoraSP(); if (d.getHours() !== 22) return;
    const dia = d.toISOString().slice(0, 10); if (estado.autoArqDia === dia || !sock || !conectado) return;
    estado.autoArqDia = dia; salvarEstado();
    await etiquetarTudo();
    estado.autoArqUlt = Object.assign({ em: Date.now() }, await arquivarAutomatico(false)); salvarEstado();
  } catch (e) { log('arquivamento automático', e.message); }
}, 5 * 60e3);
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
    const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, body: jsonLimpo({ model: MODELO, max_tokens: Math.max(maxTokens, 5000), system, messages: [{ role: 'user', content: texto }] }) });
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
{"imovel":{"pasta":"pasta exata de um dos imóveis enviados ou citados, ou vazio","unidade":"unidade tratada com o cliente e se é de ponta ou de meio, ou vazio","medidas":"medidas ditas ao cliente (frente, fundos, abertura), ou vazio"},"fluxo":{"enviado":true,"quando":"DD/MM às HHhMM","linhas":[{"item":"Sinal na assinatura","valor":"R$ 10.000,00"}],"total":"R$ 380.000,00 ou vazio","dito":"condição ou ressalva dita ao cliente, ou vazio","resposta":"o que o cliente respondeu sobre o fluxo"},"quer":["Rótulo: o que ele quer"],"informou":["FGTS: ...","Carteira assinada: ...","Renda: ...","Sinal: ...","Quem compra junto: ..."],"objecoes":[{"ponto":"a dúvida ou objeção, com as palavras dele quando ajudar","status":"Em aberto | Resolvida | Explicada | Respondida","nota":"como ficou, em uma frase"}],"pendencias":["o que foi prometido ao cliente e ainda não foi entregue"],"comecar":["até 3 passos, em ordem, para abrir o atendimento no escritório"]}
Regras:
- Use só o que está na conversa e nos dados dos imóveis. Não invente. O que o cliente não disse fica como "não informou".
- Imóvel de interesse: o que o cliente escolheu, ou o último que ele não recusou. Imóvel que ele recusou não entra; se a recusa mostra uma preferência (ex.: não quer pronto, quer mais terreno), escreva a preferência em "quer".
- Se o imóvel de interesse só aparece em IMÓVEIS CITADOS, confira pela conversa (nome, rua, valor) que é o mesmo e use a pasta dele. Na dúvida, deixe a pasta vazia.
- "fluxo": o fluxo de pagamento na ÚLTIMA versão que o cliente recebeu para o imóvel de interesse, item por item, com os valores como foram ditos (inclua FGTS e financiamento se foram ditos). Se nenhum fluxo foi enviado: "enviado": false e "linhas": [].
- "quer": bairro, valor, tipo, exigências (casa de ponta, terreno, vagas, prazo). "informou": o que ele contou de renda, FGTS, carteira, sinal, quem compra junto.
- "objecoes": toda dúvida ou objeção que apareceu, com o status. "pendencias": promessas em aberto (planta, resposta, retorno).
- "comecar": comece pelo que está em aberto e pode derrubar a venda.
- Mensagens [ia] e [voce] foram enviadas em nome do Djhonata. Frases curtas, português simples, sem emoji. Valores no formato R$ 10.000,00.
- O JSON tem de ser válido: dentro dos textos nunca use aspas duplas nem quebra de linha. Para citar o cliente use aspas simples ('assim').
- Cada texto com no máximo 180 caracteres, em frase completa.`;
function fichaQuando(q) { const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/.exec(q || ''); if (!m) return ''; const d = new Date(+m[1], +m[2] - 1, +m[3]); return ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'][d.getDay()] + `, ${m[3]}/${m[2]}/${m[1]}` + (m[4] ? `, às ${+m[4]}h${m[5] !== '00' ? m[5] : ''}` : ''); }
function fichaLinha(m) { const d = new Date((m.ts || 0) - 3 * 3600e3).toISOString(); return d.slice(8, 10) + '/' + d.slice(5, 7) + ' ' + d.slice(11, 16) + ' [' + m.autor + (m.tipo && m.tipo !== 'text' ? ':' + m.tipo : '') + '] ' + String(m.texto || '').replace(/\s*\n+\s*/g, ' / ').slice(0, 1500); }
const fichaDado = (i) => `- pasta: ${i.pasta} | ${i.nome} | ${i.endereco} | ${i.tipo} | ${i.area} | ${i.comodos} | ${i.vagas} | ${i.preco} | entrega: ${i.entrega} | unidades: ${i.unidades || 'não informado'}`;
function fichaImovel(pasta) {   // dados do imóvel como estão no cadastro (ficha.md), mais o fluxo padrão de hoje
  const t = lerTexto(path.join(pasta, 'ficha.md')).replace(/\r/g, ''), g = (re) => ((re.exec(t) || [])[1] || '').trim(), f = dadosDaFicha(pasta);
  let padrao = []; try { const x = simularFluxo({ imovel: pasta }); if (x && x.texto) padrao = x.texto.split('\n').filter(l => /^(✅|💵)/.test(l)).map(l => l.replace(/^(✅|💵)\s*/, '').trim()); } catch (e) { }
  return { pasta, ref: geoRef(pasta), nome: f.nome, endereco: g(/^-\s*Endere[çc]o:\s*([^\n]+)/mi), tipo: g(/^-\s*Tipo de constru[çc][ãa]o:\s*([^\n]+)/mi) || g(/^-\s*Tipo:\s*([^\n]+)/mi), area: g(/^-\s*[ÁA]rea:\s*([^\n]+)/mi), comodos: g(/^-\s*C[ôo]modos:\s*([^\n]+)/mi), vagas: g(/^-\s*Vagas:\s*([^\n]+)/mi),
    preco: f.preco ? brl(f.preco) : '', entrega: g(/^-\s*Entrega:\s*([^\n]+)/mi), unidades: g(/^-\s*Unidades dispon[íi]veis:\s*([^\n]+)/mi).slice(0, 300), projeto: projetosDaPasta(pasta).length ? 'Projeto na pasta do imóvel' : 'Sem projeto na pasta do imóvel', temFoto: !!midiaDaOferta(pasta).foto1, padrao };
}
// Conversa feita pelo próprio Djhonata não leva a marca da oferta: aí o imóvel é achado pelo texto (referência ou nome do cadastro).
let fichaIdx = { em: 0, itens: [] };
function fichaIndice() {
  if (fichaIdx.itens.length && Date.now() - fichaIdx.em < 10 * 60e3) return fichaIdx.itens;
  const itens = [];
  for (const p of pastasImoveis()) {
    if (!lerTexto(path.join(p, 'ficha.md'))) continue;
    let nome = ''; try { nome = dadosDaFicha(p).nome || ''; } catch (e) { }
    const base = semAcento(String(nome).split(/\s[–—-]\s/)[0]).replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
    const rua = (/^(?:casas?|sobrados?|geminados?)\s+((?:rua|avenida|av|servidao|estrada)\s.+)$/.exec(base) || [])[1] || '';
    const daPasta = semAcento(p.replace(/\s*\(ref \d+\)\s*$/, '').split(/\s-\s/)[0]).replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();   // a pasta leva a rua: "rua lapa - boa vista"
    itens.push({ pasta: p, ref: String(geoRef(p) || ''), chaves: [...new Set([rua || base, daPasta])].filter(c => c.length >= 8 && /\s/.test(c)) });
  }
  fichaIdx = { em: Date.now(), itens }; return itens;
}
function fichaCitados(l) {   // pastas citadas na conversa, da citação mais antiga para a mais nova
  const idx = fichaIndice(), visto = new Map();
  l.forEach((m, n) => {
    const t = semAcento(m.texto).replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' '); if (t.length < 6) return;
    const refs = new Set(), re = /\b(?:ref|referencia|cod|codigo)\s*(?:n|no|numero)?\s*(\d{2,4})\b/g; let r; while ((r = re.exec(t))) refs.add(r[1]);
    for (const i of idx) if ((i.ref && refs.has(i.ref)) || i.chaves.some(c => (' ' + t + ' ').includes(' ' + c + ' '))) visto.set(i.pasta, n);
  });
  return [...visto.entries()].sort((a, b) => a[1] - b[1]).map(x => x[0]);
}
async function fichaGerar(jid, motivo) {
  if (fichaAt.gerando[jid]) return null; fichaAt.gerando[jid] = Date.now();
  try {
    const todas = lerEsp(jid), l = todas.filter(m => m.autor !== 'aviso' && (String(m.texto || '').trim() || (m.tipo && m.tipo !== 'text'))); if (!l.length) return null;
    const c = chatPublico(jid) || {}, cc = chats[jid] || {}, st = (estado.crmStatus || {})[tel8Chat(jid)] || '';
    const ims = [...new Set(l.map(m => m.oferta || (m.arquivo && m.autor !== 'cliente' ? pastaDoCaminho(String(m.arquivo).replace(/^c\//, '')) : '')).filter(Boolean))].filter(p => lerTexto(path.join(p, 'ficha.md'))).slice(-4).map(fichaImovel);   // imóvel enviado: pela marca da oferta ou pelo arquivo (vídeo, foto) que saiu
    const cits = fichaCitados(l).filter(p => !ims.some(i => i.pasta === p)).slice(-3).map(fichaImovel);   // imóvel só citado no texto
    const vis = (estado.visitas || {})[jid], visTxt = vis && vis.q ? fichaQuando(vis.q) : '';
    const origem = cc.anuncio ? 'Anúncio' + (cc.anuncio.titulo ? ' "' + cc.anuncio.titulo + '"' : '') : 'Chamou no WhatsApp';
    const dados = `CLIENTE: ${c.nome || 'sem nome'} | telefone ${c.telefone || ''} | origem: ${origem} | etapa no CRM: ${st || 'sem card'}${visTxt ? ' | visita marcada: ' + visTxt : ''}\n\nIMÓVEIS ENVIADOS NA CONVERSA (dados do cadastro):\n`
      + (ims.map(fichaDado).join('\n') || '(nenhum imóvel do catálogo foi enviado)')
      + (cits.length ? '\n\nIMÓVEIS CITADOS NA CONVERSA (achados pelo nome ou pela referência; dados do cadastro):\n' + cits.map(fichaDado).join('\n') : '')
      + '\n\nCONVERSA (horário de Joinville):\n' + l.slice(-220).map(fichaLinha).join('\n');
    const tentar = async (extra) => {   // sem temperatura: o modelo atual não aceita esse parâmetro
      const bruto = await claudeTexto(SIS_FICHA, dados + extra, 14000), mj =   // limite folgado: em conversa longa a resposta era cortada no meio
        /\{[\s\S]*\}/.exec(bruto || '');
      try { return mj ? JSON.parse(mj[0]) : null; } catch (e) { log('ficha: resposta que não é JSON', jid, String(bruto || '').replace(/\s+/g, ' ').slice(0, 200)); return null; }
    };
    let j = await tentar('');
    if (!j || typeof j !== 'object') j = await tentar('\n\nATENÇÃO: a resposta anterior não era um JSON válido. Devolva só o JSON pedido, sem texto antes nem depois, sem aspas duplas dentro dos textos.');
    if (!j || typeof j !== 'object') throw new Error('resposta sem JSON');
    const tx = (v, n) => { const s = String(v == null ? '' : v).replace(/\s+/g, ' ').trim(); if (s.length <= n) return s; const c = s.slice(0, n), f = Math.max(c.lastIndexOf('. '), c.lastIndexOf('; ')), e = c.lastIndexOf(' '); return f > n * 0.6 ? c.slice(0, f + 1).replace(/;$/, '.') : c.slice(0, e > n * 0.5 ? e : n).replace(/[\s,;:(]+$/, '') + '...'; }, lista = (v, n) => (Array.isArray(v) ? v : []).map(x => tx(x, 340)).filter(Boolean).slice(0, n);
    const ji = j.imovel || {}, fl = j.fluxo || {}, im = ims.find(i => i.pasta === ji.pasta) || cits.find(i => i.pasta === ji.pasta) || (ims.length === 1 ? ims[0] : null);   // imóvel só citado entra quando o modelo confirma pela conversa
    const linhas = (Array.isArray(fl.linhas) ? fl.linhas : []).map(x => ({ item: tx((x || {}).item, 120), valor: tx((x || {}).valor, 40) })).filter(x => x.item).slice(0, 10);
    const ficha = { v: 2, jid, nome: c.nome || '', telefone: c.telefone || '', origem, crm: st, visita: visTxt,
      imovel: im ? Object.assign({}, im, { unidade: tx(ji.unidade, 240), medidas: tx(ji.medidas, 240) }) : null,
      fluxo: { enviado: !!fl.enviado && linhas.length > 0, quando: tx(fl.quando, 40), linhas, total: tx(fl.total, 40), dito: tx(fl.dito, 340), resposta: tx(fl.resposta, 340) },
      quer: lista(j.quer, 7), informou: lista(j.informou, 7),
      objecoes: (Array.isArray(j.objecoes) ? j.objecoes : []).map(o => ({ ponto: tx((o || {}).ponto, 220), status: tx((o || {}).status, 20), nota: tx((o || {}).nota, 340) })).filter(o => o.ponto).slice(0, 7),
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
      if (fx && (fx.v || 1) < 2 && !fx.imovel) { fichaPedir(jid, 'procurar o imóvel citado'); continue; }   // ficha da primeira versão, sem imóvel: refaz uma vez
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
function ultNossa(jid) {   // 25/11/2026 (Djhonata): última mensagem que NÓS mandamos ao cliente (calcula do espelho uma vez e depois acompanha)
  const c = chats[jid] || {};
  if (c.ultNossa === undefined) { const l = lerEsp(jid); let t = 0; for (const m of l) if (m.autor !== 'cliente' && m.ts > t) t = m.ts; c.ultNossa = t; salvarChats(); }
  return c.ultNossa || 0;
}
function ultCli(jid) {   // última mensagem do cliente (calcula do espelho para conversas que vieram do histórico)
  const c = chats[jid] || {};
  if (c.ultCliente === undefined) { const l = lerEsp(jid); let t = 0; for (const m of l) if (m.autor === 'cliente' && !m.auto && m.ts > t) t = m.ts; c.ultCliente = t; salvarChats(); }
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
  // 26/11/2026 (Djhonata): quem estava em "Corretor 1" ou "Corretor 2" (e não é da Euro) é corretor parceiro; fica guardado mesmo depois que a etiqueta antiga sai
  if ((etq.chats[jid] || []).some(id => /^corretor\s*\d+$/i.test(String((etq.labels[id] || {}).nome || '').trim())) && !(estado.parceiros || {})[jid]) { (estado.parceiros = estado.parceiros || {})[jid] = Date.now(); salvarEstado(); }
  if ((estado.parceiros || {})[jid]) return 'corretor';
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
  // 26/11/2026 (Djhonata): as etiquetas antigas "Corretor 1" e "Corretor 2" saem de todas as conversas; corretor da Euro fica só com "Corretor Euro"
  for (const id of [...tem]) {
    if (!/^corretor\s*\d+$/i.test(String((etq.labels[id] || {}).nome || '').trim())) continue;
    meusRotulos.set(jid + '|' + id, Date.now());
    await sock.removeChatLabel(jid, id); tem.delete(id); mudou = true;
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
  // 26/11/2026: também os contatos que só têm etiqueta (sem conversa guardada no servidor), para "Corretor 1/2" virar "Corretor parceiro"
  const comEtq = Object.keys(etq.chats).filter(j => jidValido(j) && !chats[j] && (etq.chats[j] || []).some(id => /^corretor\s*\d+$/i.test(String((etq.labels[id] || {}).nome || '').trim())));
  const lista = [...Object.keys(chats), ...comEtq].filter(j => catEtiqueta(j));
  if (comEtq.length) log('etiquetar: contatos só com Corretor 1/2', comEtq.length);
  Object.assign(etiquetando, { rodando: true, feitos: 0, total: lista.length });
  try { for (const jid of lista) { if (!sock || !conectado) break; try { await definirEtiqueta(jid, catEtiqueta(jid), ids); } catch (e) { log('etiquetar', jid, e.message); } etiquetando.feitos++; } }
  finally { etiquetando.rodando = false; log('etiquetas aplicadas', etiquetando.feitos, 'conversas'); }
}
async function aplicarEtiquetaStatus(jid, novoStatus) {
  // A assistente registrou um evento: a etiqueta da conversa acompanha o novo status do CRM.
  if (!sock || !conectado || !jid) return;
  const st = String(novoStatus || '').toLowerCase();
  const cat = { atendimento: 'atendimento', visita_marcada: 'visita', visita: 'visita', negociacao: 'negociacao', remarcar: 'novo', pausado: 'pausado', sem_perfil: 'pausado', sem_interesse: 'desistiu', desistiu: 'desistiu' }[st];
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
        w.on('finish', () => { fs.renameSync(tmp, abs); const mt = Number(u.searchParams.get('m') || 0); if (mt) fs.utimesSync(abs, mt, mt); if (/(^|\/)(ficha|CATALOGO)\.md$/.test(rel)) vidQuandoChegarCatalogo(); res.writeHead(200); res.end('ok'); });
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
          const texto = semDiminutivo(String(b.texto || '').trim()).replace(/\*\*([^*\n]+)\*\*/g, '*$1*');   // 24/11/2026: negrito do WhatsApp é com um asterisco só
          { const pr = problemaNoRascunho(texto); if (pr && !b.forcar) return json(res, { erro: pr }, 422); }
          if (jid && !chats[jid] && jid.endsWith('@s.whatsapp.net') && sock && conectado) { try { const [r] = await sock.onWhatsApp(jid.split('@')[0]); if (r && r.exists && r.jid) jid = r.jid; } catch (e) { } }
          if (!jidValido(jid) || !texto) return json(res, { erro: 'conversa ou texto inválido' }, 400);
          // 23/11/2026: retorno com duas partes (bloco da simulação --- pergunta) sai em mensagens separadas
          const id = /\n\s*---\s*\n/.test(texto) ? ((await enviarSaida(jid, texto, 'voce')).length ? 'ok' : null) : await enviarTexto(jid, texto, 'voce');
          if (!id) return json(res, { erro: 'WhatsApp desconectado' }, 409);
          anotar(jid, 'assistant', `(Djhonata escreveu) ${texto.replace(new RegExp(RE_CITA.source, 'gi'), '').trim()}`);
        } else if (ac === 'enviar_arquivo') {   // 13/11/2026: o Djhonata manda pelo painel o vídeo, a foto ou o projeto de um imóvel do catálogo. texto = JSON { ref ou caminho, legenda }; com ref vai o vídeo da oferta (ou a foto da fachada)
          let pa = null; try { pa = JSON.parse(String(b.texto || '')); } catch (e) { }
          if (!pa || typeof pa !== 'object') return json(res, { erro: 'mande texto = JSON { ref ou caminho, legenda }' }, 400);
          if (jid && !chats[jid] && jid.endsWith('@s.whatsapp.net') && sock && conectado) { try { const [r] = await sock.onWhatsApp(jid.split('@')[0]); if (r && r.exists && r.jid) jid = r.jid; } catch (e) { } }
          if (!jidValido(jid)) return json(res, { erro: 'conversa inválida' }, 400);
          if (pa.projeto && pa.ref) {   // 23/11/2026: o Djhonata manda o projeto (planta) do imóvel pela tela de Pendências do CRM: vão os PDFs de projeto que já estão na pasta do imóvel
            const pastaJ = acharPasta(String(pa.ref).split('-')[0]); if (!pastaJ) return json(res, { erro: 'imóvel não encontrado' }, 404);
            const arqs = fs.readdirSync(path.join(CATALOGO, pastaJ)).filter(f => /^projeto-.+\.(pdf|jpe?g|png)$/i.test(f)).sort().slice(0, 4);
            if (!arqs.length) return json(res, { erro: 'esse imóvel ainda não tem projeto guardado no servidor' }, 404);
            const enviados = [];
            for (let i = 0; i < arqs.length; i++) { const r = await enviarArquivo(jid, pastaJ + '/' + arqs[i], i === 0 ? String(pa.legenda || '').slice(0, 1000) : '', 'voce'); if (r !== 'Enviado.') return json(res, { erro: r, enviados }, /desconectado/i.test(r) ? 409 : 400); enviados.push(arqs[i]); await dorme(1500); }
            anotar(jid, 'assistant', `(Djhonata enviou o projeto do imóvel ${pastaJ}: ${enviados.join(', ')})`);
            return json(res, { ok: true, enviados });
          }
          let caminho = String(pa.caminho || '').replace(/^[a-z]:[\\/]+users[\\/]+public[\\/]+catalogo[\\/]+/i, ''), pastaA = '';
          if (!caminho) { pastaA = pa.ref ? acharPasta(String(pa.ref)) || '' : ''; if (!pastaA) return json(res, { erro: 'imóvel não encontrado' }, 404); const mi = midiaDaOferta(pastaA); caminho = mi.video || mi.foto1 || ''; if (!caminho) return json(res, { erro: 'esse imóvel não tem vídeo nem foto na pasta' }, 404); }
          if (pa.naoRepetir) { const jaR = jaRecebeuImovel(jid, String(pa.naoRepetir)); if (jaR) return json(res, { erro: 'este cliente já recebeu esse imóvel em ' + quandoFoi(jaR) + '. Não mandei de novo.', jaRecebeu: jaR }, 409); }   // 23/11/2026 (caso Gabriele): o mesmo imóvel não vai duas vezes para o mesmo cliente
          ofEnvCache.em = 0;
          const legendaA = String(pa.legenda || '').slice(0, 3000), rA = await enviarArquivo(jid, caminho, legendaA, 'voce', pastaA ? { oferta: pastaA } : undefined);
          if (rA !== 'Enviado.') return json(res, { erro: rA }, /desconectado/i.test(rA) ? 409 : 400);
          anotar(jid, 'assistant', `(Djhonata enviou ${caminho}${legendaA ? ' com a legenda: ' + legendaA.slice(0, 300) : ''})`);
          return json(res, { ok: true, caminho });
        } else if (ac === 'projeto_baixar') {   // 13/11/2026: o CRM manda o link temporário do anexo no Loft e o servidor baixa o projeto para a pasta do imóvel (a assistente passa a mandar a planta sozinha). texto = JSON { ref, url, nome }
          let pj = null; try { pj = JSON.parse(String(b.texto || '')); } catch (e) { }
          if (!pj || typeof pj !== 'object' || !pj.url) return json(res, { erro: 'mande texto = JSON { ref, url, nome }' }, 400);
          const pastaP = acharPasta(String(pj.ref || '')); if (!pastaP || !/^\d{2,5}$/.test(String(pj.ref || ''))) return json(res, { erro: 'imóvel não encontrado' }, 404);
          let up = null; try { up = new URL(String(pj.url)); } catch (e) { }
          if (!up || up.protocol !== 'https:' || !((up.hostname === 's3.sa-east-1.amazonaws.com' && up.pathname.startsWith('/static.vista/')) || up.hostname === 'cdn.vistahost.com.br')) return json(res, { erro: 'endereço não permitido' }, 400);
          const nomeP = String(pj.nome || '').trim(), nl = semAcento(nomeP).replace(/[^a-z0-9 .]/g, ' '), extP = ((/\.(pdf|jpe?g|png)$/i.exec(nomeP) || [])[1] || '').toLowerCase().replace('jpeg', 'jpg');
          // Só projeto e planta. Documento interno (autorização de venda, contrato, documento pessoal, tabela) nunca entra na pasta que vai para o cliente.
          if (!extP || !/projeto|planta|arquitet|humaniz|implanta|layout|pavimento|terreo|superior|inferior|unidade|\bun\b|\btipo\b|\bcasa\b/.test(nl) || /autoriza|contrato|procura|matricula|certid|\brg\b|\bcpf\b|\bcnh\b|identidade|comprovante|iptu|escritura|proposta|recibo|boleto|declara|termo|ficha|cadastr|documento|laudo|avalia|habite|alvara|vistoria|financ|extrato|tabela|preco|memorial/.test(nl)) return json(res, { erro: 'esse anexo não é projeto ou planta' }, 400);
          let bufP = null; try { const rp = await fetch(up.href, { signal: AbortSignal.timeout(90000) }); if (rp.ok) bufP = Buffer.from(await rp.arrayBuffer()); } catch (e) { log('projeto: não baixou', pastaP, e.message); }
          if (!bufP || bufP.length < 500) return json(res, { erro: 'o arquivo não baixou (o link do Loft vale só 10 minutos)' }, 502);
          if (bufP.length > 15e6) return json(res, { erro: 'arquivo acima de 15 MB' }, 400);
          const cab = bufP.subarray(0, 8), ehPdf = cab.subarray(0, 4).toString('latin1') === '%PDF', ehJpg = cab[0] === 0xff && cab[1] === 0xd8, ehPng = cab[0] === 0x89 && cab.subarray(1, 4).toString('latin1') === 'PNG';
          if ((extP === 'pdf' && !ehPdf) || (extP === 'jpg' && !ehJpg) || (extP === 'png' && !ehPng)) return json(res, { erro: 'o conteúdo não é ' + extP.toUpperCase() }, 400);
          const arqP = 'projeto-' + (nl.replace(/\.(pdf|jpe?g|png)$/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'do-imovel') + '.' + extP;
          fs.writeFileSync(path.join(CATALOGO, pastaP, arqP), bufP); log('projeto guardado', pastaP, arqP, bufP.length);
          return json(res, { ok: true, pasta: pastaP, arquivo: arqP, bytes: bufP.length });
        } else if (ac === 'avaliacoes_salvar') {   // 26/11/2026 (Djhonata): avaliação da Caixa por imóvel (ref -> R$), vinda do CRM. Vale na simulação quando está acima do preço. texto = JSON { ref: valor } (0 tira)
          let pa = null; try { pa = JSON.parse(String(b.texto || '')); } catch (e) { }
          if (!pa || typeof pa !== 'object' || Array.isArray(pa)) return json(res, { erro: 'mande texto = JSON { ref: valor }' }, 400);
          let n = 0; for (const [r, v] of Object.entries(pa)) { if (!/^\d{2,5}$/.test(r)) continue; const x = Math.round(Number(v) || 0); if (x > 0) avalRef[r] = x; else delete avalRef[r]; n++; }
          fs.writeFileSync(AVAL_ARQ, JSON.stringify(avalRef)); log('avaliações salvas', n);
          return json(res, { ok: true, gravadas: n, total: Object.keys(avalRef).length });
        } else if (ac === 'foto_receber') {   // 26/11/2026 (Djhonata): foto que faltava (ex.: fachada) vai para a pasta do imóvel e entra em primeiro na lista de fotos. texto = JSON { ref, nome, b64 }
          let pf = null; try { pf = JSON.parse(String(b.texto || '')); } catch (e) { }
          if (!pf || typeof pf !== 'object' || !pf.b64) return json(res, { erro: 'mande texto = JSON { ref, nome, b64 }' }, 400);
          const pastaF = /^\d{2,5}$/.test(String(pf.ref || '')) && acharPasta(String(pf.ref));
          if (!pastaF) return json(res, { erro: 'imóvel não encontrado' }, 404);
          const bufF = Buffer.from(String(pf.b64), 'base64');
          if (bufF.length < 500 || bufF.length > 15e6) return json(res, { erro: 'tamanho inválido' }, 400);
          const extF = (bufF[0] === 0xff && bufF[1] === 0xd8) ? 'jpg' : (bufF[0] === 0x89 && bufF.subarray(1, 4).toString('latin1') === 'PNG') ? 'png' : '';
          if (!extF) return json(res, { erro: 'não é imagem' }, 400);
          const arqF = (semAcento(String(pf.nome || 'foto')).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').replace(/projeto|planta/g, 'foto').slice(0, 40) || 'foto') + '.' + extF;
          fs.writeFileSync(path.join(CATALOGO, pastaF, arqF), bufF);
          let naFicha = false; try { const fp = path.join(CATALOGO, pastaF, 'ficha.md'); const fx = lerTexto(fp); const mm = /^- Fotos[^\n]*\n/m.exec(fx); if (mm && !fx.includes(pastaF + '/' + arqF)) { fs.writeFileSync(fp, fx.slice(0, mm.index + mm[0].length) + '  - ' + pastaF + '/' + arqF + '\n' + fx.slice(mm.index + mm[0].length)); naFicha = true; } } catch (e) { }
          log('foto guardada', pastaF, arqF, bufF.length, naFicha ? 'primeira na ficha' : '');
          return json(res, { ok: true, pasta: pastaF, arquivo: arqF, caminho: pastaF + '/' + arqF, primeiraNaFicha: naFicha, bytes: bufF.length });
        } else if (ac === 'projeto_receber') {   // 26/11/2026 (Djhonata): projeto anexado no CRM (PDF ou imagem) vai para a pasta do imóvel; a assistente manda sozinha. texto = JSON { ref, pasta, nome, b64 }
          let pj = null; try { pj = JSON.parse(String(b.texto || '')); } catch (e) { }
          if (!pj || typeof pj !== 'object' || !pj.b64) return json(res, { erro: 'mande texto = JSON { ref, pasta, nome, b64 }' }, 400);
          const pastaP = (/^\d{2,5}$/.test(String(pj.ref || '')) && acharPasta(String(pj.ref))) || (pj.pasta && acharPasta(String(pj.pasta)));
          if (!pastaP) return json(res, { erro: 'imóvel não encontrado' }, 404);
          const bufP = Buffer.from(String(pj.b64), 'base64');
          if (bufP.length < 500 || bufP.length > 15e6) return json(res, { erro: 'tamanho inválido' }, 400);
          const cab = bufP.subarray(0, 4), extP = cab.toString('latin1') === '%PDF' ? 'pdf' : (bufP[0] === 0xff && bufP[1] === 0xd8) ? 'jpg' : (bufP[0] === 0x89 && cab.subarray(1, 4).toString('latin1') === 'PNG') ? 'png' : '';
          if (!extP) return json(res, { erro: 'não é PDF nem imagem' }, 400);
          const nl = semAcento(String(pj.nome || 'projeto')).toLowerCase().replace(/[^a-z0-9 .]/g, ' ');
          if (/autoriza|contrato|procura|matricula|certid|\brg\b|\bcpf\b|\bcnh\b|identidade|comprovante|iptu|escritura|proposta|recibo|boleto|declara|termo|ficha|cadastr|documento|laudo|avalia|habite|alvara|vistoria|financ|extrato|tabela|preco|memorial/.test(nl)) return json(res, { erro: 'esse anexo não é projeto ou planta' }, 400);
          const arqP = 'projeto-' + (nl.replace(/\.(pdf|jpe?g|png)$/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').replace(/^projeto-?/, '').slice(0, 50) || 'do-imovel') + '.' + extP;
          fs.writeFileSync(path.join(CATALOGO, pastaP, arqP), bufP); log('projeto guardado (CRM)', pastaP, arqP, bufP.length);
          return json(res, { ok: true, pasta: pastaP, arquivo: arqP, bytes: bufP.length });
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
          const desde = Number(o.desde) || Date.parse(o.desde || '') || Date.now() - 3 * 864e5, ate = Number(o.ate) || Date.parse(o.ate || '') || 0, lim = Math.min(120, Number(o.limite) || 60), nMsgs = Math.min(80, Number(o.msgs) || 40);
          const bloq = lerBloqueados(), hm = (t) => new Date(t - 3 * 3600e3).toISOString().slice(5, 16).replace('T', ' ');
          const lista = Object.keys(chats).filter(j => jidValido(j) && (chats[j].ultCliente || 0) >= desde).map(j => ({ j, p: chatPublico(j) }))
            .filter(x => x.p.telefone && !bloq.has(normal(x.p.telefone)) && normal(x.p.telefone) !== normal(DONO) && (!ate || (x.p.ult || 0) <= ate)).sort((a, b) => (b.p.ult || 0) - (a.p.ult || 0)).slice(0, lim);
          const partes = [];
          for (const x of lista) {
            const t8 = String(x.p.telefone).replace(/\D/g, '').slice(-8), c = chats[x.j] || {};
            const ms = lerEsp(x.j).slice(-nMsgs);
            partes.push('===== ' + (x.p.nome || 'sem nome') + ' | ' + x.p.telefone + ' | CRM: ' + ((estado.crmStatus || {})[t8] || 'sem card') + (c.anuncio ? ' | anúncio: ' + (c.anuncio.titulo || 'sim') + (c.anuncio.anuncioId ? ' [' + c.anuncio.anuncioId + ((adsMapa[c.anuncio.anuncioId] || {}).pasta ? ' = ' + adsMapa[c.anuncio.anuncioId].pasta : (adsMapa[c.anuncio.anuncioId] || {}).generico ? ' = genérico' : '') + ']' : '') : '') + (x.p.iaOff ? ' | IA desligada neste chat' : '') + '\n'
              + ms.map(m => hm(m.ts) + ' [' + m.autor + (m.rotina ? ':' + m.rotina : '') + (m.followup ? ':followup' : '') + (m.tipo && m.tipo !== 'text' ? ':' + m.tipo : '') + '] ' + String(m.texto || '').replace(/\s*\n+\s*/g, ' / ').slice(0, m.tipo === 'audio' ? 2500 : 420)).join('\n'));   // áudio vai inteiro (13/11/2026): cortado em 420, o fim do áudio longo ficava fora da avaliação
            await new Promise(r => setTimeout(r, 2));
          }
          return json(res, { ok: true, conversas: lista.length, texto: partes.join('\n\n') });
        } else if (ac === 'meu_jeito') {   // 18/11/2026 (Djhonata): tudo o que ELE escreveu/gravou para clientes (autor celular), para a assistente aprender o jeito dele. texto = {desde, ate, pagina, transcrever}
          let o = {}; try { o = JSON.parse(b.texto || '{}'); } catch (e) { }
          const desde = Number(o.desde) || Date.parse(o.desde || '') || 0, ate = Number(o.ate) || Date.parse(o.ate || '') || Date.now(), pag = Math.max(0, Number(o.pagina) || 0), maxT = Math.min(20, Math.max(0, Number(o.transcrever) || 0));
          const hm = (t) => new Date(t - 3 * 3600e3).toISOString().slice(0, 16).replace('T', ' ');
          const linhas = []; let audios = 0, audiosSemArquivo = 0, audiosTranscritos = 0, transcritosAgora = 0;
          for (const j of Object.keys(chats)) {
            if (!jidValido(j) || ehDono(pnDe(j) || j)) continue;
            const ms = lerEsp(j); if (!ms.some(m => m.autor === 'celular' && m.ts >= desde && m.ts <= ate)) continue;
            const nome = String(chatPublico(j).nome || '').split(/\s+/)[0] || 'cliente';
            let antes = '';
            for (const m of ms) {
              if (m.autor === 'cliente') { antes = String(m.texto || (m.tipo !== 'text' ? '[' + m.tipo + ']' : '')).replace(/\s+/g, ' ').slice(0, 160); continue; }
              if (m.autor !== 'celular' || m.ts < desde || m.ts > ate) continue;
              let t = String(m.texto || '').replace(/\s+/g, ' ').trim();
              if (m.tipo === 'audio') {
                audios++;
                if (!t && m.arquivo && transcritosAgora < maxT) {
                  try { const f = path.join(MIDIA, path.basename(m.arquivo)); const tr = await transcrever(fs.readFileSync(f), 'audio/ogg'); if (tr) { t = tr; transcritosAgora++; registrarEspelho(j, { id: m.id, autor: 'celular', tipo: 'audio', texto: tr, transc: true, ts: m.ts }, { silencioso: true }); } } catch (e) { }
                }
                if (t) audiosTranscritos++; else if (!m.arquivo) audiosSemArquivo++;
                t = t ? '[áudio] ' + t : (m.arquivo ? '[áudio ainda sem transcrição]' : '[áudio sem arquivo no servidor]');
              } else if (m.tipo !== 'text') { if (/^(video|image|document)$/.test(m.tipo) && t.length > 60) continue; t = '[' + m.tipo + '] ' + t; }
              if (!t) continue;
              linhas.push({ ts: m.ts, l: hm(m.ts) + ' | ' + nome + (antes ? ' | cliente: ' + antes : '') + '\n  EU: ' + t.slice(0, 2500) });
              antes = '';
            }
            await new Promise(r => setTimeout(r, 1));
          }
          linhas.sort((a, b) => a.ts - b.ts);
          const POR = Math.min(20000, Math.max(50, Number(o.por) || 400)), total = linhas.length, fatia = linhas.slice(pag * POR, (pag + 1) * POR);
          return json(res, { ok: true, total, pagina: pag, paginas: Math.ceil(total / POR), audios, audiosTranscritos, audiosSemArquivo, transcritosAgora, texto: fatia.map(x => x.l).join('\n') });
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
        } else if (ac === 'travar_lista') {   // 18/11/2026: lista completa de finais (8 dígitos) travados no CRM, mandada pelo CRM na hora em que o card muda
          let l = []; try { l = JSON.parse(String(b.texto || '[]')); } catch (e) { return json(res, { erro: 'lista inválida' }, 400); }
          l = [...new Set((Array.isArray(l) ? l : []).map(x => String(x).replace(/\D/g, '').slice(-8)).filter(x => x.length === 8))].sort();
          const antes = new Set(estado.travaCrm || []), novos = l.filter(t => !antes.has(t));
          estado.travaCrm = l; estado.travaCrmEm = Date.now(); salvarEstado();
          let cortadas = 0;
          if (novos.length) for (const j of Object.keys(chats)) { const t8 = tel8De(j); if (t8 && novos.includes(t8) && filas.has(j)) { filas.delete(j); cortadas++; } }
          if (novos.length) log('trava do CRM: travou', novos.length, 'telefone(s)', cortadas ? '(' + cortadas + ' resposta(s) na fila cancelada(s))' : '');
          return json(res, { ok: true, travados: l.length, novos: novos.length, cortadas });
        } else if (ac === 'retorno_apagar') {   // 24/11/2026: tira um retorno marcado por engano
          if (!jidValido(jid)) return json(res, { erro: 'conversa inválida' }, 400);
          const tinha = !!(estado.retornos || {})[jid]; if (tinha) { delete estado.retornos[jid]; salvarEstado(); log('retorno apagado pelo Djhonata', jid); }
          return json(res, { ok: true, apagou: tinha });
        } else if (ac === 'retorno_marcar') {   // 24/11/2026: retorno marcado pelo Djhonata (texto JSON {q:'AAAA-MM-DDTHH:MM', assunto})
          if (!jidValido(jid)) return json(res, { erro: 'conversa inválida' }, 400);
          let o = {}; try { o = JSON.parse(String(b.texto || '{}')); } catch (e) { return json(res, { erro: 'texto inválido' }, 400); }
          if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(String(o.q || '')) || !(quandoMs(o.q) > Date.now())) return json(res, { erro: 'data inválida' }, 400);
          estado.retornos = estado.retornos || {}; estado.retornos[jid] = { q: o.q, assunto: String(o.assunto || 'retorno marcado pelo Djhonata').slice(0, 200), criado: Date.now() }; salvarEstado();
          log('retorno marcado pelo Djhonata', jid, o.q); return json(res, { ok: true, retorno: estado.retornos[jid] });
        } else if (ac === 'ia_conversa') {
          if (!jidValido(jid)) return json(res, { erro: 'conversa inválida' }, 400);
          if (b.on) delete estado.pausas[jid]; else { estado.pausas[jid] = Date.now() + 3650 * 864e5; filas.delete(jid); }
          salvarEstado(); emitir('chat', chatPublico(jid));
        } else if (ac === 'assistente') {
          const rp = ligarOuPausar(b.on, 'CRM'); if (rp) b._resultado = rp;
        } else if (ac === 'desconectar') { await desconectarWhatsApp(); }
        else if (ac === 'conectar') { await conectarWhatsApp(); await new Promise(r => setTimeout(r, 2500)); }
        else if (ac === 'lido') { if (chats[jid]) { chats[jid].naoLidas = 0; salvarChats(); } }
        else if (ac === 'arquivo_auto') { const r = await arquivarAutomatico(b.on !== true); return json(res, { resultado: r, ultimo: estado.autoArqUlt || null }); }
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
            // quem recebeu follow-up há 7 dias ou mais e não respondeu pode receber outro (16/11/2026); antes disso, não refaz
            const deNovo = v && ((v.status === 'enviado' && Date.now() - (v.enviadoEm || 0) >= 7 * 864e5) || (v.status === 'pausado' && Date.now() >= (v.ate || 0)));
            { const pz = fuPausa(acharJid(num + '@s.whatsapp.net')); if (pz && pz.ate > Date.now()) { fu[t8] = Object.assign({}, v || {}, { tel8: t8, tel: num, id: String(c.id || ''), nome: String(c.nome || '').slice(0, 80), status: 'pausado', ate: pz.ate === Infinity ? 9e15 : pz.ate, motivo: pz.motivo, pausadoEm: Date.now() }); ignorados++; continue; } }
            if (v && !deNovo && (['enviado', 'respondeu', 'aprovado', 'gerando'].includes(v.status) || (!p.refazer && v.status !== 'erro'))) { ignorados++; continue; }   // já tem (ou já foi): não refaz
            fu[t8] = { tel8: t8, tel: num, id: String(c.id || ''), nome: String(c.nome || '').slice(0, 80), status: 'fila', criadoEm: Date.now(), tent: 0,
              rodada: deNovo ? (v.rodada || 1) + 1 : 1, anteriorEm: deNovo ? v.enviadoEm : 0,
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
          if (p.mapa) { out.mapa = {}; for (const v of Object.values(fu)) if (!(v.status === 'enviado' && Date.now() - (v.enviadoEm || 0) >= 7 * 864e5) && !(v.status === 'pausado' && Date.now() >= (v.ate || 0))) out.mapa[v.tel8] = v.status; }   // enviado há 7 dias ou mais sem resposta volta a poder ser preparado
          if (Array.isArray(p.status) && p.status.length) {
            const ord = { aprovado: (a, z) => (prev[a.tel8] || 0) - (prev[z.tel8] || 0), enviado: (a, z) => (z.enviadoEm || 0) - (a.enviadoEm || 0), respondeu: (a, z) => (z.respondeuEm || 0) - (a.respondeuEm || 0) };
            if (p.ordem === 'antigo' || p.ordem === 'novo') { const ce = new Map(); const g = (v) => { if (!ce.has(v.tel8)) ce.set(v.tel8, fuCliEm(v) || 0); return ce.get(v.tel8); }; ord[p.status[0]] = p.ordem === 'antigo' ? (a, z) => (g(a) || 9e15) - (g(z) || 9e15) : (a, z) => g(z) - g(a); }   // 24/11/2026: ordenar pela última mensagem do cliente
            const sel = Object.values(fu).filter(v => p.status.includes(v.status)).sort(ord[p.status[0]] || ((a, z) => (z.prioridade || 0) - (a.prioridade || 0) || (z.geradoEm || 0) - (a.geradoEm || 0)));
            const pular = Math.max(0, Number(p.pular) || 0), lim = Math.min(100, Math.max(1, Number(p.limite) || 40));
            out.total = sel.length; out.itens = sel.slice(pular, pular + lim).map(x => fuPublico(x, prev));
          }
          return json(res, out);
        }
        else if (ac === 'followup_varrer') { const n = fuVarrer(); return json(res, Object.assign({ ok: true, mudou: n }, fuResumo())); }
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
            else if (p.acao === 'refazer' && ['pronto', 'aprovado', 'cancelado', 'erro', 'desistiu'].includes(x.status)) {   // 23/11/2026: o Djhonata pede para a IA reescrever com a conversa de agora
              if (p.crm && typeof p.crm === 'object') x.crm = Object.assign({}, x.crm || {}, { nome: String(p.crm.nome || '').slice(0, 80), bairro: String(p.crm.bairro || '').slice(0, 80), imovel: String(p.crm.imovel || '').slice(0, 160), proximo: String(p.crm.proximo || '').slice(0, 300), resumo: String(p.crm.resumo || '').slice(0, 1500), historico: String(p.crm.historico || '').slice(0, 1800), obs: String(p.crm.obs || '').slice(-900) });
              Object.assign(x, { status: 'fila', tent: 0, erro: '', criadoEm: Date.now() }); n++; setTimeout(fuTrabalhar, 300); }
            else if (!p.acao) n++;
          }
          salvarFu();
          const prev = fuPrevisoes();
          return json(res, Object.assign({ ok: true, alterados: n, itens: tels.map(t => fuPublico(fu[t], prev)) }, fuResumo()));
        }
        else if (ac === 'pulso') {   // 24/11/2026 (Djhonata, economia no Make): eventos + quem escreveu por último + sem resposta + mapa do follow-up + últimas mensagens numa chamada só
          let linhas = []; try { linhas = fs.readFileSync(path.join(DADOS, 'eventos-crm.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean); } catch (e) { }
          const okEv = new Set(estado.eventosOk || []);
          const pend = linhas.filter(e => e.rid && !okEv.has(e.rid)).slice(-100);
          const ult = {}, ag = {}, ultimas = {}, nossa = {};
          for (const jid of Object.keys(chats)) {
            const c = chats[jid]; const t = (c.telefone || '').replace(/\D/g, '').slice(-8);
            if (t.length !== 8) continue;
            const u = ultCli(jid); if (u) ult[t] = Math.max(ult[t] || 0, u);
            const un = ultNossa(jid); if (un) nossa[t] = Math.max(nossa[t] || 0, un);
            if (c.ultAutor === 'cliente' && Date.now() - (c.ult || 0) < 30 * 864e5) { const ut = semAcento(c.ultTexto || '').trim(); if (ut && !RE_RESPOSTA_AUTO.test(ut) && !RE_SO_OK.test(ut) && !RE_LEVE.test(ut)) ag[t] = c.ult; }
            if (jidValido(jid) && !jid.endsWith('@g.us') && c.ult) { const t2 = tel8Chat(jid); if (t2) ultimas[t2] = Math.max(ultimas[t2] || 0, c.ult); }
          }
          const mapa = {}; for (const v of Object.values(fu)) if (!(v.status === 'enviado' && Date.now() - (v.enviadoEm || 0) >= 7 * 864e5) && !(v.status === 'pausado' && Date.now() >= (v.ate || 0))) mapa[v.tel8] = v.status;
          return json(res, Object.assign(fuResumo(), { pulso: true, eventos: pend, ultimaMsgCliente: ult, ultimaMsgNossa: nossa, aguardando: ag, mapa, ultimas }));
        }
        else if (ac === 'eventos') {
          let linhas = []; try { linhas = fs.readFileSync(path.join(DADOS, 'eventos-crm.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean); } catch (e) { }
          const ok = new Set(estado.eventosOk || []);
          const pend = linhas.filter(e => e.rid && !ok.has(e.rid)).slice(-100);
          const ult = {}; for (const jid of Object.keys(chats)) { const c = chats[jid]; const t = (c.telefone || '').replace(/\D/g, '').slice(-8); const u = ultCli(jid); if (t.length === 8 && u) ult[t] = Math.max(ult[t] || 0, u); }
          const ag = {}; for (const jid of Object.keys(chats)) { const c = chats[jid]; const t = (c.telefone || '').replace(/\D/g, '').slice(-8); if (t.length !== 8 || c.ultAutor !== 'cliente' || Date.now() - (c.ult || 0) >= 30 * 864e5) continue; const ut = semAcento(c.ultTexto || '').trim(); if (ut && !RE_RESPOSTA_AUTO.test(ut) && !RE_SO_OK.test(ut) && !RE_LEVE.test(ut)) ag[t] = c.ult; }   // 24/11/2026: escreveu por último e está sem resposta (mensagem vazia de empresa, resposta automática e só "ok" ou "obrigado" não contam)
          return json(res, { eventos: pend, ultimaMsgCliente: ult, aguardando: ag });
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
          if (b.texto === 'atualizar') { for (const g of Object.values(geo.imoveis)) if (g && (!g.lat || g.aprox)) delete g.tentativa; geoRotina(30).catch(e => log('geo', e.message)); }   // o botão "Buscar no mapa agora" tenta de novo os que não foram achados
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
        else if (ac === 'ofertas_enviadas') {   // 23/11/2026: imóveis que cada cliente já recebeu, pelas conversas. texto = JSON { nomes: [...] } (sem nomes = todos)
          let p = {}; try { p = JSON.parse(String(b.texto || '{}')); } catch (e) { }
          const quer = new Set((Array.isArray(p.nomes) ? p.nomes : []).map(n => semAcento(n).trim()).filter(Boolean));
          return json(res, { ok: true, enviados: ofertasEnviadas(quer) });
        }
        else if (ac === 'ofertas_repetidas') {   // 23/11/2026 (caso Gabriele): clientes que receberam o MESMO imóvel mais de uma vez pelo painel ou CRM (autor "voce"), com 20h ou mais entre uma e outra
          const out = [];
          for (const j of Object.keys(chats)) {
            const t8 = tel8De(j); if (!t8 || t8.length !== 8) continue; const porNome = {}; let l = []; try { l = lerEsp(j); } catch (e) { continue; }
            for (const m of l) { if (m.autor !== 'voce' || !m.texto) continue; for (const x of String(m.texto).matchAll(RE_CASA_NOME)) { const n = semAcento(x[1]).trim(); if (n) (porNome[n] = porNome[n] || []).push(m.ts || 0); } }
            for (const [n, ts] of Object.entries(porNome)) { ts.sort((x, y) => x - y); const sep = [ts[0]]; for (const t of ts) if (t - sep[sep.length - 1] > 20 * 3600e3) sep.push(t); if (sep.length > 1) out.push({ t8, nome: String((chats[j] || {}).nome || '').slice(0, 40), imovel: n, vezes: sep.map(quandoFoi) }); }
          }
          return json(res, { ok: true, repetidas: out });
        }
        else if (ac === 'ja_recebeu') {   // 23/11/2026: este cliente já recebeu este imóvel? jid = conversa (ou telefone); texto = nome do imóvel
          let j = String(b.jid || ''); if (j && !chats[j]) { const t8 = j.replace(/\D/g, '').slice(-8), k = Object.keys(chats).find(x => tel8De(x) === t8); if (k) j = k; }
          return json(res, { ok: true, ja: j ? jaRecebeuImovel(j, String(b.texto || '')) : 0 });
        }
        else if (ac === 'videos') {   // 23/11/2026: vídeos dos imóveis feitos das fotos. texto = JSON { ligar: true|false, ref, refazer, amostra }; sem nada devolve a situação
          let pv = {}; try { pv = JSON.parse(String(b.texto || '{}')) || {}; } catch (e) { }
          if (pv.ligar === true) { fs.writeFileSync(VID_LIGADO, '1'); vidRotina().catch(e => log('vídeos', e.message)); }
          if (pv.ligar === false) { try { fs.unlinkSync(VID_LIGADO); } catch (e) { } vid.parar = true; }
          if (pv.amostra) { const pa2 = acharPasta(String(pv.amostra)); return json(res, { pasta: pa2, jpg: pa2 ? await vidAmostra(pa2) : '' }); }
          if (pv.ref) {
            const pr = acharPasta(String(pv.ref)); if (!pr) return json(res, { erro: 'imóvel não encontrado' }, 404);
            if (vid.rodando) return json(res, { erro: 'ocupado com ' + vid.rodando }, 409);
            vid.rodando = pr;
            vidGerar(pr, !!pv.refazer).then(r => { vid.ultimoPedido = { pasta: pr, resultado: r, em: Date.now() }; if (r === 'ok') vid.feitos.push(pr); }).catch(e => { vid.ultimoPedido = { pasta: pr, resultado: 'erro: ' + e.message, em: Date.now() }; }).finally(() => { vid.rodando = ''; });
            return json(res, { ok: true, fazendo: pr });
          }
          const falta = vidFaltando();
          if (pv.com) return json(res, { com: pastasImoveis().filter(x => fs.existsSync(path.join(CATALOGO, x, 'video-whatsapp.mp4'))).map(x => (/ref (\d+)\)$/.exec(x) || [0, x])[1]), sem: falta.map(x => (/ref (\d+)\)$/.exec(x) || [0, x])[1]) });   // 24/11/2026: o CRM mostra quais imóveis têm vídeo no servidor
          return json(res, { ligado: fs.existsSync(VID_LIGADO), ffmpeg: temFfmpeg(), rodando: vid.rodando, feitos: vid.feitos.length, faltam: falta.length, lista: falta.slice(0, 160).map(x => (/ref (\d+)\)$/.exec(x) || [0, x])[1]).join(' '), erros: vid.erros, ultimoPedido: vid.ultimoPedido || null, drawtext: vid.drawtext, fonte: path.basename(vid.fonte || ''), musica: vid.musica });
        }
        else if (ac === 'regras_enxugar') {   // texto = JSON { testar: true } só mostra o plano; { desfazer: true } volta a cópia; sem nada, faz a limpeza agora
          let pe = {}; try { pe = JSON.parse(String(b.texto || '{}')) || {}; } catch (e) { }
          if (pe.desfazer) return json(res, enxDesfazer());
          if (pe.ultimo) return json(res, lerJson(ENX_LOG, {}));
          regrasEnxugar({ testar: !!pe.testar }).then(r => { gravarJson(path.join(DADOS, 'regras-limpeza-ultimo-pedido.json'), r); }).catch(e => { gravarJson(path.join(DADOS, 'regras-limpeza-ultimo-pedido.json'), { erro: e.message }); });
          return json(res, { ok: true, rodando: true });
        }
        else if (ac === 'regras_enxugar_ver') return json(res, lerJson(path.join(DADOS, 'regras-limpeza-ultimo-pedido.json'), { aguardando: true }));
        else if (ac === 'semana') {   // 24/11/2026 (pente fino do Djhonata): conversas com a assistente desde uma data, em texto curto. texto = JSON { desde (ms), pular, limite, max }
          let p = {}; try { p = JSON.parse(String(b.texto || '{}')); } catch (e) { }
          const desde = Number(p.desde) || Date.now() - 2 * 864e5, pular = Math.max(0, Number(p.pular) || 0), limite = Math.max(1, Math.min(40, Number(p.limite) || 20)), max = Math.max(80, Math.min(1500, Number(p.max) || 600));
          const fora = new Set(['pessoal', 'corretor', 'construtor', 'corretor_euro']);
          const hh = (ts) => new Date(ts - 3 * 3600e3).toISOString().slice(5, 16).replace('T', ' ');
          const lista = Object.keys(chats).filter(j => jidValido(j) && !/@g\.us$/.test(j) && (chats[j].ult || 0) > desde && !fora.has((estado.crmStatus || {})[tel8De(j)] || ''))
            .map(j => { const ms = lerEsp(j); return { j, ms, ia: ms.some(m => m.autor === 'ia' && (m.ts || 0) > desde) }; }).filter(x => x.ia).sort((x, y) => (chats[y.j].ult || 0) - (chats[x.j].ult || 0));
          const out = lista.slice(pular, pular + limite).map(({ j, ms }) => {
            const ini = ms.findIndex(m => (m.ts || 0) > desde), ctxIni = Math.max(0, (ini < 0 ? ms.length : ini) - 4);
            return { t8: tel8De(j), nome: chats[j].nome || '', status: (estado.crmStatus || {})[tel8De(j)] || '', msgs: ms.slice(ctxIni).map(m => `${hh(m.ts || 0)} ${m.autor === 'cliente' ? 'C' : m.autor === 'ia' ? 'IA' : 'DJ'}${m.tipo && m.tipo !== 'text' ? '[' + m.tipo + ']' : ''}: ${String(m.texto || '').replace(/\s+/g, ' ').slice(0, max)}`) };
          });
          return json(res, { total: lista.length, pular, limite, conversas: out });
        }
        else if (ac === 'falas') {   // 23/11/2026 (Djhonata, caso Nilza): o que o cliente escreveu depois de um momento (ex.: depois da última oferta), para a IA das oportunidades ver se ele gostou do que recebeu. texto = JSON { tels: [{ t8, desde }], max }
          let p = {}; try { p = JSON.parse(String(b.texto || '{}')); } catch (e) { }
          const max = Math.max(100, Math.min(800, Number(p.max) || 400)), out = {};
          for (const it of (Array.isArray(p.tels) ? p.tels : []).slice(0, 40)) {
            const t8 = String((it && it.t8) || '').replace(/\D/g, '').slice(-8), desde = Number(it && it.desde) || 0; if (t8.length !== 8) continue;
            const f = [];
            for (const j of Object.keys(chats)) { if (tel8De(j) !== t8) continue; for (const m of lerEsp(j)) { if (m.autor === 'cliente' && (m.ts || 0) > desde && String(m.texto || '').trim()) f.push([m.ts || 0, String(m.texto).replace(/\s+/g, ' ').trim()]); } }
            if (f.length) out[t8] = f.sort((x, y) => x[0] - y[0]).map(x => x[1]).join(' · ').slice(-max);
          }
          return json(res, { ok: true, falas: out });
        }
        else if (ac === 'regras_buscar') {   // 23/11/2026: procura um padrão em todos os arquivos de regras e devolve só os trechos (para conferir sem baixar tudo)
          let o = {}; try { o = JSON.parse(String(b.texto || '{}')); } catch (e) { }
          let re = null; try { re = new RegExp(String(o.re || ''), 'giu'); } catch (e) { return json(res, { erro: 'expressão inválida' }, 400); }
          if (!o.re) return json(res, { erro: 'mande texto = JSON { re }' }, 400);
          const arqs = (Array.isArray(o.arquivos) && o.arquivos.length ? o.arquivos : ARQS_REGRAS).filter(f => ARQS_REGRAS.includes(f)), ctx = Math.min(400, Math.max(20, Number(o.ctx) || 90)), max = Math.min(200, Number(o.max) || 60);
          const achados = [], tam = {};
          for (const f of arqs) { let t = ''; try { t = fs.readFileSync(path.join(CATALOGO, f), 'utf8').replace(/\r/g, ''); } catch (e) { } tam[f] = t.length; let m; re.lastIndex = 0;
            while ((m = re.exec(t)) && achados.length < max) { if (!m[0]) { re.lastIndex++; continue; } achados.push({ arquivo: f, pos: m.index, achou: m[0].slice(0, 80), trecho: t.slice(Math.max(0, m.index - ctx), m.index + m[0].length + ctx).replace(/\n/g, ' ⏎ ') }); } }
          return json(res, { ok: true, total: achados.length, tamanhos: tam, achados });
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
        else if (ac === 'visitas_status') {   // 17/11/2026 (Djhonata): a agenda do CRM mostra se o lembrete saiu e se o cliente confirmou a visita
          const out = [];
          for (const [j, v] of Object.entries(estado.visitas || {})) { try { const c = visitaConfirmacao(j, v); const r = visitaResposta(j, Math.max((v.enviados || {}).l24 || 0, (v.enviados || {}).l2 || 0)); out.push({ tel8: tel8Chat(j), q: v.q, criado: v.criado || 0, l1: (v.enviados || {}).l24 || 0, l2: (v.enviados || {}).l2 || 0, conf: c.conf, confEm: c.em, confTexto: c.texto, resp: r.resp, respEm: r.respEm }); } catch (e) { } }
          let pedido = []; try { pedido = (JSON.parse(String(b.texto || '{}')).tels || []).map(x => String(x).replace(/\D/g, '').slice(-8)).filter(x => x.length === 8).slice(0, 40); } catch (e) { }
          for (const t8 of pedido) { if (out.some(o => o.tel8 === t8)) continue; try { const o = visitaSolta(t8); if (o) out.push(o); } catch (e) { } }
          return json(res, { ok: true, em: Date.now(), visitas: out });
        }
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
          return json(res, { baileys: bl, etiquetas: etq.labels, equipe: estado.equipe || [], etiquetando, temAddLabel: !!(sock && typeof sock.addLabel === 'function'), chats: Object.keys(chats).length, lids: lids.length, lidsComTelefone: lids.filter(j => lidPn[j] || chats[j].telefone).length, mapa: Object.keys(lidPn).length, contatos: Object.keys(contatos).length, temLidMapping: !!(sock && sock.signalRepository && sock.signalRepository.lidMapping) });
        }
        else if (ac === 'avisos') {   // dúvidas de clientes que a assistente anotou para o Djhonata responder (não foram para o celular dele)
          return json(res, { ok: true, avisos: (estado.avisos || []).filter(a => a.tipo === 'duvida' && !a.feito).slice(-40).reverse() });
        }
        else if (ac === 'simular') {   // 23/11/2026: o CRM pede a condição padrão de imóveis (pendências): texto = JSON [ref ou nome, ...]; devolve o bloco pronto de cada um
          let lst = []; try { lst = JSON.parse(String(b.texto || '[]')); } catch (e) { }
          if (!Array.isArray(lst)) lst = [lst];
          const itens = lst.slice(0, 6).map(im => { try { const r = simularFluxo({ imovel: String(im) }); return r.erro ? { imovel: String(im), erro: r.erro } : { imovel: String(im), pasta: r.pasta, resumo: r.resumo, texto: r.texto }; } catch (e) { return { imovel: String(im), erro: e.message }; } });
          return json(res, { ok: true, itens });
        }
        else if (ac === 'rascunho') {   // texto = JSON { chave, oque, pergunta, mensagem } (pedir) ou { chave } (buscar o resultado)
          let p = {}; try { p = JSON.parse(String(b.texto || '{}')); } catch (e) { }
          if (Array.isArray(p.lote)) {   // várias pendências de uma vez: [{ chave, tel, oque, pergunta, mensagem }]
            let n = 0;
            for (const q of p.lote.slice(0, 100)) {
              const ch = String(q.chave || '').slice(0, 60); if (!ch || rascunhos.fila.some(x => x.chave === ch) || (rascunhos.prontos[ch] && rascunhos.prontos[ch].ok && !p.refazer)) continue;
              const alvo = jidPorTel8(String(q.tel || '').replace(/\D/g, '').slice(-8)); if (!alvo) continue;
              delete rascunhos.prontos[ch]; rascunhos.fila.push({ chave: ch, jid: alvo, oque: String(q.oque || '').slice(0, 400), pergunta: String(q.pergunta || '').slice(0, 400), mensagem: String(q.mensagem || '').slice(0, 1200) }); n++;
            }
            rascunhoTrabalhar().catch(e => log('rascunho', e.message));
            return json(res, { ok: true, naFila: rascunhos.fila.length, novos: n });
          }
          if (Array.isArray(p.chaves)) { const out = {}; for (const k of p.chaves.slice(0, 100)) if (rascunhos.prontos[k]) out[k] = rascunhos.prontos[k]; return json(res, { prontos: out, naFila: rascunhos.fila.length, rodando: rascunhos.rodando }); }   // várias de uma vez (economiza operação do Make)
          const chave = String(p.chave || '').slice(0, 60); if (!chave) return json(res, { erro: 'falta a chave' }, 400);
          const pronto = rascunhos.prontos[chave];
          if (pronto && !p.refazer) return json(res, Object.assign({ pronto: true }, pronto));
          if (p.oque || p.pergunta) {
            const alvo = jidValido(jid) && chats[jid] ? jid : jidPorTel8(String(b.jid || '').replace(/\D/g, '').slice(-8));
            if (!alvo) return json(res, { erro: 'conversa não encontrada' }, 404);
            if (!rascunhos.fila.some(x => x.chave === chave)) { delete rascunhos.prontos[chave]; rascunhos.fila.push({ chave, jid: alvo, oque: String(p.oque || '').slice(0, 400), pergunta: String(p.pergunta || '').slice(0, 400), mensagem: String(p.mensagem || '').slice(0, 1200) }); }
            rascunhoTrabalhar().catch(e => log('rascunho', e.message));
          }
          return json(res, { pronto: false, naFila: rascunhos.fila.length, rodando: rascunhos.rodando });
        }
        else if (ac === 'avisos_limpar') { const n = limparDuvidas(); return json(res, { ok: true, saiu: n, ficam: (estado.avisos || []).filter(a => a.tipo === 'duvida' && !a.feito).length }); }
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
        else if (ac === 'conjuntos_salvar') {   // texto = JSON { ref: casas no conjunto }: o CRM manda quantas casas tem cada geminado, para a assistente saber qual é a de ponta
          let m = null; try { m = JSON.parse(String(b.texto || '')); } catch (e) { }
          if (!m || typeof m !== 'object' || Array.isArray(m)) return json(res, { erro: 'mande texto = JSON { "ref": casas }' }, 400);
          const novo = {}; for (const [k, v] of Object.entries(m)) { const n = Math.round(Number(v)), r = String(k).replace(/\D/g, ''); if (r && n >= 2 && n <= 60) novo[r] = n; }
          estado.conjuntos = novo; salvarEstado(); log('conjuntos: o CRM mandou', Object.keys(novo).length, 'imóveis');
          return json(res, { ok: true, total: Object.keys(novo).length });
        }
        else if (ac === 'fichas_gerar') {   // texto = telefones separados por vírgula: põe na fila quem tem conversa e ainda não tem ficha
          const tels = String(b.texto || '').split(/[,;\s]+/).filter(Boolean); let naFila = 0, jaTem = 0, semConversa = 0;
          for (const t of tels) { const j = fichaAlvo(t); if (!j || !lerEsp(j).length) { semConversa++; continue; } if (lerFichaAt(j)) { jaTem++; continue; } fichaPedir(j, 'quem já marcou visita'); naFila++; }
          return json(res, { ok: true, naFila, jaTem, semConversa });
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
        else if (ac === 'midias') {   // 25/11/2026: lista as mídias guardadas de uma conversa (fotos, PDFs) para o Claude baixar e cadastrar imóvel
          if (!jidValido(jid)) return json(res, { erro: 'conversa inválida' }, 400);
          const l = lerEsp(jid).filter(m => m.arquivo).slice(-Math.min(200, Number(b.texto) || 80));
          return json(res, { midias: l.map(m => { let tam = 0; try { tam = fs.statSync(path.join(MIDIA, path.basename(m.arquivo))).size; } catch (e) { } return { id: m.id, autor: m.autor, tipo: m.tipo, ts: m.ts, texto: m.texto || '', nomeArquivo: m.nomeArquivo || '', arquivo: path.basename(m.arquivo), tam }; }) });
        }
        else if (ac === 'midia') {   // 25/11/2026: um arquivo de mídia em base64 (até 8 MB), pelo nome que 'midias' devolveu
          const f = path.join(MIDIA, path.basename(String(b.texto || '')));
          if (!b.texto || !fs.existsSync(f)) return json(res, { erro: 'arquivo não encontrado' }, 404);
          const st = fs.statSync(f); if (st.size > 8e6) return json(res, { erro: 'arquivo grande demais', tam: st.size }, 413);
          return json(res, { nome: path.basename(f), tam: st.size, b64: fs.readFileSync(f).toString('base64') });
        }
        else if (ac === 'backup') {   // 25/11/2026 (Djhonata): cópia completa no servidor (regras, conversas, estado) + conferência de saúde. Não copia a pasta auth (credenciais do WhatsApp).
          const quando = new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 16).replace('T', '-').replace(':', '');
          const raiz = path.join(DADOS, 'backups'), dest = path.join(raiz, quando); fs.mkdirSync(path.join(dest, 'regras'), { recursive: true });
          const feitos = [], problemas = [], regras = {};
          for (const f of ARQS_REGRAS) { const tx = lerTexto(f); regras[f] = tx; if (!tx) problemas.push('regra vazia: ' + f); else { fs.writeFileSync(path.join(dest, 'regras', f), tx); feitos.push({ nome: 'regras/' + f, tam: tx.length }); } }
          for (const f of ['chats.json', 'estado.json', 'etiquetas.json', 'followups.json', 'geo.json', 'anuncios-imoveis.json', 'lid-telefone.json', 'contatos.json', 'regras-limpeza.json', 'uso.json', 'eventos-crm.jsonl']) {
            const o = path.join(DADOS, f); if (!fs.existsSync(o)) continue;
            try { const raw = fs.readFileSync(o); if (f.endsWith('.json')) { try { JSON.parse(raw.toString('utf8')); } catch (e) { problemas.push('JSON com defeito: ' + f + ' (' + e.message.slice(0, 80) + ')'); } } fs.writeFileSync(path.join(dest, f), raw); feitos.push({ nome: f, tam: raw.length }); } catch (e) { problemas.push('não copiou ' + f + ': ' + e.message); }
          }
          const pastas = {};
          for (const d of ['espelho', 'conversas']) { try { fs.cpSync(path.join(DADOS, d), path.join(dest, d), { recursive: true }); pastas[d] = fs.readdirSync(path.join(dest, d)).length; } catch (e) { problemas.push('não copiou a pasta ' + d + ': ' + e.message); } }
          let antigos = []; try { antigos = fs.readdirSync(raiz).filter(n => /^\d{4}-\d{2}-\d{2}-\d{4}$/.test(n)).sort(); for (const n of antigos.slice(0, Math.max(0, antigos.length - 10))) fs.rmSync(path.join(raiz, n), { recursive: true, force: true }); } catch (e) { }
          let disco = null; try { const s = fs.statfsSync(DADOS); disco = { livreGB: Math.round(s.bavail * s.bsize / 1e8) / 10, totalGB: Math.round(s.blocks * s.bsize / 1e8) / 10 }; } catch (e) { }
          let erros = []; try { erros = fs.readFileSync(path.join(DADOS, 'ponte.log'), 'utf8').split('\n').slice(-600).filter(l => /erro|error|falh|exce/i.test(l)).slice(-25).map(l => l.slice(0, 220)); } catch (e) { }
          let midia = 0; try { midia = fs.readdirSync(MIDIA).length; } catch (e) { }
          return json(res, { ok: true, pasta: 'dados/backups/' + quando, copias: antigos.length, feitos, pastas, problemas, regras, saude: { conectado, numero: meuNumero, noArHaMin: Math.round(process.uptime() / 60), memoriaMB: Math.round(process.memoryUsage().rss / 1e6), node: process.version, disco, chats: Object.keys(chats).length, midia, videos: { rodando: vid.rodando || '', faltam: vidFaltando().length }, errosRecentes: erros } });
        }
        else if (ac === 'ensaio') {   // texto = JSON {msgs:[...], nome, audio} começa; sem msgs devolve o andamento
          let p = {}; try { p = JSON.parse(String(b.texto || '{}')); } catch (e) { }
          if (Array.isArray(p.msgs) && p.msgs.length) {
            if (ensaio.rodando) return json(res, { erro: 'já tem um ensaio rodando' }, 409);
            ensaio = { rodando: true, inicio: Date.now(), saida: [] };
            rodarEnsaio(p).catch(e => { ensaio.erro = e.message; log('ensaio', e.message); }).finally(() => { ensaio.rodando = false; ensaio.fim = Date.now(); });
            return json(res, { ok: true, comecou: true });
          }
          return json(res, ensaio);
        }
        else if (ac === 'regras_consolidar') {   // texto = JSON {comecar:true} faz a versão de teste; {aplicar:true} põe no ar (com cópia); {desfazer:true} volta a cópia; {ver:'trecho'} procura na versão de teste; sem nada: andamento
          let p = {}; try { p = JSON.parse(String(b.texto || '{}')) || {}; } catch (e) { }
          const f = 'MELHORIAS-APROVADAS.md', teste = path.join(REGRAS_TESTE, f), dia = new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10), copia = 'MELHORIAS-APROVADAS-backup-consolidacao-' + dia + '.md';
          if (p.comecar) {
            if (consolidacao.rodando) return json(res, { erro: 'já está rodando' }, 409);
            consolidacao = { rodando: true, inicio: Date.now() };
            regrasConsolidar().then(r => { consolidacao.resultado = r; log('consolidação de teste pronta', JSON.stringify(r)); }).catch(e => { consolidacao.erro = e.message; log('consolidação', e.message); }).finally(() => { consolidacao.rodando = false; consolidacao.fim = Date.now(); });
            return json(res, { ok: true, comecou: true });
          }
          if (p.aplicar) {
            if (!fs.existsSync(teste)) return json(res, { erro: 'não tem versão de teste' }, 400);
            fs.writeFileSync(path.join(CATALOGO, copia), lerTexto(f)); fs.copyFileSync(teste, path.join(CATALOGO, f));
            log('consolidação aplicada; cópia', copia); return json(res, { ok: true, copia, tamanho: lerTexto(f).length });
          }
          if (p.desfazer) {
            const c = path.join(CATALOGO, p.copia || copia); if (!fs.existsSync(c)) return json(res, { erro: 'cópia não encontrada', copia: p.copia || copia }, 400);
            fs.copyFileSync(c, path.join(CATALOGO, f)); log('consolidação desfeita', p.copia || copia); return json(res, { ok: true, voltou: p.copia || copia });
          }
          if (p.ver) { let t = ''; try { t = fs.readFileSync(teste, 'utf8'); } catch (e) { } const i = t.indexOf(String(p.ver)); return json(res, { tamanho: t.length, achou: i >= 0, trecho: i >= 0 ? t.slice(Math.max(0, i - 200), i + (Number(p.n) || 3000)) : '' }); }
          if (p.texto) { let t = ''; try { t = fs.readFileSync(teste, 'utf8'); } catch (e) { } const de = Number(p.de) || 0; return json(res, { tamanho: t.length, de, texto: t.slice(de, de + (Number(p.n) || 20000)) }); }
          return json(res, consolidacao);
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
