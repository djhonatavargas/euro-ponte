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
const {
  default: makeWASocket, useMultiFileAuthState, DisconnectReason,
  fetchLatestBaileysVersion, downloadMediaMessage, Browsers
} = require('@whiskeysockets/baileys');

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
const ESPERA_MS = Number(ENV.ESPERA_MS || 9000);  // espera o cliente terminar de digitar
const HORA_INI = ENV.HORA_INI || '08:00';
const HORA_FIM = ENV.HORA_FIM || '23:30';

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
function dentroDoHorario() { const d = agoraSP(); const x = d.getHours() * 60 + d.getMinutes(); return x >= minutos(HORA_INI) && x <= minutos(HORA_FIM); }

// ---------- conversas (memória) ----------
function arqConv(id) { return path.join(CONV, id.replace(/[^0-9a-zA-Z@._-]/g, '_') + '.json'); }
function lerConv(id) { return lerJson(arqConv(id), []); }
function anotar(id, role, texto) {
  const h = lerConv(id);
  h.push({ role, texto: String(texto).slice(0, 6000), ts: Date.now() });
  gravarJson(arqConv(id), h.slice(-200));
}

// ---------- regras e catálogo (vêm do computador do Djhonata pelo enviar-catalogo.ps1) ----------
const ARQS_REGRAS = ['REGRAS-ATENDIMENTO.md', 'JEITO-DO-DJHONATA.md', 'ATENDIMENTO-INTELIGENTE.md', 'BASE-RESPOSTAS.md', 'APRENDIZADOS.md', 'combinados-clientes.md', 'CATALOGO.md'];
function lerTexto(rel) { try { return fs.readFileSync(path.join(CATALOGO, rel), 'utf8'); } catch (e) { return ''; } }

const ADAPTADOR = `# COMO VOCÊ FUNCIONA AQUI (vale acima das partes técnicas das regras)
Você está rodando num servidor novo, não mais no OpenClaw. As regras de atendimento abaixo continuam valendo (tom, identidade como Djhonata, oferta, agenda, endereço, emojis, nunca prometer "já te mando" etc.). Só a parte técnica muda:
- Sua resposta em texto é enviada ao cliente no WhatsApp. Para mandar mais de uma mensagem separada, coloque uma linha só com --- entre elas. Se não for para responder nada, responda exatamente NO_REPLY.
- Para mandar foto, vídeo ou arquivo use a ferramenta enviar_arquivo (caminho relativo à pasta do catálogo, ex.: "escritorio/fachada.jpg" ou "rua lapa - boa vista (ref 913)/foto.jpg"; ou um link https de imagem). Onde as regras falam em ferramenta message, tool_call openclaw, ou caminhos C:\\Users\\Public\\catalogo\\..., use enviar_arquivo com o caminho a partir da pasta do catálogo. Mídia e texto saem na ordem em que você escreve e chama as ferramentas.
- Antes de oferecer um imóvel, chame ler_ficha com a ref (ou nome da rua) para pegar a descrição pronta do CRM e a lista de fotos/vídeos. Nunca invente dados.
- Avisos para o Djhonata: ferramenta avisar_djhonata (vai para o WhatsApp pessoal dele). Não use a ferramenta de envio para isso.
- Eventos e resumo do CRM (mudança de status, resumo do cliente, cliente pausado): ferramenta registrar_crm. Não escreva arquivos .jsonl.
- Lembretes de visita, retomadas e comandos do CRM NÃO são feitos aqui por enquanto: ignore essas rotinas. Só atenda a conversa atual.
- Áudio: por enquanto você não consegue ouvir áudios. Se o cliente mandar áudio, diga de forma natural que agora não consegue ouvir e peça para ele escrever (sem dizer que é IA).
- Imagens que o cliente mandar chegam para você ver.
- O Djhonata acompanha as conversas por um painel e às vezes escreve direto para o cliente. As mensagens dele aparecem no histórico como "(Djhonata escreveu)". Continue a conversa a partir do que ele disse: não repita o que ele já mandou, não contradiga e não se apresente de novo.`;

function sistema(ctx) {
  const partes = [ADAPTADOR];
  for (const f of ARQS_REGRAS) { const t = lerTexto(f); if (t) partes.push(`\n\n===== ${f} =====\n${t}`); }
  const fixo = partes.join('');
  const d = agoraSP();
  const dia = d.toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric' });
  const hora = d.toTimeString().slice(0, 5);
  let din = `Agora: ${dia}, ${hora} (horário de Joinville).\nConversa com: ${ctx.nome || 'nome não informado'} — WhatsApp ${ctx.telefone ? formatoBR(ctx.telefone) : 'desconhecido'}.`;
  din += `\nRegra de segurança do número: escreva cada resposta com suas palavras para este cliente; não copie textos prontos idênticos aos de outras conversas (varie saudação e frases). Mensagens curtas, uma ideia por mensagem, sem excesso de links.`;
  if (ctx.dono) din += `\nATENÇÃO: quem está escrevendo é o próprio Djhonata (dono). Atenda os pedidos dele diretamente (ex.: mandar um imóvel no formato pronto para encaminhar ao cliente).`;
  return [{ type: 'text', text: fixo, cache_control: { type: 'ephemeral' } }, { type: 'text', text: din }];
}

// ---------- ferramentas ----------
const FERRAMENTAS = [
  { name: 'ler_ficha', description: 'Lê a ficha de um imóvel do catálogo (descrição pronta do CRM, dados e lista de fotos e vídeo). Use a ref (ex.: "913") ou parte do nome da rua/residencial.', input_schema: { type: 'object', properties: { busca: { type: 'string' } }, required: ['busca'] } },
  { name: 'enviar_arquivo', description: 'Envia ao cliente uma foto, vídeo ou arquivo do catálogo (caminho relativo à pasta do catálogo) ou uma imagem por link https. A legenda vai junto com a mídia.', input_schema: { type: 'object', properties: { caminho: { type: 'string' }, legenda: { type: 'string' } }, required: ['caminho'] } },
  { name: 'avisar_djhonata', description: 'Manda um aviso no WhatsApp pessoal do Djhonata.', input_schema: { type: 'object', properties: { texto: { type: 'string' } }, required: ['texto'] } },
  { name: 'registrar_crm', description: 'Registra no CRM um evento do cliente atual e move o card dele: novoStatus = atendimento, visita_marcada, negociacao, remarcar, sem_interesse ou pausado. Em visita_marcada mande data (AAAA-MM-DD) e hora (HH:MM). Mande nomeReal quando o cliente disser o nome e imovel quando souber qual imóvel interessa. resultado = frase curta do que aconteceu.', input_schema: { type: 'object', properties: { novoStatus: { type: 'string' }, data: { type: 'string' }, hora: { type: 'string' }, nomeReal: { type: 'string' }, imovel: { type: 'string' }, resumo: { type: 'string' }, resultado: { type: 'string' } } } }
];

function pastasImoveis() {
  try { return fs.readdirSync(CATALOGO, { withFileTypes: true }).filter(d => d.isDirectory() && !d.name.startsWith('_')).map(d => d.name); } catch (e) { return []; }
}
function semAcento(s) { return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase(); }
function acharPasta(busca) {
  const b = semAcento(busca).trim();
  const ps = pastasImoveis();
  const ref = /(\d{2,4})/.exec(b);
  if (ref) { const p = ps.find(n => new RegExp(`\\(ref ${ref[1]}\\)`).test(n)); if (p) return p; }
  return ps.find(n => semAcento(n).includes(b)) || null;
}
const EXT_IMG = /\.(jpe?g|png|webp)$/i, EXT_VID = /\.(mp4)$/i;

async function executar(nome, entrada, ctx) {
  try {
    if (nome === 'ler_ficha') {
      const p = acharPasta(entrada.busca || '');
      if (!p) return 'Imóvel não encontrado no catálogo. Confira a ref no CATALOGO.md.';
      const ficha = lerTexto(path.join(p, 'ficha.md'));
      const arqs = fs.readdirSync(path.join(CATALOGO, p)).filter(f => EXT_IMG.test(f) || EXT_VID.test(f));
      return `Pasta: ${p}\nArquivos de mídia: ${arqs.map(a => `${p}/${a}`).join(' | ') || 'nenhum'}\n\n${ficha}`;
    }
    if (nome === 'enviar_arquivo') {
      const r = await enviarArquivo(ctx.jid, entrada.caminho || '', entrada.legenda || '');
      ctx.notas.push(`[enviei ${entrada.caminho}${entrada.legenda ? ' com a legenda: ' + entrada.legenda.slice(0, 300) : ''}]`);
      return r;
    }
    if (nome === 'avisar_djhonata') {
      await enviarTexto(DONO + '@s.whatsapp.net', entrada.texto || '');
      return 'Aviso enviado ao Djhonata.';
    }
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
  const lista = lerEsp(jid);
  if (m.id && lista.some(x => x.id === m.id)) return;
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
function ehDono(jid) { return String(jid || '').startsWith(DONO); }
async function guardaEnvio(jid, autor, texto, tipo) {
  if (autor !== 'ia' || ehDono(jid)) return;                 // você (painel/celular) e avisos ao dono não passam pelo freio
  const c = chats[jid] || {};
  if (!c.ultCliente || Date.now() - c.ultCliente > 24 * 3600e3) throw new Error('bloqueado: o cliente não falou nas últimas 24h (a assistente não puxa conversa)');
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
  }
  envios.push(Date.now()); ultimoEnvio = Date.now();
}
const quedas = [];
function pausarPorSeguranca(motivo) {
  if (!estado.ativo) return;
  estado.ativo = false; salvarEstado(); log('ASSISTENTE PAUSADA POR SEGURANÇA:', motivo); emitir('estado', estadoPublico());
  setTimeout(() => { if (sock && conectado) sock.sendMessage(DONO + '@s.whatsapp.net', { text: `⚠️ Assistente pausada por segurança: ${motivo}. O WhatsApp continua conectado. Reative pelo CRM quando quiser.` }).then(lembrarEnvio).catch(() => { }); }, 3000);
}
async function enviarTexto(jid, texto, autor = 'ia') {
  if (!sock || !conectado || !String(texto || '').trim()) return null;
  try { await guardaEnvio(jid, autor, texto, 'text'); } catch (e) { log('envio barrado', jid, e.message); return null; }
  const r = await sock.sendMessage(jid, { text: String(texto).trim() });
  const id = lembrarEnvio(r);
  registrarEspelho(jid, { id, autor, tipo: 'text', texto: String(texto).trim(), ts: Date.now() });
  return id;
}
async function enviarArquivo(jid, caminho, legenda, autor = 'ia') {
  if (!sock || !conectado) return 'WhatsApp desconectado.';
  let conteudo, tipo, ref = '';
  if (/^https?:\/\//i.test(caminho)) { conteudo = { url: caminho }; tipo = EXT_VID.test(caminho) ? 'video' : 'image'; ref = caminho; }
  else {
    const rel = caminho.replace(/^[\\/]+/, '').replace(/\\/g, '/');
    const abs = path.resolve(CATALOGO, rel);
    if (!abs.startsWith(CATALOGO + path.sep) || !fs.existsSync(abs)) return 'Arquivo não encontrado: ' + caminho;
    conteudo = fs.readFileSync(abs);
    tipo = EXT_IMG.test(abs) ? 'image' : EXT_VID.test(abs) ? 'video' : 'document';
    ref = 'c/' + rel;
  }
  try { await guardaEnvio(jid, autor, legenda, tipo); } catch (e) { return 'Não enviado: ' + e.message; }
  const msg = tipo === 'image' ? { image: conteudo, caption: legenda || undefined }
    : tipo === 'video' ? { video: conteudo, caption: legenda || undefined, mimetype: 'video/mp4' }
      : { document: conteudo, fileName: path.basename(caminho), caption: legenda || undefined, mimetype: 'application/octet-stream' };
  const r = await sock.sendMessage(jid, msg);
  const id = lembrarEnvio(r);
  registrarEspelho(jid, { id, autor, tipo, texto: legenda || '', arquivo: ref, nomeArquivo: tipo === 'document' ? path.basename(caminho) : undefined, ts: Date.now() });
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
    const inner = x.ephemeralMessage || x.viewOnceMessage || x.viewOnceMessageV2 || x.viewOnceMessageV2Extension || x.documentWithCaptionMessage || x.editedMessage;
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
  const x = desembrulhar(m);
  if (x.protocolMessage || x.reactionMessage || (x.senderKeyDistributionMessage && Object.keys(x).length === 1)) return;
  const texto = textoDe(x);
  const tipo = tipoDe(x);
  const ts = tsDe(m);
  const recente = Date.now() - ts < 180e3;
  const telefone = telefoneDe(m);

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
  }
  if (!recente) return; // mensagem antiga (sincronização do histórico): só espelho

  if (m.key.fromMe) {
    if (enviados.has(m.key.id)) return; // foi a ponte (assistente ou painel)
    // escrito no celular ou em outro aparelho conectado
    if (/^#bot\b/i.test(texto.trim())) { delete estado.pausas[jid]; salvarEstado(); emitir('chat', chatPublico(jid)); log('assistente reativada em', jid); return; }
    if (/^#pausa\b/i.test(texto.trim())) { estado.pausas[jid] = Date.now() + 3650 * 864e5; salvarEstado(); emitir('chat', chatPublico(jid)); return; }
    if (texto || tipo !== 'text') anotar(jid, 'assistant', `(Djhonata escreveu) ${texto || '[' + tipo + ']'}`);
    if (PAUSA_HORAS > 0) { estado.pausas[jid] = Date.now() + PAUSA_HORAS * 3600e3; salvarEstado(); filas.delete(jid); emitir('chat', chatPublico(jid)); }
    return;
  }
  if (tipoUpsert !== 'notify') return;

  const dono = telefone && normal(telefone) === normal(DONO);
  if (!dono && telefone && lerBloqueados().has(normal(telefone))) { log('bloqueado, ignorado', telefone); return; }

  let entrada = texto;
  let imagem = null;
  if (x.audioMessage) entrada = (entrada ? entrada + '\n' : '') + '[o cliente mandou um áudio]';
  if (x.imageMessage) {
    const buf = m._midia && m._midia.buf;
    if (buf && buf.length < 4.5e6) imagem = { data: buf.toString('base64'), mime: m._midia.mime || 'image/jpeg' };
    entrada = (entrada ? entrada + '\n' : '') + '[o cliente mandou uma imagem]';
  }
  if (x.videoMessage) entrada = (entrada ? entrada + '\n' : '') + '[o cliente mandou um vídeo]';
  if (x.documentMessage) entrada = (entrada ? entrada + '\n' : '') + `[o cliente mandou um arquivo: ${x.documentMessage.fileName || ''}]`;
  if (x.contactMessage || x.contactsArrayMessage) entrada = (entrada ? entrada + '\n' : '') + '[o cliente mandou um contato]';
  if (x.locationMessage) entrada = (entrada ? entrada + '\n' : '') + '[o cliente mandou uma localização]';
  if (x.stickerMessage) entrada = (entrada ? entrada + '\n' : '') + '[figurinha]';
  if (!entrada) return;

  anotar(jid, 'user', entrada);
  let f = filas.get(jid);
  if (!f) { f = { jid, telefone, nome: m.pushName || '', dono, imagens: [], timer: null }; filas.set(jid, f); }
  if (m.pushName) f.nome = m.pushName;
  if (imagem) f.imagens.push(imagem);
  clearTimeout(f.timer);
  f.timer = setTimeout(() => processar(jid).catch(e => log('erro processar', e.message)), ESPERA_MS);
}

const ocupado = new Set();
async function processar(jid) {
  const f = filas.get(jid);
  if (!f) return;
  f.timer = null;
  if (!estado.ativo) { filas.delete(jid); return; }                         // assistente pausada: só espelha
  if ((estado.pausas[jid] || 0) > Date.now()) { filas.delete(jid); return; } // assistente desligada nessa conversa
  if (!dentroDoHorario() && !f.dono) { return; }                            // fica na fila até abrir o horário
  if (ocupado.has(jid)) { f.timer = setTimeout(() => processar(jid), 3000); return; }
  filas.delete(jid);
  ocupado.add(jid);
  emitir('digitando', { jid, on: true });
  try { await responder(f); } finally { ocupado.delete(jid); emitir('digitando', { jid, on: false }); }
}
setInterval(() => { if (dentroDoHorario()) for (const [jid, f] of filas) { if (!f.timer) processar(jid).catch(() => { }); } }, 60e3);

function montarMensagens(jid, imagens) {
  const h = lerConv(jid).slice(-40);
  const msgs = [];
  for (const it of h) {
    const role = it.role === 'assistant' ? 'assistant' : 'user';
    if (msgs.length && msgs[msgs.length - 1].role === role) msgs[msgs.length - 1].content[0].text += '\n' + it.texto;
    else msgs.push({ role, content: [{ type: 'text', text: it.texto }] });
  }
  while (msgs.length && msgs[0].role !== 'user') msgs.shift();
  if (!msgs.length || msgs[msgs.length - 1].role !== 'user') msgs.push({ role: 'user', content: [{ type: 'text', text: '(sem mensagem nova)' }] });
  const ult = msgs[msgs.length - 1];
  for (const im of imagens.slice(-3)) ult.content.unshift({ type: 'image', source: { type: 'base64', media_type: im.mime, data: im.data } });
  return msgs;
}

async function claude(system, messages) {
  for (let tentativa = 0; tentativa < 3; tentativa++) {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODELO, max_tokens: 1500, system, tools: FERRAMENTAS, messages })
    });
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
  t[dia] = d; gravarJson(f, t);
}

async function responder(f) {
  const ctx = { jid: f.jid, telefone: f.telefone, nome: f.nome, dono: f.dono, notas: [] };
  const system = sistema(ctx);
  const messages = montarMensagens(f.jid, f.imagens);
  try { await sock.sendPresenceUpdate('composing', f.jid); } catch (e) { }
  const saida = [];
  for (let volta = 0; volta < 8; volta++) {
    const resp = await claude(system, messages);
    messages.push({ role: 'assistant', content: resp.content });
    const resultados = [];
    for (const bloco of resp.content || []) {
      if (bloco.type === 'text') {
        const t = bloco.text.trim();
        if (!t || /^NO_REPLY\b/.test(t)) continue;
        // o Djhonata pode ter desligado a assistente nessa conversa enquanto ela pensava
        if (!estado.ativo || (estado.pausas[f.jid] || 0) > Date.now()) { log('resposta descartada (pausada no meio)', f.jid); return; }
        for (const parte of t.split(/\n\s*---\s*\n/)) { if (parte.trim()) { await enviarTexto(f.jid, parte, 'ia'); saida.push(parte.trim()); } }
      } else if (bloco.type === 'tool_use') {
        const r = await executar(bloco.name, bloco.input || {}, ctx);
        if (bloco.name === 'enviar_arquivo' && ctx.notas.length) saida.push(ctx.notas.pop());
        resultados.push({ type: 'tool_result', tool_use_id: bloco.id, content: String(r).slice(0, 20000) });
      }
    }
    if (resp.stop_reason !== 'tool_use' || !resultados.length) break;
    messages.push({ role: 'user', content: resultados });
  }
  try { await sock.sendPresenceUpdate('paused', f.jid); } catch (e) { }
  if (saida.length) anotar(f.jid, 'assistant', saida.join('\n'));
  log('respondido', f.telefone || f.jid, saida.length, 'mensagens');
}

function estadoPublico() {
  const uso = lerJson(path.join(DADOS, 'uso.json'), {});
  const hoje = uso[agoraSP().toISOString().slice(0, 10)] || null;
  return {
    conectado, numero: meuNumero, qr: !!ultimoQR, whatsDesligado: !!estado.whatsDesligado, iniciando,
    assistente: !!estado.ativo, horario: `${HORA_INI}–${HORA_FIM}`, dentroDoHorario: dentroDoHorario(),
    regras: ARQS_REGRAS.map(f => ({ arquivo: f, ok: !!lerTexto(f) })), imoveis: pastasImoveis().length, bloqueados: lerBloqueados().size,
    usoHoje: hoje, modelo: MODELO
  };
}

async function iniciarWhatsApp() {
  if (estado.whatsDesligado || iniciando) return;
  iniciando = true;
  try {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH);
    let version;
    try { version = (await fetchLatestBaileysVersion()).version; } catch (e) { }
    const s = makeWASocket({ version, auth: state, logger: pino({ level: 'warn' }, pino.destination({ dest: path.join(DADOS, 'baileys.log'), sync: false })), browser: Browsers.ubuntu('Euro Ponte'), markOnlineOnConnect: false, syncFullHistory: true });
    sock = s;
    s.ev.on('creds.update', saveCreds);
    s.ev.on('connection.update', (u) => {
      if (sock !== s) return;
      if (u.qr) { ultimoQR = u.qr; log('QR novo disponível no painel'); emitir('estado', estadoPublico()); }
      if (u.qr || u.connection === 'open') falhasSeguidas = 0;
      if (u.connection === 'open' && !global.__sincronizou) { global.__sincronizou = true; setTimeout(() => { if (sock === s) s.resyncAppState(['critical_block', 'critical_unblock_low', 'regular_high', 'regular_low', 'regular'], true).then(() => log('etiquetas e contatos sincronizados', Object.keys(etq.labels).length, 'etiquetas')).catch(e => log('sincronizar', e.message)); }, 20e3); }
      if (u.connection === 'open') { conectadoDesde = Date.now(); conectado = true; ultimoQR = null; meuNumero = (s.user && s.user.id || '').split(':')[0]; log('WhatsApp conectado', meuNumero); emitir('estado', estadoPublico()); }
      if (u.connection === 'close') {
        conectado = false; ultimoQR = null;
        const code = u.lastDisconnect && u.lastDisconnect.error && u.lastDisconnect.error.output && u.lastDisconnect.error.output.statusCode;
        log('WhatsApp desconectado', code);
        if (code === DisconnectReason.loggedOut) { fs.rmSync(AUTH, { recursive: true, force: true }); fs.mkdirSync(AUTH, { recursive: true }); }
        sock = null;
        emitir('estado', estadoPublico());
        falhasSeguidas++;
        if (conectadoDesde && Date.now() - conectadoDesde > 30e3) { quedas.push(Date.now()); while (quedas.length && Date.now() - quedas[0] > 3600e3) quedas.shift(); if (quedas.length >= 4) pausarPorSeguranca('a conexão caiu ' + quedas.length + ' vezes na última hora'); }
        if (code === 403) pausarPorSeguranca('o WhatsApp recusou a conexão (403)');
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
        if (c && tel) {
          const NS = { atendimento: 'atendimento', novo: 'remarcar', visita: 'visita_marcada', negociacao: 'negociacao', fechado: 'fechado', pausado: 'pausado', perdido: 'perdido', desistiu: 'desistiu', corretor: 'corretor', construtor: 'construtor', pessoal: 'pessoal' };
          fs.appendFileSync(path.join(DADOS, 'eventos-crm.jsonl'), JSON.stringify({ rid: 'et' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), ts: new Date().toISOString(), telefone: formatoBR(tel), nome: (chats[a.chatId] || {}).nome || '', novoStatus: NS[c.cat], resultado: 'Etiqueta "' + (etq.labels[String(a.labelId)] || {}).nome + '" colocada no WhatsApp' }) + '\n');
          estado.crmStatus = estado.crmStatus || {}; estado.crmStatus[String(tel).replace(/\D/g, '').slice(-8)] = c.cat; salvarEstado();
          setTimeout(() => garantirEtiquetas().then(ids => definirEtiqueta(a.chatId, c.cat, ids)).catch(() => { }), 3000);   // tira a etiqueta de status antiga
        }
      }
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
  const B = require('@whiskeysockets/baileys');
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
  return { consultados: nums.length, ligados: achou, conversasComTelefone: Object.keys(chats).filter(j => chats[j].telefone || lidPn[j]).length };
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
async function claudeTexto(system, texto, maxTokens = 3000) {
  for (let t = 0; t < 3; t++) {
    const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, body: JSON.stringify({ model: MODELO, max_tokens: maxTokens, system, messages: [{ role: 'user', content: texto }] }) });
    if (r.ok) { const j = await r.json(); if (j.usage) registrarUso(j.usage); return (j.content || []).map(x => x.text || '').join(''); }
    if (![429, 500, 502, 503, 529].includes(r.status)) throw new Error('API ' + r.status + ' ' + (await r.text()).slice(0, 200));
    await new Promise(res => setTimeout(res, 5000 * (t + 1)));
  }
  throw new Error('API indisponível');
}
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
      if (etqs.some(n => /import/.test(n))) marca(jid, 'cliente', 'etiqueta Importante');
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
  { cat: 'corretor', nome: 'Corretores', re: /corret/, cor: 10 },
  { cat: 'construtor', nome: 'Construtores', re: /constru|capta/, cor: 12 },
  { cat: 'pessoal', nome: 'Pessoais', re: /pessoa|famil|amig/, cor: 15 }
];
async function garantirEtiquetas() {
  const ids = {};
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
function catEtiqueta(jid) {    // status do CRM manda; sem CRM, usa a organização (comprou -> fechado, cliente -> atendimento)
  const t = String((chats[jid] || {}).telefone || pnDe(jid).split('@')[0] || '').replace(/\D/g, '').slice(-8);
  const st = (estado.crmStatus || {})[t] || '';
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
      }
      if (u.pathname === '/api/ponte') {   // uma única porta para o CRM (via Make): ver, enviar, ligar/pausar, desconectar...
        const ac = String(b.acao || 'ver'), jid = b.jid;
        if (ac === 'enviar') {
          const texto = String(b.texto || '').trim();
          if (!jidValido(jid) || !texto) return json(res, { erro: 'conversa ou texto inválido' }, 400);
          const id = await enviarTexto(jid, texto, 'voce');
          if (!id) return json(res, { erro: 'WhatsApp desconectado' }, 409);
          anotar(jid, 'assistant', `(Djhonata escreveu) ${texto}`);
        } else if (ac === 'ia_conversa') {
          if (!jidValido(jid)) return json(res, { erro: 'conversa inválida' }, 400);
          if (b.on) delete estado.pausas[jid]; else { estado.pausas[jid] = Date.now() + 3650 * 864e5; filas.delete(jid); }
          salvarEstado(); emitir('chat', chatPublico(jid));
        } else if (ac === 'assistente') {
          estado.ativo = !!b.on; salvarEstado(); log('assistente', estado.ativo ? 'LIGADA' : 'PAUSADA', '(CRM)'); emitir('estado', estadoPublico());
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
        else if (ac === 'crm_status') { let m = {}; try { m = JSON.parse(b.texto || '{}'); } catch (e) { } atualizarStatusCrm(m).catch(e => log('crm_status', e.message)); return json(res, { ok: true }); }
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
        else if (ac === 'log') {
          let t = ''; try { t = fs.readFileSync(path.join(DADOS, 'ponte.log'), 'utf8'); } catch (e) { }
          return json(res, { log: t.split('\n').slice(-60).join('\n') });
        }
        const verArq = ac === 'ver' && b.texto === 'arquivados';
        const todos = Object.keys(chats).map(chatPublico);
        const out = { estado: estadoPublico(), classif, etiquetando, etiquetas: Object.entries(etq.labels).filter(([, l]) => !l.apagada).map(([id, l]) => ({ id, nome: l.nome, cor: l.cor })), totais: { ativos: todos.filter(c => !c.arquivado).length, arquivados: todos.filter(c => c.arquivado).length },
          chats: todos.filter(c => verArq ? c.arquivado : !c.arquivado).sort((a, b) => b.ult - a.ult).slice(0, 400) };
        if (b._resultado) out.resultado = b._resultado;
        if (jidValido(jid)) { out.chat = chatPublico(jid); out.msgs = lerEsp(jid).slice(-60).map(m => ({ id: m.id, autor: m.autor, tipo: m.tipo, texto: m.texto, ts: m.ts })); }
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
        estado.ativo = !!b.on; salvarEstado(); log('assistente', estado.ativo ? 'LIGADA' : 'PAUSADA', '(painel)');
        emitir('estado', estadoPublico()); return json(res, estadoPublico());
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
iniciarWhatsApp().catch(e => log('erro ao iniciar WhatsApp', e.message));
