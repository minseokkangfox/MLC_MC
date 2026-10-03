import { GameMode, system, world } from "@minecraft/server";
import { CONFIG } from "./config.js";
import { isAdmin } from "./util.js";
import { requestUrgentScan } from "./cmdblock.js";

const FORCE_KEY = "mlc:forceSurvival";

export function isForceSurvival() {
  try {
    return world.getDynamicProperty(FORCE_KEY) === true;
  } catch {
    return false;
  }
}

export function setForceSurvival(enabled) {
  world.setDynamicProperty(FORCE_KEY, enabled);
}

let lastScanRequest = -1000;

// 게임모드가 바뀌려 하면 근처 커맨드 블록을 즉시 다시 검사 (메시지는 띄우지 않음)
function onBlockedChange() {
  const now = system.currentTick;
  if (now - lastScanRequest < 200) return;
  lastScanRequest = now;
  requestUrgentScan();
}

// 다른 곳(커맨드 블록 등)에서 게임모드를 바꾸려고 하면 바로 취소
world.beforeEvents.playerGameModeChange.subscribe((event) => {
  if (event.toGameMode === GameMode.Survival) return;
  if (!isForceSurvival() || isAdmin(event.player)) return;
  event.cancel = true;
  system.run(onBlockedChange);
});

// 취소가 버그로 안 될 경우를 대비해 계속 서바이벌로 되돌림
system.runInterval(() => {
  if (!isForceSurvival()) return;
  for (const player of world.getAllPlayers()) {
    if (isAdmin(player)) continue;
    try {
      const mode = player.getGameMode();
      if (mode !== GameMode.Survival) {
        player.setGameMode(GameMode.Survival);
        onBlockedChange();
      }
    } catch {
      // 플레이어가 막 나간 경우 등
    }
  }
}, CONFIG.gamemode.checkIntervalTicks);
