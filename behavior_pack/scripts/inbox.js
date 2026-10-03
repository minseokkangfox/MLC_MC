import { system, world } from "@minecraft/server";
import { PREFIX, isAdmin } from "./util.js";
import { VERSION } from "./config.js";

// 관리자가 접속했을 때만 보여줄 메시지 보관함
const KEY = "mlc:adminInbox";
const MAX = 30;
const providers = [];

export function queueAdminNotice(message) {
  let list = [];
  try {
    list = JSON.parse(String(world.getDynamicProperty(KEY) ?? "[]"));
  } catch {}
  list.push(message);
  world.setDynamicProperty(KEY, JSON.stringify(list.slice(-MAX)));
}

/** 관리자 접속 시 추가로 보여줄 요약 줄을 돌려주는 함수 등록 */
export function addJoinSummary(provider) {
  providers.push(provider);
}

function showInbox(player) {
  const lines = [];
  for (const provider of providers) {
    try {
      const line = provider();
      if (line) lines.push(line);
    } catch {}
  }
  let list = [];
  try {
    list = JSON.parse(String(world.getDynamicProperty(KEY) ?? "[]"));
  } catch {}
  if (list.length > 0) {
    lines.push(`§7관리자 알림 ${list.length}건:`);
    for (const message of list) lines.push(" §7- §r" + message);
    world.setDynamicProperty(KEY, undefined);
  }
  player.sendMessage(PREFIX + `§7v${VERSION} 작동 중` + (lines.length > 0 ? "\n관리자 알림\n" + lines.join("\n") : ""));
}

world.afterEvents.playerSpawn.subscribe(({ player, initialSpawn }) => {
  if (!initialSpawn || !isAdmin(player)) return;
  system.runTimeout(() => {
    if (player.isValid) showInbox(player);
  }, 60);
});
