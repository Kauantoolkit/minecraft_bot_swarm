# Arquitetura Proposta — Minecraft Bot Swarm

> Avaliação da estrutura atual + proposta de refatoração que mantém toda a lógica
> existente, separa responsabilidades e abre espaço para os novos casos de uso.

---

## 1. Problema da Estrutura Atual

`MineflayerAdapter.ts` tem ~1500 linhas e acumula:

- Configuração de physics (NaN patches, velocity clamping)
- 10+ modos de comportamento completamente independentes
- Interface `BotMeta` misturada com toda a implementação
- Funções utilitárias (`ts()`, `clampVelocity`, `createMovements`) acopladas à classe

Consequências reais:
- Difícil adicionar um novo comportamento sem mexer em código não relacionado
- Impossível testar um modo em isolamento
- `BotMeta` cresce sem controle (cada novo modo adiciona campos)

---

## 2. Arquitetura Proposta

A abordagem é **Behavior Modules** — não behavior tree nem state machine formal.

Motivos:
- A base já é orientada a eventos/listeners; manter esse padrão é menos risco
- Behavior tree é ótimo para IA complexa, mas aqui os modos são explicitamente ativados pelo operador
- State machine formal geraria boilerplate pesado para casos simples como `farm` e `explore`
- O que realmente precisamos é **separar arquivos** e **tipar melhor os contratos**

### Estrutura de Diretórios

```
src/
├── domain/
│   ├── entities/
│   │   └── Bot.ts                        (sem mudanças)
│   ├── value-objects/
│   │   ├── BotState.ts                   (sem mudanças)
│   │   └── PlayerRelationship.ts         (sem mudanças)
│   └── ports/                            ← NOVO
│       └── IStoragePort.ts               ← abstração para chest I/O
│
├── application/
│   ├── SwarmController.ts                (pequenas adições)
│   ├── SwarmIntel.ts                     (sem mudanças)
│   └── CommandListener.ts               (novos comandos)
│
└── infrastructure/
    ├── mineflayer/
    │   ├── MineflayerAdapter.ts          ← orquestrador fino; delega para módulos
    │   ├── BotMeta.ts                    ← EXTRAÍDO do adapter
    │   ├── physics/
    │   │   └── PhysicsPatch.ts           ← EXTRAÍDO: NaN clamping, installPhysicsPatches
    │   └── behaviors/                    ← EXTRAÍDO do adapter
    │       ├── MovementBehavior.ts       ← follow, moveTo
    │       ├── ExploreBehavior.ts        ← explore, stopExplore
    │       ├── CombatBehavior.ts         ← pvp, stopPvp
    │       ├── GuardBehavior.ts          ← guard, bodyguard, stopGuard
    │       ├── DefendBehavior.ts         ← startDefend, stopDefend
    │       ├── AvoidBehavior.ts          ← avoid, stopAvoid
    │       ├── FarmBehavior.ts           ← farm, stopFarm
    │       ├── MiningBehavior.ts         ← collect, collectVein, quarryFromQueue
    │       ├── BuildBehavior.ts          ← buildFromQueue
    │       ├── InventoryBehavior.ts      ← NOVO: equip, eat, tool management
    │       ├── StorageBehavior.ts        ← NOVO: chest open/deposit/withdraw
    │       └── PatrolBehavior.ts         ← NOVO: explore+proteger aliados+caçar inimigos
    ├── storage/
    │   └── StorageCache.ts               ← NOVO: posições e conteúdo de chests conhecidos
    ├── schematic/
    │   └── BuildQueue.ts                 (sem mudanças)
    ├── mining/
    │   └── QuarryQueue.ts                (sem mudanças)
    └── network/
        └── NetworkProvider.ts            (sem mudanças)
```

### Como o MineflayerAdapter fica

Vira um orquestrador fino que apenas instancia os módulos e expõe a API pública:

```typescript
// MineflayerAdapter.ts — depois da refatoração
export class MineflayerAdapter {
  private movement  = new MovementBehavior();
  private explore   = new ExploreBehavior();
  private combat    = new CombatBehavior();
  private guard     = new GuardBehavior();
  private defend    = new DefendBehavior();
  private avoid     = new AvoidBehavior();
  private farm      = new FarmBehavior();
  private mining    = new MiningBehavior();
  private build     = new BuildBehavior();
  private inventory = new InventoryBehavior();
  private storage   = new StorageBehavior();
  private patrol    = new PatrolBehavior(this.combat, this.guard, this.explore);

  follow(bot, username)        { this.movement.follow(bot, username); }
  pvp(bot, targets, ...)       { this.combat.pvp(bot, targets, ...); }
  startDefend(bot, radius)     { this.defend.start(bot, radius); }
  // ... etc
}
```

### BotMeta

Fica em `BotMeta.ts`. Cada módulo acessa apenas os seus campos:

```typescript
export interface BotMeta {
  // --- Campos globais ---
  activeMode: string;
  resumeCallback?: () => void;

  // --- Movement ---
  pvpListener?: () => void;
  followPathUpdateListener?: (r: { status: string }) => void;

  // --- Guard ---
  guardListener?: () => void;

  // --- Defend ---
  defendListener?: () => void;
  _defendHurtListener?: (e: Entity) => void;
  _defendPathUpdateListener?: (r: { status: string }) => void;

  // --- Avoid ---
  avoidListener?: () => void;

  // --- Async loops ---
  farmingActive?: boolean;
  exploringActive?: boolean;
  patrolActive?: boolean;     // novo
}
```

---

## 3. Novos Casos de Uso

### 3.1 Escort (escoltar + atacar ameaças próximas)

**Situação atual:** existe como dois comandos separados — `defend <player>` (bodyguard) + `defend`
(background self-defense). Funciona, mas o operador precisa lembrar de ativar os dois.

**Proposta:** comando `escort <player> [radius]` que ativa bodyguard + self-defense em uma só chamada.
Nada novo na lógica; é só açúcar sintático no `CommandListener` + `SwarmController`.

```
escort PlayerX 8
  → bodyguard(PlayerX, 8)
  → startDefend(8)          ← background, coexiste com bodyguard
```

---

### 3.2 JSON Attack List

**Situação atual:** `attack-list` lê `targets.txt` (um username por linha).

**Proposta:** aceitar `.json` também. Format sugerido:

```json
{
  "targets": ["Player1", "Player2"],
  "priority": "nearest"
}
```

Implementação: no `CommandListener`, se o arquivo terminar em `.json`, faz `JSON.parse`,
extrai `targets[]` e passa para `SwarmController.pvpAll()` — que já existe e não muda.

---

### 3.3 Minerar e Guardar em Storage

**Componentes novos necessários:**

**`StorageCache`** — rastreia chests conhecidos:
```typescript
class StorageCache {
  register(pos: Vec3, label?: string): void   // registra um chest pelo operador
  getNearest(botPos: Vec3): Vec3 | null        // retorna o chest mais próximo
  invalidate(pos: Vec3): void                  // remove chest destruído
}
```

**`StorageBehavior`** — abre e interage com chests:
```typescript
class StorageBehavior {
  async deposit(bot, chestPos, items: string[]): Promise<void>
  async withdraw(bot, chestPos, item: string, count: number): Promise<void>
  async depositAll(bot, chestPos): Promise<void>   // tudo no inventário
}
```

**`MiningBehavior`** ganha parâmetro `storagePos?`:
```
mine <bloco> [count] [--store <label|x,y,z>]

Loop:
  1. Equipa ferramenta certa (InventoryBehavior.ensureToolFor)
  2. Navega até o bloco
  3. Minera
  4. Se inventário > 75% cheio → StorageBehavior.depositAll(chestMaisProximo)
  5. Volta a minerar
```

Comando:
```
mine diamond_ore 64 --store base
quarry 0 60 0 100 60 100 --store base
```

---

### 3.4 Gerenciamento de Ferramentas

**`InventoryBehavior`** (extrai `equip` e `eat` atuais, adiciona lógica de tool):

```typescript
class InventoryBehavior {
  equip(bot, itemName): Promise<void>        // já existe
  eat(bot): Promise<void>                    // já existe

  // novos:
  ensureToolFor(bot, blockName): Promise<void>
  // → encontra ferramenta mais eficiente para aquele bloco
  // → equipa
  // → se não tiver no inventário: busca no StorageCache (chama StorageBehavior.withdraw)

  repairOrReplace(bot): Promise<void>
  // → detecta ferramenta com durabilidade < 10%
  // → tenta retirar reserva do storage mais próximo
  // → equipa a nova ferramenta
}
```

Integração: `MiningBehavior` chama `ensureToolFor(blockName)` antes de cada bloco.
O `physicsTick` do modo mining pode rodar `repairOrReplace()` periodicamente.

---

### 3.5 Patrol — Modo Autônomo (explorar + reagir a jogadores)

Este é o caso de uso mais complexo. Máquina de estados explícita dentro de `PatrolBehavior`:

```
Estados:
  EXPLORING   → bot explora usando ExploreBehavior (GoalXZ legs de 200 blocos)
  ESCORTING   → aliado detectado: ativa GuardBehavior.bodyguard(aliado)
  PURSUING    → inimigo detectado: ativa CombatBehavior.pvp(inimigo)
  RETURNING   → alvo sumiu, volta a explorar

Transições:
  EXPLORING  → ESCORTING   : encontrou aliado (friend list) no range
  EXPLORING  → PURSUING    : encontrou inimigo (enemy list) no range
  ESCORTING  → PURSUING    : inimigo aparece enquanto escolta
  PURSUING   → ESCORTING   : inimigo morto/fugiu, aliado ainda visível
  PURSUING   → RETURNING   : inimigo morto/fugiu, sem aliado visível
  ESCORTING  → RETURNING   : aliado saiu do range / desconectou
  RETURNING  → EXPLORING   : alguns segundos sem encontrar ninguém
```

```typescript
class PatrolBehavior {
  constructor(
    private combat: CombatBehavior,
    private guard: GuardBehavior,
    private explore: ExploreBehavior,
    private relations: PlayerRelationshipStore,
  ) {}

  start(bot: Bot, scanRadius = 30): void {
    // instala physicsTick para escanear entidades a cada 10 ticks
    // chama explore.start() como estado inicial
    meta.patrolActive = true;
  }

  stop(bot: Bot): void { meta.patrolActive = false; }
}
```

Comando:
```
patrol [radius]          ← inicia modo autônomo
patrol off               ← para
```

---

## 4. Regra de Prioridade de Modos

Com os novos casos de uso, a hierarquia fica:

```
Prioridade (maior = vence o pathfinder):

  5. Defend background     — coexiste com tudo, nunca cancela primário
  4. Avoid                 — intervém pontualmente, depois devolve
  3. Combat (pvp, guard, bodyguard, patrol/pursuing)
  2. Movement (follow, escort, patrol/escorting)
  1. Task (explore, farm, mine, build)   ← assíncrono, pode ser interrompido
```

Hoje isso é implícito (quem chama `setGoal` por último vence). Com a arquitetura modular,
cada módulo pode checar `meta.activeMode` antes de setar o goal e decidir se deve ou não intervir.

---

## 5. Plano de Migração (sem quebrar o que funciona)

A refatoração deve ser feita em etapas pequenas. Cada etapa é commitável e não quebra
o sistema:

### Etapa 1 — Extrair BotMeta e PhysicsPatch
- Criar `BotMeta.ts` com a interface + `getMeta()` helper
- Criar `physics/PhysicsPatch.ts` com `clampVelocity`, `vecIsNaN`, `installPhysicsPatches`
- `MineflayerAdapter.ts` importa e usa

### Etapa 2 — Extrair behaviors um a um (mais simples primeiro)
Ordem sugerida:
1. `AvoidBehavior.ts` (mais isolado, sem dependências internas)
2. `FarmBehavior.ts`
3. `ExploreBehavior.ts`
4. `MovementBehavior.ts` (follow, moveTo)
5. `CombatBehavior.ts` (pvp)
6. `DefendBehavior.ts`
7. `GuardBehavior.ts` (guard + bodyguard — compartilham guardListener)
8. `MiningBehavior.ts` (collect, vein, quarry)
9. `BuildBehavior.ts`
10. `InventoryBehavior.ts` (equip + eat)

### Etapa 3 — Novos módulos
1. `StorageBehavior.ts` + `StorageCache.ts` (chest I/O)
2. Adicionar `ensureToolFor` no `InventoryBehavior`
3. Integrar `--store` no `MiningBehavior`
4. `PatrolBehavior.ts`
5. Comando `escort` (sugar syntax)

### Etapa 4 — MineflayerAdapter vira orquestrador
- Substitui todo o corpo atual por instâncias dos módulos e delegação
- API pública permanece idêntica (SwarmController não muda)

---

## 6. O que NÃO mudar

- `SwarmController.ts` — apenas recebe novos métodos (escort, patrol, mine-to-storage)
- `SwarmIntel.ts` — sem mudanças
- `CommandListener.ts` — apenas novos `case` no switch
- `BuildQueue.ts`, `QuarryQueue.ts` — sem mudanças
- `Bot.ts`, `BotState.ts`, `PlayerRelationship.ts` — sem mudanças
- A lógica interna de cada behavior — copia do adapter, não reescreve

---

## 7. Resumo das Decisões

| Decisão | Escolha | Motivo |
|---------|---------|--------|
| Padrão de behaviors | Módulos de classe com start/stop | Menos boilerplate, mantém padrão atual |
| Behavior tree | Não | Overkill; modos são controlados pelo operador, não por IA autônoma |
| State machine formal | Apenas para Patrol | Somente o Patrol tem transições complexas que justificam |
| Quebrar API pública | Não | SwarmController e CommandListener permanecem iguais |
| Migração | Incremental por etapas | Cada etapa é testável e commitável isoladamente |
