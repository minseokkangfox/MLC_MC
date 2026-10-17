import { system, world } from "@minecraft/server";
import { PREFIX, isAdmin } from "./util.js";
import "./commands.js";
import "./players.js";
import "./inbox.js";
import "./gamemode.js";
import "./cmdblock.js";
import "./spawn.js";
import "./bookban.js";
import "./dupe.js";
import "./mobcap.js";
import "./xray.js";

// 렐름에서는 아래 기능들을 서버가 켜지는 순간부터 돌리면 접속 단계에서 서버가 꺼졌음.
// 그래서 첫 플레이어가 들어오고 5초 뒤부터 2초 간격으로 하나씩 불러옴.
// (관리자 채팅에 진행 상황이 회색으로 뜨고, 문제가 생기면 몇 번째에서 멈췄는지 보임)
const LATE_MODULES = [
  "./ownership.js",
  "./wither.js", // 위더 + TNT + 테러 복구 (서로 묶여 있음)
  "./bans.js",
  "./reports.js",
  "./joinleave.js", // 접속 메시지 + 접속 로딩 화면
  "./silentadmin.js",
];

function tellAdmins(text) {
  try {
    for (const player of world.getAllPlayers()) if (isAdmin(player)) player.sendMessage(PREFIX + "§8" + text);
  } catch {}
}

let started = false;
function loadLateModules() {
  if (started) return;
  started = true;
  let index = 0;
  const next = () => {
    if (index >= LATE_MODULES.length) {
      import("./joinleave.js")
        .then((module) => module.handleEarlyPlayers())
        .catch(() => {});
      tellAdmins("모든 기능이 켜졌습니다.");
      return;
    }
    const path = LATE_MODULES[index++];
    tellAdmins(`기능 준비 중 ${index}/${LATE_MODULES.length}`);
    import(path)
      .catch((error) => tellAdmins(`§c기능 ${index} 불러오기 실패: ${error}`))
      .finally(() => system.runTimeout(next, 40));
  };
  system.runTimeout(next, 100);
}

world.afterEvents.playerSpawn.subscribe(({ initialSpawn }) => {
  if (initialSpawn) loadLateModules();
});
// 혹시 접속 이벤트를 놓쳐도 1분 뒤에는 불러옴
system.runTimeout(loadLateModules, 20 * 60);
