# Rawly para Mac, Linux e Windows

Uma casca Electron que abre o site de produção (`https://rawly-ten.vercel.app`), como o Discord. O app inteiro continua no site e nos deploys da Vercel; aqui ficam só as coisas que um app instalado faz e o navegador não:

- janela própria, com tamanho e posição lembrados, e uma instância só (abrir de novo foca a janela);
- seletor de telas e janelas para "Compartilhar tela" e "Gravar tela" (`getDisplayMedia` no Electron não tem seletor próprio); no Mac 15+ usa o seletor do sistema, no Windows dá para levar o áudio do sistema junto;
- selo de não lidas no ícone da dock (Mac), do lançador (Linux) e da barra de tarefas (Windows, com a janela piscando fora de foco);
- avisos nativos com o nome e o ícone certos no Windows;
- página "Sem conexão com o Rawly" que volta sozinha quando a rede volta;
- atualização automática pelo próprio site (`/downloads/desktop/`).

Segurança: só a origem do app carrega dentro da janela; qualquer link para outro domínio abre no navegador do sistema. O site roda no sandbox, sem Node, e só enxerga a ponte `window.rawlyDesktop`.

## A ponte `window.rawlyDesktop`

O preload expõe ao site, via `contextBridge`:

| Campo | O que é |
| --- | --- |
| `platform` | `'darwin'`, `'win32'` ou `'linux'` |
| `version` | a versão da casca (`desktop/package.json`) |
| `setBadge(count)` | o número de não lidas para o ícone; `0` limpa. Devolve uma Promise |

O user agent leva o sufixo `RawlyDesktop/<versão>`, se o servidor precisar saber.

## Rodar local

Dentro de `desktop/` (pacote npm próprio, separado da raiz):

```sh
cd desktop
npm install
RAWLY_URL=http://localhost:3000 npm run dev
```

`--dev` (o `npm run dev` já passa) libera as ferramentas de desenvolvimento no menu Exibir e desliga a atualização automática. Também vale `--url=http://localhost:3000` no lugar da variável. Em desenvolvimento os dados (cookies, estado da janela) ficam numa pasta separada da do app instalado (`Rawly-dev`).

Para depurar ou automatizar, o Electron aceita as flags do Chromium: `npx electron . --dev --remote-debugging-port=9333` e, do outro lado, `chromium.connectOverCDP('http://localhost:9333')` no Playwright. `--screenshot=<caminho>` captura a janela 3s depois de carregar e sai (com `--keep` fica aberta).

## Ícones

`npm run icons` desenha `build/icon.png` (1024×1024, o pulso da marca sobre grafite) e os selos `build/badge/*.png` com o PIL (Python 3), e deriva `build/icon.icns` e `build/icon.ico` com o `png2icons`. Os três arquivos ficam versionados; só rode de novo se mudar o desenho.

## Gerar um instalador na sua máquina

No Linux saem três pacotes: o **AppImage** (qualquer distribuição) precisa de permissão de execução antes de abrir — `chmod +x Rawly-linux-x86_64.AppImage` ou, no gerenciador de arquivos, Propriedades › "Executável como programa"; sem isso o sistema abre o arquivo em outro programa (no Fedora, o "Discos"). O **.rpm** (Fedora, openSUSE) e o **.deb** (Ubuntu, Debian) instalam com dois cliques e entram no menu de aplicativos, sem `chmod`.

```sh
npm run dist:linux   # AppImage, deb e rpm em desktop/dist/
npm run dist:mac     # dmg e zip (arm64 e x64); precisa de um Mac
npm run dist:win     # instalador NSIS x64; precisa de Windows (ou wine)
```

O `.deb` é montado pelo `fpm` que o electron-builder baixa, cujo Ruby precisa da `libcrypt.so.1`; no Fedora ela vem do pacote `libxcrypt-compat` (um link para a `libcrypt.so.2` não serve: falta o símbolo `GLIBC_2.2.5`). Sem ela só o AppImage sai. O `.deb` e o instalador do Windows saem de um contêiner Ubuntu com Wine, sem instalar nada na máquina:

```sh
podman run --rm -v "$PWD:/project:Z" -v rawly-desktop-nm:/project/node_modules -w /project \
  docker.io/electronuserland/builder:wine \
  bash -lc "npm ci && npm run compile && npx electron-builder --linux deb rpm --win nsis --x64 --publish never"
```

(`docker` no lugar de `podman` funciona igual; o volume `rawly-desktop-nm` guarda o `node_modules` de dentro do contêiner, separado do da máquina. Para o rpm a imagem precisa do `rpmbuild`: `apt-get install -y rpm` dentro dela, se faltar.)

Atenção ao `latest-linux.yml`: o electron-builder o reescreve a cada build de Linux só com os alvos daquele build. Se o AppImage sair de um build e o deb/rpm de outro, o yml final precisa listar o AppImage como primeiro arquivo (`path`/`sha512` do topo apontando para ele) e os outros abaixo — é o AppImage que o atualizador baixa. Confira antes de subir.

Nomes dos artefatos (fixos, o site aponta para eles): `Rawly-mac-arm64.dmg`, `Rawly-mac-x64.dmg` (e os `.zip` de cada arquitetura), `Rawly-Setup-x64.exe`, `Rawly-linux-x86_64.AppImage`, `Rawly-linux-amd64.deb`, mais `latest-mac.yml`, `latest.yml` (Windows) e `latest-linux.yml` do atualizador e os `.blockmap` (baixa só o que mudou entre versões).

## Publicar uma versão

O download é direto do site, sem GitHub: os arquivos ficam no bucket do R2 (o mesmo dos uploads), no prefixo `downloads/desktop/`, e o site os serve em `https://rawly-ten.vercel.app/downloads/desktop/<nome>` redirecionando para uma URL assinada do R2. O atualizador do app lê o `latest*.yml` de lá e segue o mesmo redirecionamento.

1. `cd desktop && npm version patch` (ou `minor`/`major`): sobe a versão em `desktop/package.json`.
2. Commit, e a tag `desktop-vX.Y.Z` com a mesma versão: `git tag desktop-v0.1.1 && git push origin main desktop-v0.1.1`.
3. O workflow `Desktop` (`.github/workflows/desktop.yml`) empacota nos três sistemas e anexa os instaladores ao próprio workflow.
4. Com os secrets `R2_*`, cada sistema sobe os seus instaladores e o seu `latest*.yml` para `downloads/desktop/` no bucket (os instaladores primeiro, o yml por último, para ninguém ver a versão nova antes dos arquivos). Cada publicação sobrescreve a anterior. Daí em diante:
   - os links diretos funcionam: `https://rawly-ten.vercel.app/downloads/desktop/Rawly-Setup-x64.exe` (e os outros nomes acima);
   - o app instalado encontra a versão nova sozinho (checa ao abrir e a cada 6 h, baixa em silêncio e pergunta se reinicia).

Rodando o workflow à mão, marque "Subir para o R2" para publicar; sem marcar, só gera os artefatos.

### Publicar na mão (sem a CI)

Quando a CI não roda (conta do GitHub sem minutos, por exemplo), o mesmo resultado sai de uma máquina sua. Cada sistema gera o próprio instalador; o do Mac só sai num Mac.

Pré-requisitos, uma vez por máquina: Node 24; no Mac, o Xcode Command Line Tools (`xcode-select --install`); o Doppler CLI com `doppler login` e, dentro do repositório, `doppler setup` (projeto `rawly`, config `dev`; a config `prd` é usada só no comando de envio, nunca fica como padrão).

```sh
cd desktop && ./scripts/publish-local.sh
```

O script roda `npm ci`, compila, empacota o sistema atual sem assinatura (`CSC_IDENTITY_AUTO_DISCOVERY=false`) e chama `doppler run -p rawly -c prd -- npm run upload:r2`, que sobe para o R2 só o que está em `dist/` e na lista de nomes que o site serve (`scripts/upload-r2.mjs`; `--dry-run` mostra o que subiria, `--only=a,b` limita). No Mac isso publica `Rawly-mac-arm64.dmg`, `Rawly-mac-x64.dmg`, os `.zip`, os `.blockmap` e o `latest-mac.yml`.

Depois, confira:

- `https://rawly-ten.vercel.app/api/downloads/desktop` lista a versão e os arquivos com tamanho (cache de 5 min, então pode demorar para refletir);
- em `https://rawly-ten.vercel.app/baixar` o botão do sistema publicado sai de "Em breve" e mostra o tamanho;
- `curl -sI https://rawly-ten.vercel.app/downloads/desktop/latest-mac.yml` responde 302 para o R2.

### Secrets do workflow (no repositório do código)

| Secret | Para quê | Sem ele |
| --- | --- | --- |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` | os mesmos nomes do Doppler; o token precisa de leitura e escrita no bucket. A CI usa a API S3 do R2 (`https://<conta>.r2.cloudflarestorage.com`) | os instaladores ficam só nos artefatos do workflow, o site não tem o que servir e o app não se atualiza |
| `CSC_LINK`, `CSC_KEY_PASSWORD` | certificado Developer ID Application da Apple em base64 (`.p12`) e a senha dele | o app do Mac sai sem assinatura: o Gatekeeper avisa e a pessoa precisa abrir com o botão direito → Abrir. A atualização automática no Mac só funciona com o app assinado |
| `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` | notarização do app do Mac (só com o certificado acima) | sem notarização o macOS recente bloqueia o app com "não foi possível verificar" até liberar em Ajustes › Privacidade e Segurança |
| `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD` | certificado de assinatura de código do Windows em base64 (`.pfx`) e a senha | o SmartScreen avisa "editor desconhecido" até o instalador ganhar reputação |

Os certificados custam: Apple Developer Program (anual) e um certificado de code signing para Windows (OV ou EV). Sem eles tudo funciona, só com os avisos acima na instalação. O Linux não tem assinatura.

## Estrutura

```
desktop/
  src/main.ts            janela, instância única, navegação, offline, screenshot
  src/preload.ts         window.rawlyDesktop (sandbox)
  src/screen-picker.ts   setDisplayMediaRequestHandler + a janela do seletor
  src/picker.html/.js    o seletor de telas e janelas
  src/picker-preload.ts  ponte do seletor
  src/badge.ts           selo de não lidas por plataforma
  src/updater.ts         electron-updater (provider generic, o site)
  src/permissions.ts     o que a origem do app pode pedir
  src/menu.ts            menu em pt-BR
  src/window-state.ts    tamanho e posição lembrados
  src/offline.html/.js   página sem conexão
  build/                 ícones, selos e entitlements do Mac
  scripts/               copy-static, make-icon.py, make-icons.mjs
  electron-builder.yml   alvos, nomes dos artefatos, assinatura, publish
```

O `tsconfig.json`, o `eslint.config.mjs` e o `npm run build` da raiz ignoram esta pasta.
