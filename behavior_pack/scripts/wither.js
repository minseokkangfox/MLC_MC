import { system, world } from "@minecraft/server";
import { CONFIG } from "./config.js";
import { PREFIX } from "./util.js";

const BORN_KEY = "mlc:bornAt";
const SUMMONER_KEY = "mlc:summoner";
const DIMENSIONS = ["minecraft:overworld", "minecraft:nether", "minecraft:the_end"];

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
        const summoner = findPlayer(wither.getDynamicProperty(SUMMONER_KEY));
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
