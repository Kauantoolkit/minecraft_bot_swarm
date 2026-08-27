# Guia de Desenvolvimento — Minecraft Bot Swarm

Esse guia te ensina a desenvolver nesse projeto sem ajuda externa.
Leia do início ao fim uma vez; depois use como referência.

---

## 1. Visão Geral da Arquitetura

O projeto é um enxame de bots Minecraft headless escrito em **Node.js + TypeScript**.
Cada bot roda em sua própria **Worker thread** (módulo `worker_threads` do Node).

```
┌─────────────────────────── Main Thread ─────────────────────────────┐
│  index.ts → BotManager, SwarmController, CommandListener            │
│             Orchestrator (tick a cada 2 s)                           │
│             WebServer (HTTP debug UI)                                │
│             WorkerCommandAdapter (faz proxy de comandos p/ workers)  │
└──────────────┬──────────────────────────────────────────────────────┘
               │ postMessage / parentPort (IPC tipado)
  ┌────────────▼───────┐  ┌────────────────────┐  ┌───────────────────┐
  │  Worker: BotWorker │  │  Worker: BotWorker │  │  Worker: BotWorker│
  │  MineflayerAdapter │  │  MineflayerAdapter │  │  MineflayerAdapter│
  │  TaskRunner        │  │  TaskRunner        │  │  TaskRunner       │
  └────────────────────┘  └────────────────────┘  └───────────────────┘
```

### Camadas do projeto

| Pasta | O que faz |
|---|---|
| `src/domain/` | Entidades puras, sem dependência de biblioteca (Bot, BotState, ProxyConfig) |
| `src/infrastructure/` | Implementações concretas: mineflayer, rede, storage, web |
| `src/application/` | Casos de uso: BotManager, SwarmController, CommandListener |
| `src/orchestrator/` | Cérebro autônomo: roles, fases da colônia, loop de tarefas |
| `src/worker/` | Entry-point do Worker thread e proxy de comandos |
| `src/tasks/` | Executor de tarefas dentro de cada Worker |
| `src/ipc/` | Tipos compartilhados entre main thread e workers |

---

## 2. Fluxo de Inicialização (`src/index.ts`)

```
main()
  └─ InMemoryBotRepository         (guarda domínio Bot em memória)
  └─ WorkerCommandAdapter          (proxy: main → workers via postMessage)
  └─ BotManager.spawnSwarm(N)      (cria N Workers, cada um conecta ao server)
  └─ CommandListener.attachChatListeners()
  └─ Orchestrator.start()          (loop de 2 s começa)
  └─ CommandListener.startConsole() (REPL no terminal)
  └─ WebServer.start()
```

Quando `spawnSwarm(N)` termina, cada Worker já enviou `{ type: 'READY' }` ao main.

---

## 3. O Protocolo IPC (`src/ipc/messages.ts`)

Tudo que cruza a fronteira main ↔ worker é tipado aqui. **Não use `any`.**

### Main → Worker (`MainToWorkerMsg`)

```typescript
// Fire-and-forget (sem resposta):
{ type: 'CMD_FOLLOW', username: 'Steve' }
{ type: 'CMD_STOP' }
{ type: 'ASSIGN_TASK', descriptor: TaskDescriptor }

// Async (esperam CMD_RESULT com o mesmo reqId):
{ type: 'CMD_MOVE_TO', reqId: '123', x: 0, y: 64, z: 0 }
{ type: 'CMD_COLLECT', reqId: '456', blockName: 'oak_log', count: 16 }
```

### Worker → Main (`WorkerToMainMsg`)

```typescript
{ type: 'READY' }
{ type: 'STATE_UPDATE', snapshot: BotSnapshot }  // ~1 Hz
{ type: 'TASK_COMPLETE', taskId: 'orch_1_...' }
{ type: 'TASK_FAILED',   taskId: '...', error: '...', retryable: true }
{ type: 'CMD_RESULT',    reqId: '123', success: true, value?: unknown }
{ type: 'CHAT_MSG',      username: 'Steve', message: 'follow me' }
{ type: 'LOG',           level: 'info', message: '...' }
```

**Regra de ouro:** se você precisar de uma nova operação assíncrona do main para o worker,
adicione uma mensagem com `reqId` em `MainToWorkerMsg`, trate-a em `BotWorker.ts` e
responda com `CMD_RESULT`. Se for fire-and-forget, não precisa de reqId.

---

## 4. O Worker (`src/worker/BotWorker.ts`)

Cada Worker é uma instância isolada de Node.js rodando `BotWorker.ts`.
Ele possui:
- **`MineflayerAdapter`** — implementa `IBotAdapter`, chama a API do mineflayer
- **`TaskRunner`** — executa `TaskDescriptor` em sequência
- Um loop `setInterval` que envia `STATE_UPDATE` a cada segundo

O dispatch de mensagens é um `switch` em `port.on('message', ...)`.
Ao adicionar novos tipos de mensagem, adicione um `case` aqui.

---

## 5. A Interface Central: `IBotAdapter`

**Arquivo:** `src/infrastructure/mineflayer/IBotAdapter.ts`

Todo o código de aplicação (Orchestrator, SwarmController, TaskRunner) usa
apenas esta interface. Isso permite duas implementações:

| Classe | Onde roda | Como funciona |
|---|---|---|
| `MineflayerAdapter` | Dentro do Worker | Chama mineflayer diretamente |
| `WorkerCommandAdapter` | Main thread | Serializa comandos e envia via postMessage |

**Nunca importe `MineflayerAdapter` diretamente fora do Worker.**
Use sempre `IBotAdapter` nos tipos.

---

## 6. Behaviors (`src/infrastructure/mineflayer/behaviors/`)

Cada behavior é uma classe com lógica específica. O `MineflayerAdapter` os compõe.

| Behavior | Responsabilidade |
|---|---|
| `MovementBehavior` | `moveTo`, `follow` via pathfinder |
| `CombatBehavior` | `attack`, `pvp` (chase + hit) |
| `GuardBehavior` | `guard` (patrulha um ponto), `bodyguard` |
| `DefendBehavior` | Sempre ativo em background, ataca mobs hostis |
| `AvoidBehavior` | Foge de jogadores específicos |
| `MiningBehavior` | `collect` (minera N blocos), `collectVein` |
| `StorageBehavior` | `depositAll`, `withdraw`, `scanNearbyChests` |
| `FarmBehavior` | Colhe e replanta plantações |
| `ExploreBehavior` | Explora chunks novos em uma direção |
| `InventoryBehavior` | `equip`, `eat` |
| `BuildBehavior` | `buildFromQueue` (constrói de arquivo .schem) |
| `CraftingBehavior` | `craftItem` (usa mesa de craft se necessário) |

### Como criar um novo Behavior

1. Crie `src/infrastructure/mineflayer/behaviors/MeuBehavior.ts`
2. Implemente a lógica usando o padrão dos existentes:

```typescript
import { Bot } from '../../../domain/entities/Bot';
import { Bot as MineflayerBot } from 'mineflayer';
import { MetaStore } from '../BotMeta';

export class MeuBehavior {
  constructor(private readonly metaStore: MetaStore) {}

  async minhaAcao(domainBot: Bot, param: string): Promise<void> {
    const mfBot = domainBot.handle as MineflayerBot | null;
    if (!mfBot) return;

    // Use a API do mineflayer aqui
    mfBot.chat(`Fazendo: ${param}`);
  }
}
```

3. Adicione ao `MineflayerAdapter`:
   - Instancie no constructor: `private readonly meuBehavior = new MeuBehavior(this.metaStore);`
   - Adicione o método delegador: `meuAcao(bot, param) { return this.meuBehavior.minhaAcao(bot, param); }`

4. Adicione à interface `IBotAdapter`:
   ```typescript
   meuAcao(bot: Bot, param: string): Promise<void>;
   ```

---

## 7. Tasks — Como Adicionar uma Nova Tarefa

As tasks são o que o Orchestrator atribui autonomamente aos bots.
Uma task é serializável (cruza thread boundary via postMessage).

### Passo 1: Definir o tipo em `src/ipc/messages.ts`

```typescript
export type TaskDescriptor =
  // ... tipos existentes ...
  | { id: string; type: 'minha_task'; params: { alvo: string; quantidade: number } }
```

### Passo 2: Implementar em `src/tasks/TaskRunner.ts`

Dentro do `switch (d.type)` do método `execute()`:

```typescript
case 'minha_task': {
  this.checkCancelled(); // SEMPRE no início de tasks longas
  const { alvo, quantidade } = d.params;

  // Chame o adapter — ele está no mesmo Worker thread
  await this.adapter.minhaAcao(this.bot, alvo);

  // Se a task pode demorar, use Promise.race com cancellationToken():
  // await Promise.race([
  //   this.adapter.minhaAcao(this.bot, alvo),
  //   this.cancellationToken(),
  // ]);
  break;
}
```

**Sobre cancelamento:**
- `checkCancelled()` — lança exceção se já foi cancelada (use no início e entre etapas)
- `cancellationToken()` — promise que rejeita quando `cancel()` é chamado (use com `Promise.race`)
- Tasks que rodam indefinidamente (guard, farm) DEVEM usar `cancellationToken()`

### Passo 3: Atribuir a task no Orchestrator (se autônoma)

Em `src/orchestrator/Orchestrator.ts`, no `selectTask(rec)`:

```typescript
case 'meu_role':
  return { id: this.nextId(), type: 'minha_task', params: { alvo: 'bloco', quantidade: 16 } };
```

Ou execute-a via comando (`WorkerCommandAdapter.assignTask`).

---

## 8. Comandos — Como Adicionar um Novo Comando

Os comandos vêm do console (`swarm>`) ou do chat in-game.

### Passo 1: `SwarmController` (`src/application/SwarmController.ts`)

Adicione o método que itera pelos bots alvo e chama o adapter:

```typescript
meuComando(param: string, target?: BotTarget): void {
  this.getTargetBots(target).forEach(bot => {
    this.adapter.meuAcao(bot, param);
  });
}
```

### Passo 2: `CommandListener` (`src/application/CommandListener.ts`)

Adicione um `case` no `switch (cmd.toLowerCase())` dentro de `dispatch()`:

```typescript
case 'meucomando': {
  const [param] = args;
  if (!param) { console.log('Usage: meucomando <param>'); break; }
  this.controller.meuComando(param, target);
  break;
}
```

### Passo 3: Adicionar no `HELP_TEXT` no final de `CommandListener.ts`

```
  meucomando <param>            Descrição breve
```

### Passo 4 (se o comando precisa de resposta async do Worker)

Adicione em `WorkerCommandAdapter`:

```typescript
async meuComandoAsync(botId: string, param: string): Promise<void> {
  return this.sendAsync(botId, { type: 'CMD_MEU_COMANDO', reqId: this.newReqId(), param });
}
```

E trate o case em `BotWorker.ts`:

```typescript
case 'CMD_MEU_COMANDO':
  adapter.meuAcao(domainBot, msg.param)
    .then(() => send({ type: 'CMD_RESULT', reqId: msg.reqId, success: true }))
    .catch(e => send({ type: 'CMD_RESULT', reqId: msg.reqId, success: false, error: e.message }));
  break;
```

---

## 9. Roles e Fases da Colônia

### Roles (`src/orchestrator/RoleSystem.ts`)

Roles são atribuídas proporcionalmente ao número de bots online.
Para adicionar um novo role:

1. Adicione ao tipo `Role` em `src/orchestrator/GlobalState.ts`:
   ```typescript
   export type Role = 'miner' | 'hauler' | 'builder' | 'farmer' | 'soldier' | 'meu_role' | 'unassigned';
   ```

2. Adicione à função `assignRoles()` em `RoleSystem.ts`

3. Adicione à constante `ROLE_TASK_PRIORITY`

4. Adicione o `case` correspondente em `Orchestrator.selectTask()`

### Fases (`ColonyPhase`)

```typescript
type ColonyPhase = 'bootstrap' | 'resource_gathering' | 'base_building' | 'expansion' | 'combat';
```

Mude a fase em runtime: `orchestrator.setPhase('resource_gathering')`
Ou via console futuramente — adicione um comando `phase <nome>`.

---

## 10. API do Mineflayer — Referência Rápida

A biblioteca principal é **mineflayer** (`mfBot = domainBot.handle as MineflayerBot`).

### Acesso ao bot handle

```typescript
import { Bot as MineflayerBot } from 'mineflayer';
const mfBot = domainBot.handle as MineflayerBot | null;
if (!mfBot) return; // bot ainda não conectou
```

### Movimento (mineflayer-pathfinder)

```typescript
import { goals, Movements } from 'mineflayer-pathfinder';

// Mover para ponto exato
mfBot.pathfinder.setGoal(new goals.GoalBlock(x, y, z));

// Chegar perto de um ponto (distância máx = 2)
mfBot.pathfinder.setGoal(new goals.GoalNear(x, y, z, 2));

// Seguir entidade
mfBot.pathfinder.setGoal(new goals.GoalFollow(entity, 2), true);

// Parar
mfBot.pathfinder.stop();
mfBot.clearControlStates();

// Esperar chegar (promessificado):
await new Promise<void>((res, rej) => {
  mfBot.once('goal_reached', res);
  mfBot.once('path_update', s => { if (s.status === 'noPath') rej(new Error('noPath')); });
});
```

### Blocos

```typescript
// Encontrar bloco mais próximo por nome
const block = mfBot.findBlock({ matching: mfBot.registry.blocksByName['oak_log'].id, maxDistance: 64 });

// Minerar
await mfBot.dig(block);

// Colocar bloco
await mfBot.placeBlock(blockAbaixo, new Vec3(0, 1, 0)); // face = topo

// Ver bloco em posição
const b = mfBot.blockAt(new Vec3(x, y, z));
```

### Entidades

```typescript
// Encontrar jogador pelo nome
const player = mfBot.players['Steve']?.entity;

// Todos os mobs hostis
const mobs = Object.values(mfBot.entities).filter(e => e.type === 'mob');

// Atacar entidade
await mfBot.attack(entity);
```

### Inventário

```typescript
// Listar itens
mfBot.inventory.items(); // Array<Item>

// Equipar
await mfBot.equip(item, 'hand');

// Contar por nome
const count = mfBot.inventory.items()
  .filter(i => i.name === 'oak_log')
  .reduce((s, i) => s + i.count, 0);
```

### Chat

```typescript
mfBot.chat('olá mundo');
```

### Crafting

```typescript
// O CraftingBehavior já cuida disso, mas se precisar manual:
const recipe = mfBot.recipesFor(mfBot.registry.itemsByName['chest'].id, null, 1, null)[0];
await mfBot.craft(recipe, 1, craftingTableBlock);
```

### Eventos importantes

```typescript
mfBot.on('spawn', () => { /* bot entrou no servidor */ });
mfBot.on('death', () => { /* bot morreu */ });
mfBot.on('chat', (username, message) => { /* chat recebido */ });
mfBot.on('health', () => { /* hp/food mudou */ });
mfBot.on('physicsTick', () => { /* ~20x por segundo — use para lógica periódica */ });
mfBot.on('goal_reached', () => { /* pathfinder chegou ao destino */ });
mfBot.on('path_update', status => { /* status.status: 'arrived' | 'noPath' | 'timeout' */ });
```

---

## 11. O `BotMeta` e o `MetaStore`

**Arquivo:** `src/infrastructure/mineflayer/BotMeta.ts`

Behaviors que precisam manter estado (ex: "estou guardando?", "qual meu modo atual?")
usam o `MetaStore` — um `Map<botId, BotMeta>`.

```typescript
// Dentro de um behavior:
const meta = this.metaStore.get(domainBot);
meta.activeMode = 'guard';          // aparece no status/web UI
meta.guardInterval = setInterval(…); // guarda referência para poder parar
```

Se você precisar de estado novo em um behavior, adicione o campo em `BotMeta`:

```typescript
// BotMeta.ts
export interface BotMeta {
  activeMode: string;
  // ... campos existentes ...
  meuEstado?: MinhaInterface;
}
```

---

## 12. StorageCache

**Arquivo:** `src/infrastructure/storage/StorageCache.ts`

Registra posições de baús com rótulos. O Orchestrator usa para enviar bots ao baú mais próximo.

```typescript
storage.register('base', new Vec3(10, 64, 20));
storage.registerMany('minerio', [{ x:1, y:64, z:1 }, { x:3, y:64, z:1 }]);
storage.getNearest(botVec3);   // retorna { label, pos } do baú mais próximo
storage.list();                // todos os baús
storage.remove('base');
```

---

## 13. Configuração (`.env` / `src/config.ts`)

Crie um arquivo `.env` na raiz:

```env
MC_HOST=localhost
MC_PORT=25565
MC_VERSION=1.21
BOT_COUNT=3
BOT_PREFIX=SwarmBot
CONNECTION_MODE=direct      # direct | proxy
MASTER_USERNAME=MeuNick
WEB_PORT=3000
```

O `src/config.ts` lê essas variáveis e exporta o objeto `config`.

---

## 14. Como Rodar

```bash
# Desenvolvimento (ts-node, sem compilar)
npm run dev

# Produção
npm run build
npm start

# Compilar em watch mode
npm run watch
```

---

## 15. Padrões e Regras do Projeto

### Cancelamento de tasks

Toda task que pode demorar **deve** suportar cancelamento:

```typescript
// Para tasks pontuais (await único):
this.checkCancelled();
await this.adapter.algo(this.bot, ...);
this.checkCancelled(); // verifica depois também

// Para tasks contínuas (loop ou espera infinita):
await Promise.race([
  this.adapter.algo(this.bot, ...),
  this.cancellationToken(),
]);
```

### Não importar MineflayerAdapter fora do Worker

Se precisar chamar algo do main thread, faça via IPC. O `WorkerCommandAdapter`
já tem helpers para comandos async. Adicione lá se necessário.

### Thread safety

Cada Worker tem seu próprio heap JS — não há memória compartilhada.
Tudo que cruza threads deve ser JSON-serializável.
`Vec3` **não é** serializável diretamente — converta para `{ x, y, z }` antes de enviar.

### BotSnapshot vs BotRecord

- `BotSnapshot` — vem do worker (IPC), representa estado instantâneo
- `BotRecord` — `GlobalState` do Orchestrator, inclui campos extras (`role`, `failCount`, etc.)
- `applySnapshot(rec, snap)` — atualiza BotRecord com dados do snapshot

---

## 16. Fluxo Completo: Do Chat ao Behavior

Exemplo: jogador digita `follow me` no chat.

```
1. mfBot.on('chat')  →  BotWorker envia { type: 'CHAT_MSG', username, message }
2. WorkerCommandAdapter emite evento 'chat_msg'
3. CommandListener.dispatch('follow me')
4. SwarmController.followAll('me', undefined)
5. Para cada bot: WorkerCommandAdapter.follow(bot, 'me')
6.   → postMessage({ type: 'CMD_FOLLOW', username: 'me' }) ao worker do bot
7. BotWorker recebe, chama adapter.follow(domainBot, 'me')
8. MineflayerAdapter.follow() → MovementBehavior.follow()
9. MovementBehavior seta GoalFollow no pathfinder do mineflayer
```

---

## 17. Adicionando um Novo Role Completo — Exemplo Prático

Vamos adicionar um role `scout` que explora constantemente.

### 1. `src/orchestrator/GlobalState.ts`
```typescript
export type Role = 'miner' | 'hauler' | 'builder' | 'farmer' | 'soldier' | 'scout' | 'unassigned';
```

### 2. `src/orchestrator/RoleSystem.ts`
```typescript
// Em assignRoles(), para botCount >= 6, por exemplo:
const scouts = Math.max(0, Math.round(botCount * 0.10));

// E na lista de retorno:
return [...fill('miner', miners), ..., ...fill('scout', scouts)];

// Em ROLE_TASK_PRIORITY:
export const ROLE_TASK_PRIORITY = {
  // ...
  scout: ['explore', 'idle'],
};
```

### 3. `src/orchestrator/Orchestrator.ts`
```typescript
case 'scout':
  return { id: this.nextId(), type: 'explore', params: { direction: 'auto' } };
```

Pronto. O Orchestrator vai automaticamente atribuir scouts quando houver bots suficientes,
e eles vão ficar explorando em direções aleatórias.

---

## 18. Bugs Conhecidos

| Bug | Onde | Como abordar |
|---|---|---|
| `farm` não tem `resumeCallback` | `TaskRunner.ts` `case 'farm'` | Após `Promise.race`, verificar se cancelado vs concluído e chamar algum callback |
| `move`, `collect`, `build` não são interrompíveis pelo `stop` durante `await` | `BotWorker.ts` | Wrapping com `Promise.race([..., cancellationToken()])` em cada um |
| `quarryFromQueue` e `buildFromQueue` não serializados para IPC | `WorkerCommandAdapter.ts` | Precisam de serialização da `QuarryQueue`/`BuildQueue` para JSON antes de enviar |

---

## 19. Estrutura de Arquivos de Referência

```
src/
├── config.ts                         ← variáveis de ambiente
├── index.ts                          ← entry-point principal
├── domain/
│   ├── entities/Bot.ts               ← entidade Bot (username, estado, handle)
│   ├── repositories/IBotRepository   ← interface do repositório
│   └── value-objects/
│       ├── BotState.ts               ← enum: CONNECTING, CONNECTED, DISCONNECTED, ERROR
│       ├── ProxyConfig.ts
│       └── PlayerRelationship.ts     ← friend/enemy/neutral
├── infrastructure/
│   ├── mineflayer/
│   │   ├── IBotAdapter.ts            ← INTERFACE CENTRAL — sempre use ela
│   │   ├── MineflayerAdapter.ts      ← implementação real (dentro do worker)
│   │   ├── BotMeta.ts                ← estado runtime por bot
│   │   ├── utils.ts
│   │   ├── physics/PhysicsPatch.ts   ← corrige bug de NaN velocity no 1.21
│   │   └── behaviors/               ← lógicas específicas
│   ├── repositories/InMemoryBotRepository.ts
│   ├── network/
│   │   ├── NetworkProvider.ts
│   │   └── ProxyLoader.ts
│   ├── mining/QuarryQueue.ts
│   ├── schematic/
│   │   ├── SchematicLoader.ts
│   │   └── BuildQueue.ts
│   ├── storage/StorageCache.ts
│   ├── web/WebServer.ts
│   └── LogBuffer.ts
├── application/
│   ├── BotManager.ts                 ← spawna/derruba bots
│   ├── SwarmController.ts            ← API de comandos para o swarm
│   ├── CommandListener.ts            ← parsing de comandos (console + chat)
│   ├── BotGroupStore.ts              ← grupos nomeados de bots
│   └── SwarmIntel.ts                 ← intel compartilhada (posições de jogadores)
├── orchestrator/
│   ├── Orchestrator.ts               ← loop de 2 s, atribui tarefas
│   ├── GlobalState.ts                ← BotRecord, ColonyPhase, createGlobalState
│   └── RoleSystem.ts                 ← assignRoles, ROLE_TASK_PRIORITY
├── worker/
│   ├── BotWorker.ts                  ← entry-point de cada Worker thread
│   └── WorkerCommandAdapter.ts       ← proxy main→worker via postMessage
├── tasks/
│   └── TaskRunner.ts                 ← executor de TaskDescriptor no worker
└── ipc/
    └── messages.ts                   ← TODOS os tipos IPC — edite aqui primeiro
```
