# Guia de Mineflayer — Como a biblioteca funciona e como é usada no projeto

## O que é Mineflayer

Mineflayer é uma biblioteca Node.js que cria bots Minecraft (clientes headless). Ela se conecta a um servidor exatamente como um player humano faria — lê pacotes da rede, mantém o estado do mundo (blocos, entidades, inventário) em memória, e permite executar ações (andar, minerar, craftar, etc).

O bot tem acesso a:
- `mfBot.entity` — posição, velocidade, saúde do próprio bot
- `mfBot.entities` — mapa de todas as entidades visíveis (players, mobs)
- `mfBot.players` — mapa de players conectados (subconjunto de entities)
- `mfBot.inventory` — inventário do bot
- `mfBot.blockAt(pos)` — retorna o bloco naquela posição Vec3
- `mfBot.findBlock({matching, maxDistance})` — busca o bloco mais próximo
- `mfBot.dig(block, force)` — minera um bloco (Promise)
- `mfBot.attack(entity)` — ataca uma entidade
- `mfBot.chat(msg)` — envia mensagem no chat
- `mfBot.equip(item, 'hand')` — equipa um item
- `mfBot.placeBlock(referenceBlock, faceVec)` — coloca um bloco
- `mfBot.craft(recipe, count, craftingTable)` — crafta item
- `mfBot.recipesFor(itemId, null, 1, tableOrNull)` — retorna receitas disponíveis
- `mfBot.openChest(block)` — abre um chest (retorna window com `.items()`, `.deposit()`, `.withdraw()`, `.close()`)
- `mfBot.respawn()` — manda o pacote de respawn após morrer
- `mfBot.physicsEnabled` — bool que controla se a física roda (deve ser sempre true)
- `mfBot.clearControlStates()` — para todo movimento (solta todas as teclas)
- `mfBot.canDigBlock(block)` — retorna se o bot consegue minerar aquele bloco com a tool atual

### Eventos principais

| Evento | Quando dispara |
|---|---|
| `spawn` | Bot entrou no mundo (também ao respawnar) |
| `death` | Bot morreu |
| `end` | Conexão encerrada |
| `error` | Erro de rede |
| `kicked` | Bot foi kickado |
| `health` | Saúde ou comida mudou |
| `physicsTick` | Toda tick de física (~20x/seg) — usar para loops de comportamento |
| `goal_reached` | Pathfinder chegou ao destino |
| `path_update` | Pathfinder atualizou o caminho — `r.status` pode ser `'noPath'`, `'success'`, `'partialSuccess'` |
| `path_stop` | Pathfinder parou de navegar |
| `entityHurt` | Uma entidade tomou dano (incluindo o bot) |

---

## mineflayer-pathfinder

Plugin de navegação A*. É carregado com `mfBot.loadPlugin(pathfinder)` no spawn.

**API principal:**
```ts
// Configura as regras de movimento (o que pode pisar, custos)
mfBot.pathfinder.setMovements(movements)

// Define o objetivo e começa a navegar
mfBot.pathfinder.setGoal(goal)
mfBot.pathfinder.setGoal(goal, dynamic) // dynamic=true: recalcula a cada tick (usar para follow)

// Para a navegação
mfBot.pathfinder.stop()

// Timeout de CPU por tick (padrão 40ms, reduzido aqui para 10ms para não travar com muitos bots)
mfBot.pathfinder.tickTimeout = 10
```

**Goals disponíveis** (de `mineflayer-pathfinder`):
```ts
new goals.GoalNear(x, y, z, radius)      // chega a até radius blocos de distância
new goals.GoalGetToBlock(x, y, z)         // chega adjacente ao bloco
new goals.GoalFollow(entity, distance)    // segue entidade mantendo distância
```

**Movements** — criado com `new Movements(mfBot)`:
```ts
movements.allowSprinting = true
movements.maxDropDown = 3              // quantos blocos pode cair sem dano
movements.blocksToAvoid.add(blockId)   // bloco que o pathfinder evita
```

No projeto existe `createMovements(mfBot)` em `PhysicsPatch.ts` que já configura tudo (evita lava, fogo, etc., trata água como cara mas passável). Sempre use esta função em vez de criar `Movements` manualmente.

---

## minecraft-data

Biblioteca de dados estáticos do Minecraft. Carregada via:
```ts
const mcData = require('minecraft-data')(mfBot.version)
```

Uso mais comum no projeto:
```ts
mcData.blocksByName['oak_log']    // → { id, name, ... }
mcData.itemsByName['wooden_axe']  // → { id, name, ... }
mcData.blocks[id]                 // → { harvestTools: { toolId: true, ... }, ... }
```

---

## Como o projeto está estruturado

```
src/
├── domain/              ← Entidades de domínio puras (sem mineflayer)
│   └── entities/Bot.ts  ← Classe Bot com id, username, state, handle (= mfBot)
├── infrastructure/
│   └── mineflayer/
│       ├── MineflayerAdapter.ts   ← Ponto de entrada principal — cria bots e roteia chamadas
│       ├── BotMeta.ts             ← Estado runtime de cada bot (listeners ativos, modo atual)
│       ├── IBotAdapter.ts         ← Interface pública do adapter
│       ├── physics/
│       │   └── PhysicsPatch.ts    ← Corrige bugs de NaN velocity do 1.21 + createMovements()
│       └── behaviors/
│           ├── MovementBehavior.ts   ← moveTo(), follow()
│           ├── CombatBehavior.ts     ← attack(), pvp()
│           ├── GuardBehavior.ts      ← guard(), bodyguard()
│           ├── DefendBehavior.ts     ← startDefend() — modo background de autodefesa
│           ├── AvoidBehavior.ts      ← avoid() — foge de players específicos
│           ├── MiningBehavior.ts     ← collect(), collectVein(), quarryFromQueue()
│           ├── StorageBehavior.ts    ← depositAll(), withdraw(), scanNearbyChests()
│           ├── CraftingBehavior.ts   ← craft() com gestão automática de crafting table
│           ├── InventoryBehavior.ts  ← equip(), eat()
│           ├── FarmBehavior.ts       ← farm()
│           ├── BuildBehavior.ts      ← buildFromQueue()
│           └── ExploreBehavior.ts    ← explore()
├── tasks/TaskRunner.ts     ← Executa TaskDescriptors usando o adapter
├── orchestrator/
│   ├── Orchestrator.ts     ← Cérebro central — tick loop de 2s, atribui tarefas
│   ├── GlobalState.ts      ← Estado da colônia (phase, bots, storage)
│   └── RoleSystem.ts       ← Atribui roles (miner, builder, farmer, soldier, hauler)
├── worker/
│   └── BotWorker.ts        ← Thread de cada bot (Worker Thread do Node.js)
└── index.ts                ← Entry point
```

---

## Padrão de uso do mfBot dentro dos behaviors

Todos os behaviors acessam o mfBot assim:
```ts
const mfBot = domainBot.handle as MineflayerBot | null
if (!mfBot) return
```

O `domainBot.handle` é o objeto retornado por `mineflayer.createBot(...)`. É atribuído em `MineflayerAdapter.spawn()` via `domainBot.attachHandle(mfBot)`.

---

## BotMeta — estado runtime por bot

`BotMeta` é um objeto por bot armazenado em `WeakMap<Bot, BotMeta>` dentro de `MetaStore`.

Campos importantes:
- `pvpListener` — tick listener do follow/pvp (compartilhado — um substitui o outro)
- `guardListener` — tick listener do guard/bodyguard
- `defendListener` — tick listener do defend (roda em paralelo com o modo principal)
- `_defendHurtListener` — listener de `entityHurt` do defend
- `avoidListener` — tick listener do avoid
- `farmingActive` / `exploringActive` — flags de loop async
- `resumeCallback` — chamado pelo DefendBehavior quando o combate termina, para retomar o modo anterior imediatamente
- `activeMode` — string exibida no UI de debug

Para parar um behavior que usa tick listener, basta fazer:
```ts
mfBot.removeListener('physicsTick', meta.pvpListener)
delete meta.pvpListener
```

---

## Fluxo de criação de um bot

1. `MineflayerAdapter.spawn(domainBot, options)` chama `mineflayer.createBot({host, port, username, ...})`
2. Carrega o plugin pathfinder com `mfBot.loadPlugin(pathfinder)`
3. No evento `spawn`: configura pathfinder, instala `PhysicsPatches`, define estado como `CONNECTED`
4. No evento `death`: aguarda 1.5s e chama `mfBot.respawn()`
5. No evento `health`: se saúde < 10, tenta comer automaticamente
6. No evento `end`: marca estado como `DISCONNECTED`

---

## Fluxo de mining (collect)

`MiningBehavior.collect(bot, blockName, count)`:
1. Carrega `mcData` com a versão do servidor
2. Loop até coletar `count` blocos:
   - `mfBot.findBlock({matching, maxDistance: 64})` — busca o bloco mais próximo não submerso e acessível
   - `safeDig(mfBot, pos, expectedName, mcData)`:
     - Navega até o bloco com `GoalGetToBlock`
     - Equipa a melhor tool com `autoEquipToolFor`
     - Verifica `mfBot.canDigBlock(block)`
     - Chama `mfBot.dig(block, true)`
   - Se inventário cheio e `onFull` fornecido, chama `onFull(bot)` (deposita no chest)

**Problema conhecido** (listado em problems.md): o search radius é 64 mas pode não encontrar madeira se só tiver outros tipos além de oak. A solução (`collect_wood` no TaskRunner) já tenta todos os tipos de madeira em sequência.

---

## Fluxo de storage (depositAll)

`StorageBehavior.depositAll(bot, chestPos)`:
1. Navega até `GoalNear(chestPos, 3)`
2. Chama `mfBot.openChest(block)` — retorna um window com `.items()` e `.deposit()`
3. Para cada item do inventário que não tem durabilidade (não é ferramenta/armor):
   - `chest.deposit(item.type, item.metadata, item.count)`
4. Chama `chest.close()`

**Problema atual**: a detecção de "tem durabilidade" usa `item.nbt?.value?.Damage?.value > 0`. Itens novos têm Damage=0, então uma espada nova seria depositada. Para preservar ferramentas, filtre também pelo nome (`item.name.includes('sword')`, `_axe`, etc).

---

## Fluxo de crafting

`CraftingBehavior.craft(bot, itemName, count)`:
1. Tenta receita 2×2 (sem mesa): `mfBot.recipesFor(id, null, 1, null)`
2. Se não tem receita 2×2, chama `ensureCraftingTable()`:
   - Procura mesa a até 6 blocos
   - Se não achar, verifica inventário — se não tiver, crafta uma (2×2 de planks)
   - Coloca a mesa no bloco abaixo do bot
3. Tenta receita 3×3 com a mesa: `mfBot.recipesFor(id, null, 1, tableBlock)`
4. Chama `mfBot.craft(recipe, count, tableBlock)`

---

## Fluxo de defend (autodefesa background)

`DefendBehavior.start(bot, radius)` instala dois listeners independentes:
- `entityHurt` — reage ao dano imediatamente, escaneia raio 2× para pegar mobs que recuaram
- `physicsTick` — a cada 10 ticks (2 Hz) escaneia entidades:
  - Creeper dentro de 7 blocos → foge
  - Mob hostil na área → usa `GoalFollow(mob, 1)` + ataca a cada tick quando a <3.5 blocos
  - Aerial mobs (phantom, ghast) → fica parado e acerta quando está próximo
  - Quando o combate termina → chama `meta.resumeCallback()` para retomar o modo anterior

Esse modo roda em paralelo com qualquer outro modo (mine, explore, farm). É iniciado no bootstrap e fica ativo o tempo todo.

**Problema atual** (listado em problems.md): os bots não têm defend ativo desde o início. O `startDefend` precisa ser chamado logo após o spawn para cada bot.

---

## Tasks disponíveis (TaskRunner)

| type | params | descrição |
|---|---|---|
| `idle` | `durationMs` | Fica parado por N ms |
| `mine` | `blockName, count, chestPos?` | Minera N blocos, deposita se cheio |
| `collect_wood` | `count, chestPos?` | Tenta cada tipo de madeira em sequência |
| `deposit` | `chestPos` | Deposita tudo no chest |
| `guard` | `x, y, z, radius` | Guarda posição (roda até cancelar) |
| `farm` | `centerX, centerZ, radius` | Faz farming em área |
| `explore` | `direction` | Explora direção (north/south/east/west/auto) |
| `craft` | `itemName, count` | Crafta item |
| `build_storage` | `storageLabel, centerX, centerY, centerZ, chestCount` | Coleta madeira → crafta → coloca chests → registra |

---

## Fases da colônia (Orchestrator)

`ColonyPhase` em `GlobalState.ts`:
- `bootstrap` → todos os miners coletam madeira (32 logs)
- fases seguintes → definidas em `RoleSystem.mineTargetForPhase()`

O Orchestrator roda a cada 2s e atribui tarefas baseado no role e na fase. Bots idle recebem tarefa nova. Bots com 3 falhas consecutivas ficam em idle por 10s.

---

## Dicas para depurar

- Todos os logs seguem o padrão `[Modulo] botUsername: mensagem`
- `mfBot.entities` é um objeto `{id: Entity}` — itere com `Object.values(mfBot.entities)`
- `mfBot.players[username]?.entity` pode ser `undefined` se o player estiver fora do render distance
- Depois de qualquer navegação, sempre chame `mfBot.pathfinder.stop()` e `mfBot.clearControlStates()` para garantir que o bot não continua se movendo
- O pathfinder não funciona se `mfBot.physicsEnabled === false` — o watchdog em `PhysicsPatch` força para `true` a cada 50ms
- `mfBot.blockAt(pos)` retorna `null` se o chunk não carregou ainda
