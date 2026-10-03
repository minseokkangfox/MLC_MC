import { system, world } from "@minecraft/server";
import { CONFIG } from "./config.js";
import { broadcast } from "./util.js";

const BORN_KEY = "mlc:bornAt";
const DIMENSIONS = ["minecraft:overworld", "minecraft:nether", "minecraft:the_end"];
const ACTIONBAR_RANGE = 96;

function formatRemaining(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

world.afterEvents.entitySpawn.subscribe(({ entity }) => {
  if (entity.typeId !== "minecraft:wither") return;
  try {
    if (entity.getDynamicProperty(BORN_KEY) === undefined) entity.setDynamicProperty(BORN_KEY, Date.now());
    broadcast(`§c위더가 소환되었습니다!§r ${formatRemaining(CONFIG.wither.maxLifeMs)} 안에 처치하지 못하면 사라집니다.`);
  } catch {}
});

// 매초: 위더 이름(보스바)과 근처 플레이어 화면 아래에 사라지기까지 남은 시간 표시.
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
        let bornAt = wither.getDynamicProperty(BORN_KEY);
        if (typeof bornAt !== "number") {
          // 애드온 설치 전에 있던 위더는 지금부터 계산
          bornAt = now;
          wither.setDynamicProperty(BORN_KEY, now);
        }
        const remaining = CONFIG.wither.maxLifeMs - (now - bornAt);
        if (remaining <= 0) {
          wither.remove();
          broadcast("§c위더가 2시간 동안 처치되지 않아 사라졌습니다. (네더의 별 없음)");
          continue;
        }
        const text = `§c위더 §f사라지기까지 §e${formatRemaining(remaining)}`;
        wither.nameTag = text;
        const nearby = wither.dimension.getPlayers({ location: wither.location, maxDistance: ACTIONBAR_RANGE });
        for (const player of nearby) player.onScreenDisplay.setActionBar(text);
      } catch {}
    }
  }
}, 20);
