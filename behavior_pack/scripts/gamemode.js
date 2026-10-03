import { GameMode, system, world } from "@minecraft/server";
import { CONFIG } from "./config.js";
import { formatLocation, isAdmin, notifyAdmins, shortDimension } from "./util.js";
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

const lastWarn = new Map();

function reportBlockedChange(player, toGameMode) {
  const now = system.currentTick;
  if (now - (lastWarn.get(player.name) ?? -1000) < 200) return;
  lastWarn.set(player.name, now);
  notifyAdmins(
    `§e${player.name}§r 의 게임모드가 §c${toGameMode}§r(으)로 바뀌려던 것을 막았습니다. ` +
      `위치: ${shortDimension(player.dimension.id)} ${formatLocation(player.location)} - 근처 커맨드 블록을 검사합니다.`
  );
  requestUrgentScan();
}

// 다른 곳(커맨드 블록 등)에서 게임모드를 바꾸려고 하면 바로 취소
world.beforeEvents.playerGameModeChange.subscribe((event) => {
  if (event.toGameMode === GameMode.Survival) return;
  if (!isForceSurvival() || isAdmin(event.player)) return;
  event.cancel = true;
  const { player, toGameMode } = event;
  system.run(() => {
    if (player.isValid) reportBlockedChange(player, toGameMode);
  });
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
        reportBlockedChange(player, mode);
      }
    } catch {
      // 플레이어가 막 나간 경우 등
    }
  }
}, CONFIG.gamemode.checkIntervalTicks);
