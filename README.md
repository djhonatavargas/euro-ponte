# Euro Ponte

Ponte entre o WhatsApp (conectado por QR Code) e o Claude, para o atendimento da Euro Consultoria Imobiliária.

Instalar ou atualizar no servidor (Ubuntu):

    curl -fsSL https://raw.githubusercontent.com/djhonatavargas/euro-ponte/main/install.sh | bash

Regras, catálogo e chaves não ficam neste repositório: a chave fica no `.env` do servidor e o catálogo é enviado do computador pelo `enviar-catalogo.ps1`.

## Painel do WhatsApp (v2)

Abra `http://IP-DO-SERVIDOR:8080/` e entre com a senha (TOKEN do `.env`, ou `SENHA` se definida).
- Espelha todas as conversas (texto, foto, áudio, vídeo) em tempo real.
- Você responde pelo painel (texto e foto); a assistente lê o que você escreveu e continua junto.
- "Assistente pausada/ligada": liga ou desliga a IA mantendo o WhatsApp conectado.
- Chave por conversa: desliga a IA só para um cliente.
- Menu ⋮ → Desconectar (sai do WhatsApp) / Conectar (gera o QR Code).
