import { system, world } from "@minecraft/server";
import { CONFIG } from "./config.js";
import { broadcast } from "./util.js";

const BORN_KEY = "mlc:bornAt";
const DIMENSIONS = ["minecraft:overworld", "minecraft:nether", "minecraft:the_end"];

world.afterEvents.entitySpawn.subscribe(({ entity }) => {
  if (entity.typeId !== "minecraft:wither") return;
  try {
    if (entity.getDynamicProperty(BORN_KEY) === undefined) entity.setDynamicProperty(BORN_KEY, Date.now());
  } catch {}
});

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
        const bornAt = wither.getDynamicProperty(BORN_KEY);
        if (typeof bornAt !== "number") {
          // 애드온 설치 전에 있던 위더는 지금부터 계산
          wither.setDynamicProperty(BORN_KEY, now);
          continue;
        }
        if (now - bornAt >= CONFIG.wither.maxLifeMs) {
          wither.remove();
          broadcast("§c위더가 2시간 동안 처치되지 않아 사라졌습니다. (네더의 별 없음)");
        }
      } catch {}
    }
  }
}, CONFIG.wither.checkIntervalTicks);
