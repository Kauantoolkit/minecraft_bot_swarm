# Minecraft Bot Swarm — Command Flows & Interference Map

> Reference interno para desenvolvimento. Descreve o ciclo de vida de cada modo,
> quais slots de listener cada um ocupa e como modos diferentes se interferem.

---

## 1. Tipos de Modo

| Tipo | Exemplos | Como para |
|------|----------|-----------|
| **Contínuo (listener)** | follow, pvp, guard, bodyguard, avoid | Remove listener do `physicsTick` |
| **Background** | defend (self-defense) | Remove listener; não sobrescreve activeMode |
| **Async loop** | explore, farm | Flag `exploringActive` / `farmingActive = false` |
| **Async one-shot** | move, collect, equip, eat, build, quarry | Promise resolve / timeout |

---

## 2. Slots de Listener (Conflito Mútuo)

Cada slot suporta **um listener por vez**. Iniciar um novo modo no mesmo slot remove o anterior silenciosamente.

```
pvpListener        → follow, pvp           (compartilham o mesmo campo)
guardListener      → guard, bodyguard       (compartilham o mesmo campo)
defendListener     → defend (background)    (independente)
avoidListener      → avoid                  (independente)
```

### Consequência prática

```
pvp PlayerA        → pvpListener = pvpTick
follow PlayerB     → pvpListener = followTick   ← pvpTick REMOVIDO sem aviso
```

O bot para de perseguir `PlayerA` silenciosamente.

---

## 3. Ciclo de Vida de Cada Modo

### 3.1 `follow <player>`

```
Início
  meta.pvpListener = followTick
  pathfinder.setGoal(GoalFollow(entity, 2))  ← goal contínuo

Loop (physicsTick, a cada 10 ticks)
  Se target sumiu do range → aguarda reaparecer
  Se target voltou        → pathfinder.setGoal(GoalFollow)
  Retry em noPath         → até 5 tentativas, backoff 3 s

Parada
  stopPvp() → remove pvpListener + followPathUpdateListener
  pathfinder.stop() + clearControlStates()
```

**Conflito direto:** `pvp` (mesmo slot).
**Não interfere com:** `defend`, `avoid`, `farm`, `explore` (desde que não sejam iniciados depois).

---

### 3.2 `pvp <player...>`

```
Início
  meta.pvpListener = pvpTick
  meta.activeMode  = 'pvp:[...]'
  pathfinder.setGoal(GoalFollow(entity, 1))

Loop (physicsTick, todo tick)
  Escaneia targets visíveis → setGoal(GoalFollow)
  Puxa posição do SwarmIntel quando fora de range
  Ataca quando dentro de 3 blocos
  Reporta posição ao intel bus

Parada
  stopPvp()
```

**Conflito direto:** `follow` (mesmo slot).
**Usa:** `SwarmIntel` (sightings compartilhados entre bots).

---

### 3.3 `guard <x> <y> <z> [radius]`

```
Início
  meta.guardListener = guardTick
  meta.activeMode    = 'guard:(x,y,z)'
  pathfinder.setGoal(GoalBlock(post))  ← vai até o posto

Loop (physicsTick)
  Estado 'moving-to-post': aguarda chegar
  Estado 'idle':           escaneia entidades a cada 10 ticks
  Estado 'chasing':        pathfinder.setGoal(GoalFollow(ameaça))

Parada
  stopGuard() → remove guardListener
```

**Conflito direto:** `bodyguard` (mesmo slot).
**Não usa:** intel, defend, follow.

---

### 3.4 `defend <player> [radius]` — Bodyguard

```
Início
  meta.guardListener = bodyguardTick
  meta.activeMode    = 'bodyguard:<player>'
  pathfinder.setGoal(GoalFollow(ward, 2))

Loop (physicsTick, a cada 5 ticks)
  Estado 'following':        mantém GoalFollow(ward)
  Estado 'heading-to-intel': navega para última posição conhecida
  Estado 'waiting':          aguarda ward reaparecer
  Estado 'attacking':        GoalFollow(ameaça), ataca todo tick

Parada
  stopGuard()
```

**Conflito direto:** `guard` (mesmo slot).
**Usa:** `SwarmIntel` para encontrar ward fora de range.
**Mobs aéreos:** bot fica parado e ataca corpo-a-corpo (evita ficar preso no ar).

---

### 3.5 `defend [radius]` — Self-Defense (Background)

```
Início
  meta.defendListener          = tick
  meta._defendHurtListener     = onHurt
  meta._defendPathUpdateListener = onPathUpdate
  activeMode NÃO é alterado

Loop (physicsTick, a cada 10 ticks; imediato ao receber dano)
  Estado 'idle':      não toca no pathfinder
  Estado 'fleeing':   GoalNear(ponto oposto ao creeper)
  Estado 'attacking': GoalFollow(mob, 1); ataca todo tick

  Ao retornar a 'idle':
    pathfinder.stop() + clearControlStates()
    meta.resumeCallback?.()   ← desbloqueia explore/farm (evita 30 s de espera)

Parada
  stopDefend() → remove os 3 listeners
```

**Não conflita com nada** (background). Pode coexistir com qualquer modo primário.
`getMode()` exibe como `<modo>+defend`.

---

### 3.6 `avoid <player...> [--radius N]`

```
Início
  meta.avoidListener = tick
  pathfinder.setMovements(...)

Loop (physicsTick, a cada 10 ticks)
  Se ameaça entrou no raio E não estava evitando:
    GoalBlock(30 blocos na direção oposta)
  Se ameaça saiu do raio E estava evitando:
    pathfinder.stop()

Parada
  stopAvoid()
```

**Leve conflito:** Pode sobrescrever goal de outros modos quando ameaça entra no raio.

---

### 3.7 `explore [n|s|e|w|auto]`

```
Início
  meta.exploringActive = true
  meta.activeMode      = 'explore:<dir>'

Loop (async while)
  Calcula alvo 200 blocos à frente
  await Promise:
    meta.resumeCallback = settle    ← defend chama isso ao voltar para idle
    pathfinder.setGoal(GoalXZ(x, z))
    goal_reached  → settle()
    timeout 30 s  → pathfinder.stop(); settle()
  Próxima leg

Parada suave
  stopExplore(): exploringActive = false; pathfinder.stop()
  → próximo ciclo do while sai; domainBot.setState(CONNECTED)
```

**Interrupção pelo defend:** quando defend volta ao idle, chama `meta.resumeCallback()` e o bot
imediatamente inicia a próxima leg, sem esperar os 30 s de timeout.

**Conflito:** qualquer `setGoal` externo (pvp, guard, bodyguard) sobrescreve o goal da leg atual.
O bot fica parado até o timeout de 30 s — a menos que `resumeCallback` seja chamado.

---

### 3.8 `farm <cx> <cz> [radius]`

```
Início
  meta.farmingActive = true
  meta.activeMode    = 'farm'

Loop (async while)
  Para cada tipo de plantação (wheat, carrots, potatoes, beetroots, nether_wart):
    Encontra culturas maduras
    GoalGetToBlock(cultura) → await goal_reached (ou 30 s timeout)
    Escava + replanta
  Se nenhuma cultura colhida: sleep 15 s

Parada suave
  stopFarm(): farmingActive = false
  → próximo ciclo do while sai
```

**Conflito igual ao explore:** qualquer `setGoal` externo interrompe a navegação até a planta.
Diferença: farm **não tem** `resumeCallback`, então demora até o timeout para retomar.

> **TODO:** Adicionar `resumeCallback` no farm igual ao explore.

---

### 3.9 `move <x> <y> <z>`

```
One-shot
  pathfinder.setGoal(GoalBlock(x, y, z))
  await goal_reached (ou 60 s timeout)
  Retorna
```

Não instala listener permanente. Se um modo contínuo chamar `setGoal` antes de `goal_reached`, o
`move` fica esperando o timeout silenciosamente.

---

### 3.10 `stop`

```
stopPvp()
stopGuard()
stopDefend()
stopAvoid()
stopFarm()
stopExplore()
physicsEnabled = true
pathfinder.stop()
clearControlStates()
activeMode = 'idle'
setState(CONNECTED)
```

Único comando que reseta **todos** os slots de uma vez.

---

## 4. Matriz de Interferência

`→` significa "ao iniciar X, Y é interrompido":

| Novo Modo | Interrompe |
|-----------|------------|
| `pvp` | `follow` (remove pvpListener) |
| `follow` | `pvp` (remove pvpListener) |
| `guard` | `bodyguard` (remove guardListener) |
| `bodyguard` | `guard` (remove guardListener) |
| `defend` | Nada (background) |
| `stop` | Tudo |
| Qualquer `setGoal` | Goal atual do `explore` e `farm` (forçam esperar timeout) |

### O que NÃO conflita (pode rodar junto)

- `defend` + qualquer modo primário
- `avoid` + qualquer modo primário (conflito suave de goal apenas quando ativa fuga)
- `explore` + `defend` (resolve via `resumeCallback`)
- `farm` + `defend` (parcial — defend retorna ao idle mas farm não tem resumeCallback ainda)

---

## 5. Propriedade do Pathfinder

O `mineflayer-pathfinder` só mantém **um goal ativo** por bot. Toda chamada a
`pathfinder.setGoal()` descarta o goal anterior.

```
Quem pode chamar setGoal:
  follow, pvp, guard, bodyguard → em loop contínuo (physicsTick)
  defend                        → só durante flee/attack
  avoid                         → só ao entrar/sair de raio
  explore, farm, collect, move  → dentro de await Promise
```

Quando um modo contínuo (pvp, guard) estiver ativo junto com um modo async (explore, farm),
o contínuo vence: seu `setGoal` no physicsTick sobrescreve qualquer goal do async.

---

## 6. SwarmIntel — Coordenação Entre Bots

Bus de eventos compartilhado. TTL dos sightings: **30 segundos**.

| Quem reporta | Quem consome |
|---|---|
| `pvp` | `pvp` (bots convergem para o alvo) |
| `bodyguard` | `bodyguard` (localiza ward fora de range) |

Modos que **não usam** intel: guard, defend, avoid, follow, explore, farm, collect.

---

## 7. BotMeta — Campos e Dono

```typescript
meta.pvpListener               // follow, pvp  — quem chegar por último vence
meta.followPathUpdateListener  // companheiro do pvpListener quando usado por follow()
meta.guardListener             // guard, bodyguard — quem chegar por último vence
meta.defendListener            // defend (background)
meta._defendHurtListener       // defend (entityHurt)
meta._defendPathUpdateListener // defend (path_update)
meta.avoidListener             // avoid
meta.farmingActive             // farm (flag de controle)
meta.exploringActive           // explore (flag de controle)
meta.resumeCallback            // preenchido por explore; chamado por defend ao voltar ao idle
meta.activeMode                // string de display no status/UI
```

---

## 8. Diagrama de Estados do Bot

```
IDLE
 └─ connect()
      ↓
CONNECTING
 └─ login event
      ↓
CONNECTED  ←─────────────────────────────────────────┐
 ├─ move/collect/pvp/follow/guard/farm/explore...     │
 │         ↓                                          │
 │      MOVING                                        │
 │         ├─ goal_reached / stop / timeout           │
 │         └────────────────────────────────────────→ ┘
 ├─ say / equip / eat  (rápido, não muda estado)
 ├─ error
 │         ↓
 │       ERROR
 └─ disconnect
           ↓
      DISCONNECTED
```

---

## 9. Problemas Conhecidos

| # | Problema | Impacto | Status |
|---|----------|---------|--------|
| 1 | `follow` e `pvp` compartilham slot — iniciar um remove o outro | Silencioso | Documentado |
| 2 | `guard` e `bodyguard` compartilham slot | Silencioso | Documentado |
| 3 | `farm` não tem `resumeCallback` → após defend, bot espera até 30 s | Lentidão | Pendente |
| 4 | Modos one-shot (`move`, `collect`) não são interrompíveis pelo `stop` durante o await | Bot ignora stop | Pendente |
| 5 | `avoid` pode sobrescrever goal de modos async sem notificar | Interrução silenciosa | Documentado |
| 6 | `stopExplore()` durante await pode deixar a Promise pendente por até 30 s | Lentidão | Parcialmente mitigado por resumeCallback |
