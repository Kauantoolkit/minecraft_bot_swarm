# Minecraft Bot Swarm

Controlador de múltiplos bots headless para Minecraft. Cada bot roda em sua própria thread e obedece a comandos individuais, por grupo ou para o enxame inteiro — além de operar de forma autônoma através de um sistema de papéis.

Construído sobre Mineflayer, em TypeScript, com separação em camadas (domínio / aplicação / infraestrutura).

---

## Por que é interessante

**Uma thread por bot.** Cada bot vive em um `Worker` isolado, se comunicando com o processo principal por mensagens tipadas (`src/ipc/messages.ts`). Um bot travado ou desconectado não bloqueia os outros — problema comum quando se roda dezenas de bots no mesmo event loop.

**Orquestrador autônomo.** Além do controle manual, o `Orchestrator` mantém estado global da colônia e distribui papéis (`RoleSystem`) entre os bots disponíveis: quem minera, quem constrói, quem guarda, quem coleta.

**Domínio isolado da biblioteca.** A camada de domínio não conhece o Mineflayer. O acesso passa pela interface `IBotAdapter`, com implementação em `MineflayerAdapter`. Trocar a biblioteca de controle não exigiria tocar em regra de negócio.

---

## Arquitetura

```
domain/
  entities/Bot.ts                  entidade com estado e ciclo de vida
  repositories/IBotRepository.ts   contrato de persistência
  services/ISwarmService.ts        contrato de operações do enxame
  value-objects/                   BotState, PlayerRelationship, ProxyConfig

application/
  BotManager.ts                    criação, conexão e reconexão dos bots
  SwarmController.ts               operações sobre um, um grupo ou todos
  CommandListener.ts               interpreta comandos vindos do jogo
  BotGroupStore.ts                 agrupamento nomeado de bots
  SwarmIntel.ts                    informação compartilhada entre bots

orchestrator/
  Orchestrator.ts                  laço autônomo da colônia
  RoleSystem.ts                    atribuição dinâmica de papéis
  GlobalState.ts                   estado compartilhado

worker/
  BotWorker.ts                     entrypoint da thread de cada bot
  WorkerCommandAdapter.ts          adapta comandos para mensagens IPC

infrastructure/
  mineflayer/behaviors/            13 comportamentos (ver abaixo)
  mineflayer/physics/PhysicsPatch  ajustes de física
  network/                         provider de conexão e carga de proxies SOCKS
  schematic/                       carregamento de schematic + fila de construção
  mining/QuarryQueue.ts            fila de blocos para escavação
  storage/StorageCache.ts          cache do conteúdo de baús
  web/WebServer.ts                 painel de monitoramento
  LogBuffer.ts                     buffer de logs para o painel
```

### Comportamentos

`Movement` · `Combat` · `Defend` · `Guard` · `Avoid` · `Mining` · `Farm` · `Build` · `Crafting` · `Inventory` · `Storage` · `Explore`

Construção lê arquivos schematic (`prismarine-nbt`) e enfileira os blocos, com múltiplas passadas para resolver dependências de colocação (até 5 passadas, com intervalo entre elas).

---

## Stack

| Item | Tecnologia |
|------|------------|
| Linguagem | TypeScript |
| Controle dos bots | Mineflayer + mineflayer-pathfinder + baritone |
| Concorrência | Worker Threads (nativo do Node) |
| Formato de build | prismarine-nbt (schematics) |
| Rede | socks-proxy-agent (modo proxy opcional) |
| Painel | servidor HTTP próprio |

---

## Rodando

```bash
npm install
cp .env.example .env    # configure host, porta e quantidade de bots
npm run dev             # ts-node
# ou
npm run build && npm start
```

### Configuração (`.env`)

| Variável | Padrão | Descrição |
|----------|--------|-----------|
| `MC_HOST` | `localhost` | Host do servidor |
| `MC_PORT` | `25565` | Porta |
| `MC_VERSION` | `auto` | Versão (auto negocia com o servidor) |
| `BOT_COUNT` | `10` | Quantidade de bots |
| `BOT_USERNAME_PREFIX` | `SwarmBot` | Prefixo dos nomes |
| `BOT_SPAWN_DELAY_MS` | `15` | Intervalo entre conexões |
| `CONNECTION_MODE` | `direct` | `direct` ou `proxy` |
| `PROXY_FILE` | `proxies.txt` | Lista de proxies SOCKS |
| `MASTER_USERNAME` | `Herobrine` | Jogador autorizado a comandar |
| `WEB_PORT` | `3000` | Porta do painel |

Comandos são enviados pelo chat do jogo pelo usuário definido em `MASTER_USERNAME`, e podem ter como alvo um bot, um grupo nomeado ou o enxame inteiro.

---

## Uso

Projeto pessoal para servidor próprio. Feito para explorar concorrência com worker threads e coordenação de agentes autônomos — o Minecraft é o ambiente de teste, não o objetivo.
