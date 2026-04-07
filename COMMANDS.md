# Minecraft Bot Swarm — Commands

Commands can be sent via **console** (`swarm>` prompt) or **in-game chat** (only messages from `MASTER_USERNAME` are accepted).

---

## Targeting

Prefix any command with `@<target>` to send it to a subset of bots instead of all of them.

| Prefix | Targets |
|---|---|
| *(none)* | All online bots |
| `@all` | All online bots (explicit) |
| `@SwarmBot_3` | Single bot by username |
| `@1-5` | Bots whose username ends in `_1` through `_5` |
| `@builders` | Named group called `builders` |
| `@SwarmBot_1,SwarmBot_2` | Comma-separated list of usernames |

**Examples:**
```
@1-3 move 100 64 200        — only SwarmBot_1, 2, 3 move
@defenders defend 8         — only the "defenders" group enters defend mode
@SwarmBot_5 follow Player1  — only SwarmBot_5 follows
```

---

## Movement

| Command | Description |
|---|---|
| `move <x> <y> <z>` | All bots navigate to the given coordinates |
| `follow <player>` | All bots follow a player (waits for them to appear if not visible yet) |
| `stop` | Stops all active modes: movement, pvp, guard, defend, farm, explore, avoid |

---

## Chat

| Command | Description |
|---|---|
| `say <message>` | All bots send a chat message simultaneously |

---

## Combat

| Command | Description |
|---|---|
| `attack <player>` | All bots hit the player once |
| `pvp <player> [player2 ...]` | Continuous mode — bots chase and attack the listed players. If a bot spots a target, it broadcasts the coordinates to all other bots so they can converge |
| `attack-list [file]` | Same as `pvp` but reads targets from `targets.txt` (or a custom file) |
| `guard <x> <y> <z> [radius]` | Bots go to position and attack any player that enters the radius (default: 10) |
| `defend <player> [radius]` | **Bodyguard mode** — bots follow the player and attack any mob or hostile player that comes within radius of them (default: 6) |
| `defend [radius]` | **Self-defense mode** — background listener that auto-attacks nearby mobs and flees creepers (default: 8). Stacks with other modes |
| `defend off` | Disables both bodyguard and self-defense |
| `avoid <player> [player2 ...] [--radius N]` | Bots flee when a listed player comes within radius (default: 20) |

---

## Resource Collection

| Command | Description |
|---|---|
| `collect <block> [count]` | All bots mine the nearest blocks of that type (default count: 1) |
| `collect <block> [count] --vein` | Same, but also mines all connected blocks of the same type (vein mining) |
| `quarry <x1> <y1> <z1> <x2> <y2> <z2>` | Mines every block in the defined cuboid, top-down, distributed among all bots |
| `farm <centerX> <centerZ> [radius]` | Bots continuously harvest fully-grown crops and replant seeds within the area (default radius: 30). Runs until `stop` |

### Block name examples
```
stone, dirt, grass_block, oak_log, diamond_ore, deepslate_diamond_ore,
iron_ore, coal_ore, gravel, sand, wheat, carrots, potatoes
```

---

## Building

| Command | Description |
|---|---|
| `build <file.schem> <x> <y> <z>` | Loads a Sponge Schematic v2 (`.schem`) and builds it at the given coordinates. Bots share a work queue — each takes the next pending block. If a bot is missing a block, it defers the task and auto-collects from nearby world blocks, then retries (up to 5 passes) |

### Schematic format
- Export from **WorldEdit** (`//schem save`) or **Litematica** (export as `.schem`)
- Place the file in the project root or pass a relative path

---

## Inventory

| Command | Description |
|---|---|
| `equip <item>` | All bots equip the named item to their main hand |
| `eat` | All bots eat the highest food-value item in their inventory |

### Item name examples
```
diamond_sword, bow, shield, cooked_beef, bread, golden_apple
```

---

## Exploration

| Command | Description |
|---|---|
| `explore [direction]` | Bots move 200 blocks at a time in the given direction, indefinitely. Direction: `north`, `south`, `east`, `west`, `auto` (random). Runs until `stop` |

---

## Relationships

Controls which players are attacked in `pvp`, `guard`, `defend`, and `bodyguard` modes. Saved automatically to `relationships.json`.

| Command | Description |
|---|---|
| `friend add <player>` | Add to friend list — never attacked by any mode |
| `friend remove <player>` | Remove from friend list (becomes neutral) |
| `friend list` | Show current friends |
| `enemy add <player>` | Add to enemy list — always attacked |
| `enemy remove <player>` | Remove from enemy list (becomes neutral) |
| `enemy list` | Show current enemies |
| `neutral ignore` | Never attack neutral players (default) |
| `neutral attack` | Treat neutral players like enemies (open pvp) |
| `neutral armed` | Attack neutral players who are visibly holding a weapon |
| `relations` | Show friends, enemies, and current neutral mode |

### Relationship priority
```
friend  →  never attacked (overrides all combat modes)
enemy   →  always attacked
neutral →  depends on "neutral" setting (ignore / attack / armed)
```

---

## Groups

Named groups let you address a subset of bots by a friendly alias. Groups persist across restarts in `groups.json`.

| Command | Description |
|---|---|
| `group create <name>` | Create an empty group |
| `group delete <name>` | Remove a group |
| `group add <name> <bot1> [bot2 ...]` | Add bots to a group |
| `group remove <name> <bot1> [bot2 ...]` | Remove bots from a group |
| `group list` | List all groups and their members |
| `group members <name>` | Show members of a specific group |

**Example workflow:**
```
group create builders
group add builders SwarmBot_1 SwarmBot_2 SwarmBot_3
group create fighters
group add fighters SwarmBot_4 SwarmBot_5

@builders build house.schem 0 64 0
@fighters defend 8
```

---

## Swarm Management

| Command | Description |
|---|---|
| `spawn <n>` | Adds `n` more bots to the running swarm without disconnecting existing ones |
| `status` | Prints each bot's current state (IDLE, CONNECTED, MOVING, etc.) and online count |
| `quit` / `exit` | Disconnects all bots and exits the process |
| `help` | Prints the short command reference in the console |

---

## Configuration (`.env`)

| Variable | Default | Description |
|---|---|---|
| `MC_HOST` | `localhost` | Server IP or hostname |
| `MC_PORT` | `25565` | Server port |
| `MC_VERSION` | `1.20.1` | Minecraft version (`auto` for auto-detect) |
| `BOT_COUNT` | `10` | Number of bots to spawn on startup |
| `BOT_USERNAME_PREFIX` | `SwarmBot` | Bots will be named `SwarmBot_1`, `SwarmBot_2`, etc. |
| `BOT_SPAWN_DELAY_MS` | `1500` | Delay between each bot connecting (ms) |
| `CONNECTION_MODE` | `direct` | `direct` or `proxy` |
| `PROXY_FILE` | `proxies.txt` | Path to SOCKS5 proxy list |
| `MASTER_USERNAME` | `Herobrine` | Only this player's chat messages are treated as commands |

---

## Files

| File | Purpose |
|---|---|
| `.env` | Runtime configuration |
| `proxies.txt` | One `socks5://user:pass@host:port` per line |
| `targets.txt` | One username per line — used by `attack-list` |
| `*.schem` | Sponge v2 schematic files for the `build` command |
