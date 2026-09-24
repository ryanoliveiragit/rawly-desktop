#!/usr/bin/env bash
# Publica o Rawly desktop "na mão", sem a CI: gera os instaladores do sistema
# em que está rodando e sobe tudo para o R2 (o site serve de lá).
#
#   cd desktop && ./scripts/publish-local.sh
#
# Pré-requisitos: Node 24, `doppler login` + `doppler setup` (projeto rawly)
# feitos uma vez na máquina, e, no Mac, o Xcode Command Line Tools
# (`xcode-select --install`). Sem certificado o build sai sem assinatura, de
# propósito: o Gatekeeper/SmartScreen avisam na primeira abertura.
set -euo pipefail
cd "$(dirname "$0")/.."

export CSC_IDENTITY_AUTO_DISCOVERY=false

npm ci
npm run compile
# O pacote leve: é ele que quem já tem o app instalado vai receber sozinho.
node scripts/make-bundle.mjs
case "$(uname -s)" in
	Darwin) node scripts/koffi-mac.mjs && npx electron-builder --mac --arm64 --x64 --publish never ;;
	Linux) npx electron-builder --linux --publish never ;;
	MINGW*|MSYS*|CYGWIN*) npx electron-builder --win --publish never ;;
	*) echo "Sistema não suportado: $(uname -s)"; exit 1 ;;
esac

# As chaves do R2 vêm do Doppler (config de produção), só neste comando.
doppler run -p rawly -c prd -- npm run upload:r2
