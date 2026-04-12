# Minecraft Bot Swarm

Sistema autônomo de colônia de bots Minecraft. Cada bot roda em uma **thread Node.js separada** e se comunica com o processo principal via IPC tipado.

---

## Índice

1. [Estrutura de Diretórios](#estrutura-de-diretórios)
2. [Arquitetura Geral](#arquitetura-geral)
3. [Fluxos Principais](#fluxos-principais)
   - [Startup](#1-startup)
   - [Ciclo de Vida do Bot](#2-ciclo-de-vida-do-bot)
   - [Atribuição de Tarefas (Orchestrator)](#3-atribuição-de-tarefas-orchestrator)
   - [Comandos Manuais do Operador](#4-comandos-manuais-do-operador)
   - [IPC — Protocolo de Mensagens](#5-ipc--protocolo-de-mensagens)
4. [Componentes Chave](#componentes-chave)
5. [Roles e Fases da Colônia](#roles-e-fases-da-colônia)
6. [Problemas Conhecidos](#problemas-conhecidos)

---

## Estrutura de Diretórios

```
src/
├── index.ts                        # Entry point — bootstrap do processo principal
│
├── config.ts                       # Configurações globais (host, port, bot count, etc.)
│
├── domain/                         # Entidades e interfaces puras (sem dependências externas)
│   ├── entities/Bot.ts             # Entidade Bot (id, username, proxy, handle mineflayer)
│   ├── repositories/IBotRepository.ts
│   ├── services/ISwarmService.ts
│   └── value-objects/              # BotState, PlayerRelationship, ProxyConfig
│
├── application/                    # Casos de uso e orquestração de alto nível
│   ├── BotManager.ts               # Spawna bots sequencialmente, gerencia usernames/proxies
│   ├── SwarmController.ts          # Roteia comandos do operador para workers
│   ├── CommandListener.ts          # Escuta chat in-game e console REPL
│   ├── BotGroupStore.ts            # Agrupa bots por nome (ex: "grupo1")
│   └── SwarmIntel.ts               # Inteligência compartilhada (jogadores hostis, etc.)
│
├── orchestrator/                   # Cérebro autônomo — roda na main thread
│   ├── Orchestrator.ts             # Loop de tick (2s) — seleciona e despacha tarefas
│   ├── GlobalState.ts              # Estado compartilhado da colônia (BotRecord, fase, storage)
│   └── RoleSystem.ts               # Distribui roles (miner, hauler, builder, farmer, soldier)
│
├── tasks/
│   └── TaskRunner.ts               # Executor de tarefas por worker — recebe TaskDescriptor e executa
│
├── worker/
│   ├── BotWorker.ts                # Entry point de cada worker thread — despacha mensagens IPC
│   └── WorkerCommandAdapter.ts     # Proxy da main thread para workers (envia IPC, emite eventos)
│
├── ipc/
│   └── messages.ts                 # Tipos tipados de todas as mensagens Main↔Worker
│
└── infrastructure/
    ├── mineflayer/
    │   ├── MineflayerAdapter.ts    # Wrapper do mineflayer (spawn, move, mine, craft, etc.)
    │   ├── BotMeta.ts              # Metadata local do bot dentro do worker
    │   ├── behaviors/              # Comportamentos isolados (Combat, Farm, Guard, Storage, etc.)
    │   ├── physics/PhysicsPatch.ts
    │   └── utils.ts
    ├── mining/QuarryQueue.ts       # Fila de blocos para mineração em área
    ├── schematic/                  # Carregamento de schematics de construção
    ├── storage/StorageCache.ts     # Registra posições de baús e resolve o mais próximo
    ├── network/                    # NetworkProvider, ProxyLoader
    ├── web/WebServer.ts            # Dashboard web para monitoramento
    └── LogBuffer.ts                # Centraliza logs de todos os workers
```

---

## Arquitetura Geral

```
┌─────────────────────────────── Main Thread ──────────────────────────────────┐
│                                                                               │
│  index.ts                                                                     │
│    ├── BotManager          — spawna N workers                                 │
│    ├── SwarmController     — roteia comandos do operador                      │
│    ├── CommandListener     — REPL + chat in-game                              │
│    ├── Orchestrator        — tick a cada 2s, seleciona tarefas                │
│    ├── StorageCache        — registra posições de baús                        │
│    └── WebServer           — dashboard HTTP                                   │
│                                                                               │
│  WorkerCommandAdapter      — ponte: main thread → worker threads (IPC)        │
│                                                                               │
└───────────────────────────────────────────────────────────────────────────────┘
         │ postMessage (typed IPC)          ▲ postMessage (typed IPC)
         ▼                                  │
┌────────────────────┐   ┌────────────────────┐   ┌────────────────────┐
│   Worker Bot #1    │   │   Worker Bot #2     │   │   Worker Bot #N    │
│                    │   │                    │   │                    │
│  BotWorker.ts      │   │  BotWorker.ts      │   │  BotWorker.ts      │
│  MineflayerAdapter │   │  MineflayerAdapter │   │  MineflayerAdapter │
│  TaskRunner        │   │  TaskRunner        │   │  TaskRunner        │
│  mineflayer bot    │   │  mineflayer bot    │   │  mineflayer bot    │
└────────────────────┘   └────────────────────┘   └────────────────────┘
```

**Princípio:** A main thread nunca bloqueia. Toda execução de jogo acontece dentro do worker. Workers são completamente isolados entre si (sem estado compartilhado).

---

## Fluxos Principais

### 1. Startup

```
index.ts
  │
  ├── Cria infraestrutura (Repository, StorageCache, WorkerCommandAdapter)
  ├── Cria BotManager, SwarmController, CommandListener, Orchestrator, WebServer
  │
  ├── BotManager.spawnSwarm(N)
  │     └── Para cada bot:
  │           └── new Worker('BotWorker.ts', { workerData: { botId, username, proxy, server } })
  │                 └── BotWorker.boot() → adapter.spawn() → mineflayer.createBot()
  │                       └── Envia READY ao main thread quando conectado
  │
  ├── adapter.broadcastSwarmUsernames(usernames)   → informa cada worker da lista de bots
  ├── cmdListener.attachChatListeners()
  └── orchestrator.start()                         → inicia tick loop (2s)
```

### 2. Ciclo de Vida do Bot

```
Worker thread:
  boot()
    └── adapter.spawn()         → conecta ao servidor Minecraft
          └── READY enviado ao main thread

  setInterval 1s:
    └── send(STATE_UPDATE)      → snapshot de health, food, pos, inventário, taskStatus

  port.on('message'):
    └── Despacha CMD_* ou ASSIGN_TASK conforme tipo da mensagem
```

### 3. Atribuição de Tarefas (Orchestrator)

```
Orchestrator.tick() — a cada 2s:
  │
  ├── Filtra bots online (repository.findAll())
  ├── assignRoles() → distribui roles baseado em quantidade de bots online
  │
  └── Para cada bot idle e não pausado:
        ├── selectTask(rec)     → decide a tarefa baseada em role + fase + inventário
        └── adapter.assignTask() → envia ASSIGN_TASK ao worker
              └── Worker:
                    └── TaskRunner.run(descriptor)
                          └── executa via MineflayerAdapter
                                └── Conclusão: TASK_COMPLETE ou TASK_FAILED

Orchestrator recebe TASK_COMPLETE/TASK_FAILED via adapter events:
  ├── TASK_COMPLETE → rec.taskStatus = 'idle', rec.failCount = 0
  └── TASK_FAILED   → rec.taskStatus = 'idle', rec.failCount++
        (se failCount >= 3: bot entra em idle 10s como cooldown)
```

**Seleção de tarefas por role:**

| Role     | Lógica                                                             |
|----------|--------------------------------------------------------------------|
| miner    | Se inventário cheio → deposit. Senão mine (madeira no bootstrap)   |
| hauler   | Sempre deposit no baú mais próximo                                  |
| builder  | Se sem storage → build_storage. Senão collect_wood ou deposit      |
| farmer   | farm() em loop na área central                                      |
| soldier  | guard() no centro da base                                           |

### 4. Comandos Manuais do Operador

```
Operador (REPL ou chat in-game ou WebServer)
  │
  └── CommandListener.dispatch(cmd)
        └── SwarmController.execute(cmd)
              └── WorkerCommandAdapter.send(botId, CMD_*)
                    │
                    ├── Emite evento 'cmd_override' → Orchestrator.pauseBot(botId, 30s)
                    │     (evita que o Orchestrator sobrescreva o comando manual)
                    │
                    └── Worker recebe CMD_* e executa diretamente via MineflayerAdapter
                          (sem passar pelo TaskRunner)
```

**Importante:** Comandos manuais **não** usam o TaskRunner — são fire-and-forget direto no adapter. Isso significa que não há cancelamento automático da tarefa autônoma em andamento. O bot pode estar no meio de um `TaskRunner.run()` enquanto recebe um CMD_*.

### 5. IPC — Protocolo de Mensagens

Todas as mensagens são tipadas em `src/ipc/messages.ts`.

**Main → Worker:**

| Tipo              | Descrição                                      |
|-------------------|------------------------------------------------|
| `ASSIGN_TASK`     | Orchestrator atribui tarefa serializada        |
| `CANCEL_TASK`     | Cancela tarefa em andamento no TaskRunner      |
| `CMD_MOVE_TO`     | Move para coordenada (async, retorna resultado)|
| `CMD_COLLECT`     | Coleta N blocos (async)                        |
| `CMD_DEPOSIT_ALL` | Deposita inventário no baú (async)             |
| `CMD_DEFEND`      | Inicia defend behavior (fire-and-forget)       |
| `CMD_FOLLOW`      | Segue jogador (fire-and-forget)                |
| `CMD_STOP`        | Para tudo + cancela TaskRunner                 |
| *(outros CMD_*)*  | Ver `messages.ts`                              |

**Worker → Main:**

| Tipo            | Descrição                                        |
|-----------------|--------------------------------------------------|
| `READY`         | Bot conectado e pronto                           |
| `STATE_UPDATE`  | Snapshot de estado (1 Hz)                        |
| `TASK_COMPLETE` | Tarefa concluída com sucesso                     |
| `TASK_FAILED`   | Tarefa falhou (com erro e flag retryable)        |
| `CMD_RESULT`    | Resultado de comando async (correlacionado por reqId) |
| `CHESTS_PLACED` | Baús construídos — main thread registra no StorageCache |
| `LOG`           | Log centralizado com prefixo do bot             |
| `DISCONNECTED`  | Bot desconectou — Orchestrator pausa 60s         |

---

## Componentes Chave

### TaskRunner (`src/tasks/TaskRunner.ts`)

Executa `TaskDescriptor` dentro do worker. Suporta cancelamento via `cancel()` que:
1. Seta flag `_cancelled`
2. Chama `adapter.stop()` (para pathfinding)
3. Resolve o `cancellationToken` (rejeita promises em espera)

**Tarefas disponíveis:**
- `idle` — aguarda N ms
- `mine` — minera bloco específico
- `collect_wood` — tenta todos os tipos de madeira em ordem
- `deposit` — deposita inventário no baú
- `guard` — guarda ponto até cancelamento
- `farm` — ciclo de agricultura
- `explore` — explora em direção definida
- `craft` — crafta item
- `build_storage` — pipeline completo: madeira → planks → chests → place → register

### StorageCache (`src/infrastructure/storage/StorageCache.ts`)

Mantém mapa de baús registrados. `getNearest(Vec3)` retorna o baú mais próximo do bot. Alimentado pelo evento `chests_placed` que vem dos workers.

### WorkerCommandAdapter (`src/worker/WorkerCommandAdapter.ts`)

Proxy da main thread. Cria e gerencia os Worker threads. Emite eventos internos (`state_update`, `task_complete`, `task_failed`, `disconnected`, `cmd_override`) que o Orchestrator consome.

---

## Roles e Fases da Colônia

### Roles (distribuídos por `RoleSystem.ts`)

| Role     | Qtd bots (relativa) | Função principal                     |
|----------|---------------------|--------------------------------------|
| builder  | 1                   | Constrói base e storage inicial      |
| miner    | maioria             | Coleta recursos                      |
| hauler   | 1                   | Transporta itens para o baú          |
| farmer   | 1 (se > 4 bots)     | Agricultura                          |
| soldier  | 1 (se > 3 bots)     | Defesa do perímetro                  |

### Fases da Colônia (`ColonyPhase` em `GlobalState.ts`)

| Fase                | Descrição                                  | Próxima fase       |
|---------------------|--------------------------------------------|--------------------|
| `bootstrap`         | Sem ferramentas — coletar madeira primeiro | `resource_gathering`|
| `resource_gathering`| Ferramentas de pedra/ferro, minerar        | `base_building`    |
| `base_building`     | Materiais suficientes — construir base     | `expansion`        |
| `expansion`         | Expandir farm, minerar mais fundo          | `combat`           |
| `combat`            | Ameaça ativa — prioridade de defesa        | —                  |

**A transição de fase não é automática** — deve ser disparada manualmente ou por lógica futura no Orchestrator.

---

## Problemas Conhecidos

Registrados em `problems.md`. Agrupados por categoria:

### Inicialização / Setup
- [ ] Builder não define o primeiro baú automaticamente após spawn
- [ ] Bots sem `defend` ativo desde o início ficam vulneráveis a mobs
- [ ] Precisa escolher coordenada base e colocar storage no chão dessa coord

### Storage
- [ ] Coordenadas de baús chegam com números quebrados — bot diz que é "ar" em coord válida
- [ ] Hauler entra em loop infinito depositando no baú principal
- [ ] Storage geral parece não funcionar corretamente

### Pathfinding / Movimento
- [ ] Ao fazer bridge sobre rios o bot pode bugar
- [ ] Bot não usa blocos de dirt/stone para escalar e alcançar alturas — fica preso
- [ ] Com scaffolding ativado, bots dependem demais disso e criam caminhos desnecessários de terra
- [ ] Bot "builder" entrou em loop suicida se movendo para ponto na água — logs insuficientes para diagnóstico

### Coleta de Recursos
- [ ] Só coleta oak — precisa tentar qualquer tipo de madeira *(já corrigido no TaskRunner, verificar se chegou ao adapter)*
- [ ] Não coleta pedra (necessária para ferramentas e construção)
- [ ] Bots não coletam comida nem levam para o baú

### Combate
- [ ] Bots vão longe demais caçando mobs — chegam a se afogar
- [ ] Sem hunting/food loop implementado

### Progressão da Colônia (não implementado)
- [ ] Crafting de ferramentas de pedra (madeira + pedra)
- [ ] Fornalhas para fundir ferro e cozinhar carne
- [ ] Ferramentas de ferro → depois diamante
- [ ] Perímetro de defesa: vala 2-3 blocos + alçapões + parede com porta
- [ ] Bridges estilo parkour sobre água (mobs não conseguem atravessar)
- [ ] Expansão de storage (mais baús conforme colônia cresce)
- [ ] Farms de comida sustentáveis

### Problema Estrutural Principal (multitasking)
Quando um bot está executando uma tarefa autônoma via `TaskRunner` e recebe um `CMD_*` manual, **o CMD é executado diretamente no adapter sem cancelar o TaskRunner**. O resultado é comportamento indefinido — dois fluxos concorrentes no mesmo bot. Ver próxima seção para decisões arquiteturais necessárias.

---

## Decisões Arquiteturais Pendentes

Antes de corrigir o problema de multitasking, as seguintes decisões precisam ser tomadas:

1. **Modelo de interrupção:** quando um evento externo (mob, comando manual) interrompe uma tarefa, o que acontece com ela? Pausar e retomar / cancelar e perder / ou depende da prioridade?

pausar e retomar, estilo pilha

2. **Onde vive a fila de tarefas:** dentro de cada worker (mais isolado) ou no Orchestrator (mais controle)?

como os bots podem ser interrompidos singularmente a pilha deve estar em cada worker, eu gostaria de fazer  por grupos, contudo, essa questão de cada um deles operar separadamente impede isso

3. **Escopo mínimo da mudança:** só corrigir interrupção ou introduzir máquina de estados explícita?

maquina de estados, e preciso de uma ui mais descritiva sobre o funcionamento do sistema no geral
