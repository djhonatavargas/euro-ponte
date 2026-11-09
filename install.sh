#!/usr/bin/env bash
# Instala ou atualiza a Euro Ponte no servidor (Ubuntu). Uso:
#   curl -fsSL https://raw.githubusercontent.com/djhonatavargas/euro-ponte/main/install.sh | bash
set -euo pipefail
REPO="https://raw.githubusercontent.com/djhonatavargas/euro-ponte/main"
DIR=/opt/euro-ponte
echo "== Euro Ponte: instalando =="
export DEBIAN_FRONTEND=noninteractive
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  apt-get update -y
  apt-get install -y curl ca-certificates gnupg
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
mkdir -p "$DIR"
cd "$DIR"
for f in index.js painel.html package.json; do curl -fsSL "$REPO/$f?$(date +%s)" -o "$f"; done
npm install --omit=dev --no-audit --no-fund
if [ ! -f .env ]; then
  TOKEN=${EP_TOKEN:-$(tr -dc 'a-km-np-z2-9' </dev/urandom | head -c 10)}
  echo
  echo "Cole a chave da API da Anthropic (comeca com sk-ant-) e aperte Enter."
  echo "(Ela nao aparece na tela enquanto voce cola.)"
  read -rs KEY </dev/tty
  echo
  printf 'ANTHROPIC_API_KEY=%s\nTOKEN=%s\nMODELO=claude-haiku-5-5\nPORTA=8080\n' "$KEY" "$TOKEN" > .env
  chmod 600 .env
fi
cat > /etc/systemd/system/euro-ponte.service <<UNIT
[Unit]
Description=Euro Ponte (WhatsApp <-> Claude)
After=network-online.target
Wants=network-online.target
[Service]
WorkingDirectory=$DIR
ExecStart=$(command -v node) $DIR/index.js
Restart=always
RestartSec=5
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable euro-ponte >/dev/null 2>&1
systemctl restart euro-ponte
if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then ufw allow 8080/tcp >/dev/null; fi
TOKEN=$(grep '^TOKEN=' .env | cut -d= -f2)
IP=$(hostname -I | awk '{print $1}')
echo
echo "============================================================"
echo " PRONTO. Abra o painel do WhatsApp no navegador:"
echo "   http://$IP:8080/"
echo " Senha do painel (e do script do catalogo): $TOKEN"
echo "============================================================"
