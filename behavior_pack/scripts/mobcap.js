import { EntityInitializationCause, system, world } from "@minecraft/server";
import { CONFIG } from "./config.js";

// 플레이어 1명당 몹 수 제한 (몹 공장 렉 방지)
// 플레이어 주변(반경 radius 칸)에 있는 몹이 perPlayer 마리 이상이면, 그 근처에서는 새 몹이 생기지 않음
// (자연 스폰, 스포너, 번식, 알 등 전부). 이미 있는 몹은 그대로 둠.

const cfg = CONFIG.mobCap;
const DIMENSIONS = ["minecraft:overworld", "minecraft:nether", "minecraft:the_end"];
const IGNORE = new Set([
  "minecraft:player",
  "minecraft:item",
  "minecraft:xp_orb",
  "minecraft:arrow",
  "minecraft:armor_stand",
  "minecraft:painting",
  "minecraft:minecart",
  "minecraft:boat",
  "minecraft:chest_boat",
  "minecraft:tnt",
  "minecraft:falling_block",
  "minecraft:wither", // 보스는 제한하지 않음
  "minecraft:ender_dragon",
]);

const counts = new Map(); // 플레이어 id -> 주변 몹 수

function isMob(entity) {
  if (IGNORE.has(entity.typeId)) return false;
  try {
    return !!entity.getComponent("minecraft:health");
  } catch {
    return false;
  }
}

function nearestPlayer(entity) {
  let best;
  let bestDistance = cfg.radius * cfg.radius;
  for (const player of world.getAllPlayers()) {
    if (player.dimension.id !== entity.dimension.id) continue;
    const dx = player.location.x - entity.location.x;
    const dz = player.location.z - entity.location.z;
    const d = dx * dx + dz * dz;
    if (d <= bestDistance) {
      bestDistance = d;
      best = player;
    }
  }
  return best;
}

// 2초마다 플레이어별 주변 몹 수 세기
system.runInterval(() => {
  if (!cfg.enabled) return;
  counts.clear();
  for (const id of DIMENSIONS) {
    const players = world.getAllPlayers().filter((p) => p.dimension.id === id);
    if (players.length === 0) continue;
    for (const player of players) {
      let n = 0;
      try {
        for (const entity of player.dimension.getEntities({ location: player.location, maxDistance: cfg.radius })) {
          if (isMob(entity)) n++;
        }
      } catch {}
      counts.set(player.id, n);
    }
  }
}, 40);

world.afterEvents.entitySpawn.subscribe(({ entity, cause }) => {
  if (!cfg.enabled || cause === EntityInitializationCause.Loaded) return; // 청크가 다시 불러와진 몹은 제외
  try {
    if (!entity.isValid || !isMob(entity)) return;
    const player = nearestPlayer(entity);
    if (!player) return;
    const n = counts.get(player.id) ?? 0;
    if (n >= cfg.perPlayer) {
      entity.remove();
      return;
    }
    counts.set(player.id, n + 1);
  } catch {}
});

export function mobCount(player) {
  return counts.get(player.id) ?? 0;
}
