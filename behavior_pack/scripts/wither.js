import { system, world } from "@minecraft/server";
import { CONFIG } from "./config.js";
import { PREFIX } from "./util.js";
import { protectAround } from "./activity.js";

const BORN_KEY = "mlc:bornAt";
const SUMMONER_KEY = "mlc:summoner";
const DIMENSIONS = ["minecraft:overworld", "minecraft:nether", "minecraft:the_end"];
const KILL_KEY = "mlc:witherKill"; // 테러로 밴 당해서 위더를 없애야 하는 플레이어 id 목록

function killList() {
  try {
    return JSON.parse(String(world.getDynamicProperty(KILL_KEY) ?? "[]"));
  } catch {
    return [];
  }
}

/** 테러로 밴하면: 그 사람이 소환한 위더를 전부 제거 (지금 안 불러와진 위더도 나중에 불러와지면 제거) */
export function markWitherRemoval(playerId) {
  const list = killList();
  if (!list.includes(playerId)) {
    list.push(playerId);
    world.setDynamicProperty(KILL_KEY, JSON.stringify(list.slice(-200)));
  }
}

/** 밴이 풀리면 위더 제거 대상에서 뺌 */
export function clearWitherRemoval(playerId) {
  world.setDynamicProperty(KILL_KEY, JSON.stringify(killList().filter((id) => id !== playerId)));
}

/** 위더 또는 위더 해골의 주인(소환한 플레이어 id) */
export function witherOwner(entity) {
  try {
    if (!entity) return undefined;
    let wither = entity;
    if (entity.typeId.includes("wither_skull")) wither = entity.getComponent("minecraft:projectile")?.owner;
    if (wither?.typeId !== "minecraft:wither") return undefined;
    const owner = wither.getDynamicProperty(SUMMONER_KEY);
    return typeof owner === "string" ? owner : undefined;
  } catch {
    return undefined;
  }
}

// 위더를 소환한 사람 찾기: 위더 해골/영혼 모래를 마지막으로 놓은 사람
const recentPlacements = []; // { dimensionId, location, playerId, tick }

function formatRemaining(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function findPlayer(id) {
  return typeof id === "string" ? world.getAllPlayers().find((p) => p.id === id) : undefined;
}

world.afterEvents.playerPlaceBlock.subscribe(({ block, player, dimension }) => {
  const typeId = block.typeId;
  if (!typeId.includes("skull") && !typeId.includes("soul_sand") && !typeId.includes("soul_soil")) return;
  recentPlacements.push({ dimensionId: dimension.id, location: { ...block.location }, playerId: player.id, tick: system.currentTick });
  if (recentPlacements.length > 30) recentPlacements.shift();
});

function findSummoner(wither) {
  const now = system.currentTick;
  const loc = wither.location;
  for (let i = recentPlacements.length - 1; i >= 0; i--) {
    const p = recentPlacements[i];
    if (now - p.tick > 200 || p.dimensionId !== wither.dimension.id) continue;
    const dx = p.location.x - loc.x;
    const dy = p.location.y - loc.y;
    const dz = p.location.z - loc.z;
    if (dx * dx + dy * dy + dz * dz <= 64) return p.playerId;
  }
  return undefined;
}

world.afterEvents.entitySpawn.subscribe(({ entity }) => {
  if (entity.typeId !== "minecraft:wither") return;
  try {
    if (entity.getDynamicProperty(BORN_KEY) !== undefined) return;
    entity.setDynamicProperty(BORN_KEY, Date.now());
    const summonerId = findSummoner(entity);
    if (!summonerId) return;
    entity.setDynamicProperty(SUMMONER_KEY, summonerId);
    findPlayer(summonerId)?.sendMessage(
      PREFIX + `§c위더를 소환했습니다!§r ${formatRemaining(CONFIG.wither.maxLifeMs)} 안에 처치하지 못하면 사라집니다.`
    );
  } catch {}
});

// 매초: 소환한 사람 화면 아래에만 사라지기까지 남은 시간 표시.
// 소환 후 2시간 안에 못 잡으면 제거. remove()는 죽이는 게 아니라서 네더의 별이 떨어지지 않음.
// (시간은 실제 시간 기준이라 청크가 언로드돼 있던 시간도 포함)
system.runInterval(() => {
  const now = Date.now();
  const kill = killList();
  for (const id of DIMENSIONS) {
    let withers = [];
    try {
      withers = world.getDimension(id).getEntities({ type: "minecraft:wither" });
    } catch {}
    for (const wither of withers) {
      try {
        // 이전 버전에서 붙인 이름표 제거 (다른 사람에게도 보였음)
        if (wither.nameTag.startsWith("§c위더")) wither.nameTag = "";
        let bornAt = wither.getDynamicProperty(BORN_KEY);
        if (typeof bornAt !== "number") {
          // 애드온 설치 전에 있던 위더는 지금부터 계산
          bornAt = now;
          wither.setDynamicProperty(BORN_KEY, now);
        }
        const summonerId = wither.getDynamicProperty(SUMMONER_KEY);
        if (typeof summonerId === "string" && kill.includes(summonerId)) {
          wither.remove(); // 테러로 밴 당한 사람의 위더 (네더의 별 없음)
          continue;
        }
        // 위더가 부수기 전에 주변 지형 저장 (테러로 밴하면 위더가 부순 지형 복구)
        if (typeof summonerId === "string") protectAround(summonerId, wither.dimension, wither.location);
        const summoner = findPlayer(summonerId);
        const remaining = CONFIG.wither.maxLifeMs - (now - bornAt);
        if (remaining <= 0) {
          wither.remove();
          summoner?.sendMessage(PREFIX + "§c위더가 2시간 동안 처치되지 않아 사라졌습니다. (네더의 별 없음)");
          continue;
        }
        summoner?.onScreenDisplay.setActionBar(`§c위더 §f사라지기까지 §e${formatRemaining(remaining)}`);
      } catch {}
    }
  }
}, 20);
