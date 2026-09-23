# Guia do projeto para agentes

Leia antes de qualquer tarefa. Vale para o agente do Rawly (`.github/rawly-agente.mjs`) e para qualquer outro agente de código que abra este repositório.

## O que é

O **Rawly Desktop**: a casca Electron do Rawly (Nevus Digital) para Mac, Linux e Windows. A janela abre o site de produção (`https://rawly-ten.vercel.app`), como o Discord faz; o produto em si (Central, Diretas, Projetos, Quadro, Agenda) mora no site, não aqui. Aqui fica só o que um app instalado faz e o navegador não.

Este repositório é o **espelho público** da pasta `desktop/` do monorepo do Rawly (público porque o GitHub Actions só é grátis assim). Não há segredo no código: não escreva chave, token nem URL assinada em arquivo nenhum.

## Como o código se divide

Processo principal (Node, acesso total à máquina) em `src/`, compilado pelo `tsc` para `out/`:

| Arquivo | Responsabilidade |
| --- | --- |
| `main.ts` | janela, instância única, navegação (só a origem do app carrega; o resto abre no navegador), página offline, `--screenshot` |
| `config.ts` | a URL do app: `--url=` vence `RAWLY_URL`, que vence a produção; flags de desenvolvimento |
| `preload.ts` | a ponte `window.rawlyDesktop` que o site enxerga (via `contextBridge`, site em sandbox, sem Node) |
| `terminal.ts` | o terminal dentro do app: PTY pelo `node-pty`, com `python3`/`script` como reserva; baixa o projeto conectado em `~/.rawly/projetos/<id>` |
| `repo.ts` | o projeto no disco: ler, salvar, status, ramos, commit e push (`repo:*` no IPC) |
| `workspace.ts` | o ambiente do projeto num container (Podman ou Docker) montado sobre a pasta do projeto (`ambiente:*` no IPC) |
| `screen-picker.ts`, `picker.*` | o seletor de telas e janelas do `getDisplayMedia` |
| `remote-control/` | controle remoto da tela: sessão e travas (`index.ts`), validação (`protocol.ts`), teclas (`keymap.ts`), coordenadas (`geometry.ts`), injeção nativa pelo `koffi` (`native-backend.ts`, `windows-input.ts`), portal do Wayland (`portal-backend.ts`), licença assinada do servidor (`lease.ts`) |
| `updater.ts`, `mac-updater.ts`, `mac-update-plan.ts` | atualização automática pelo próprio site; no Mac sem assinatura a troca do `.app` é feita à mão |
| `badge.ts`, `shortcuts.ts`, `permissions.ts`, `menu.ts`, `window-state.ts` | selo de não lidas, atalho global do microfone, permissões da origem, menu em pt-BR, tamanho e posição da janela |

Os `.html`/`.js` de páginas (offline, picker, overlays) são copiados para `out/` por `scripts/copy-static.mjs`. **Nunca** dê a um script de página o nome de um módulo `.ts`: a cópia sobrescreveria o que o `tsc` gerou (foi o que quebrou a 0.4.0).

## Regras que não se quebram

- **Segurança da ponte:** tudo que chega pelo IPC vem da tela e é `unknown`. Valide o formato e confira caminhos com a função `dentro()` (ou equivalente) antes de tocar no disco. Nada fora da pasta do projeto.
- **Controle remoto** só começa e só injeta com licença válida do servidor (`lease.ts`); não afrouxe essa trava nem as outras listadas no topo de `remote-control/index.ts`.
- **Módulos nativos** precisam estar em `asarUnpack` no `electron-builder.yml` (hoje `@koromix/**`, os binários do `koffi`, e `node-pty/**`), e o `node-pty` precisa de rebuild para a ABI do Electron (`npmRebuild: true`).
- **Nomes dos artefatos** em `electron-builder.yml` são fixos: o site aponta para eles.
- **Versão:** subir versão é `package.json` + tag `vX.Y.Z`; a tag dispara `.github/workflows/build.yml`, que publica no R2. Não suba versão nem mexa em publicação sem que a tarefa peça.

## Estilo

- TypeScript estrito, tabs, aspas simples, ponto e vírgula.
- Comentários e textos de interface em **português do Brasil**. Os comentários explicam o *porquê* (muitas vezes com a data e a frase de quem pediu); siga esse tom.
- Código novo fala a língua do arquivo em que está: identificadores em português nos módulos novos (`terminal.ts`, `repo.ts`, `workspace.ts`), em inglês nos antigos (`remote-control/`, `updater.ts`).
- Mude o mínimo necessário; não reformate arquivos inteiros nem troque dependências sem pedido.

## Verificar

```sh
npm ci
npm run typecheck   # tsc --noEmit
npm test            # compila e roda node --test sobre test/**/*.test.cjs (usa out/)
```

Os testes ficam em `test/` (`.cjs`, importando de `out/`): controle remoto (geometria, teclas, protocolo, licença, fila), plano de atualização do Mac e um teste de fumaça do `main`. Mudou lógica testável? Acrescente ou ajuste o teste ao lado.

## Rodar

```sh
RAWLY_URL=http://localhost:3000 npm run dev   # --dev libera o DevTools e desliga a atualização
```

Mais detalhes (instaladores, publicação, secrets, updater por sistema) estão no `README.md`.
