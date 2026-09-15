#!/usr/bin/env bash
# Espelha a pasta `desktop/` (o que está COMMITADO no repositório do Rawly) no
# repositório público `Nevus-Digital/rawly-desktop`, onde o GitHub Actions gera
# os instaladores de graça (inclusive no macOS) e os sobe para o R2.
#
# Uso, na raiz do repositório do Rawly, com a pasta `desktop/` já commitada:
#   desktop/scripts/espelhar.sh            # só espelha o código (não gera instalador)
#   desktop/scripts/espelhar.sh --tag      # espelha e cria a tag vX.Y.Z (a versão de
#                                          # desktop/package.json), que dispara a CI
#
# O espelho é o conteúdo de `git archive HEAD desktop`: arquivo ignorado (dist,
# out, node_modules) nunca vai. Mudança sem commit também não vai.
set -euo pipefail

ESPELHO="${ESPELHO:-https://github.com/Nevus-Digital/rawly-desktop.git}"
raiz="$(git rev-parse --show-toplevel)"
cd "$raiz"

if ! git diff --quiet HEAD -- desktop || [ -n "$(git ls-files --others --exclude-standard desktop)" ]; then
	echo "há mudança em desktop/ fora de commit: commite antes de espelhar" >&2
	exit 1
fi

versao="$(node -p "require('./desktop/package.json').version")"
origem="$(git rev-parse --short HEAD)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

git clone --quiet "$ESPELHO" "$tmp/espelho"
cd "$tmp/espelho"
git rm -rq --ignore-unmatch . >/dev/null
(cd "$raiz" && git archive HEAD desktop) | tar -x --strip-components=1 -C .
git add -A
if git diff --cached --quiet; then
	echo "espelho já está igual ao commit $origem"
else
	git commit -q -m "Espelho de desktop/ do Rawly em $origem (v$versao)"
	git push -q origin HEAD:main
	echo "espelho atualizado com o commit $origem"
fi

if [ "${1:-}" = "--tag" ]; then
	if git ls-remote --tags origin "refs/tags/v$versao" | grep -q .; then
		echo "a tag v$versao já existe no espelho: suba a versão em desktop/package.json" >&2
		exit 1
	fi
	git tag -a "v$versao" -m "Rawly desktop v$versao"
	git push -q origin "v$versao"
	echo "tag v$versao criada: a CI vai gerar os instaladores em https://github.com/Nevus-Digital/rawly-desktop/actions"
fi
