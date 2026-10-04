import { system, world } from "@minecraft/server";
import { ActionFormData } from "@minecraft/server-ui";
import { CONFIG } from "./config.js";
import { PREFIX, isAdmin } from "./util.js";
import { showForm } from "./forms.js";
import { isBanned } from "./bans.js";
import { afterLoading, isLongAbsence } from "./welcome.js";
import { WELCOME_BACK_CHAT } from "./greetings.js";

// 게임 기본 접속/퇴장 메시지는 리소스 팩(MLC 리소스)에서 빈 칸으로 바꿔 숨기고,
// 같은 문구를 애드온이 대신 보냄. 그래서 관리자는 "조용히" 를 고르면 아무도 접속을 모름.
// 밴 당해서 들어오자마자 kick 되는 플레이어도 메시지를 띄우지 않음.

const silent = new Set(); // 조용히 접속한 관리자 id
const INVISIBLE_TICKS = 20 * 60 * 10;

function announce(key, name) {
  const suffix = CONFIG.joinMessage.realms ? ".realms" : "";
  world.sendMessage({ rawtext: [{ text: "§e" }, { translate: `mlc.player.${key}${suffix}`, with: [name] }] });
}

/** 접속 메시지: 3일 넘게 안 왔던 플레이어는 "오랜만에 ~님이 오셨어요" 같은 반기는 말 중 랜덤 */
function announceJoin(player) {
  if (isLongAbsence(player)) {
    const line = WELCOME_BACK_CHAT[Math.floor(Math.random() * WELCOME_BACK_CHAT.length)];
    world.sendMessage("§e" + line.split("{name}").join(player.name));
    return;
  }
  announce("joined", player.name);
}

function goInvisible(player) {
  try {
    player.addEffect("invisibility", INVISIBLE_TICKS, { showParticles: false });
  } catch {}
}

export function revealAdmin(player) {
  silent.delete(player.id);
  try {
    player.removeEffect("invisibility");
  } catch {}
  announceJoin(player);
}

export function hideAdmin(player) {
  silent.add(player.id);
  goInvisible(player);
}

export function isSilent(player) {
  return silent.has(player.id);
}

async function askAdmin(player) {
  const form = new ActionFormData()
    .title("접속 알림")
    .body("다른 플레이어에게 접속했다고 알릴까요?\n\n§7조용히: 접속/퇴장 메시지가 안 뜨고 투명 상태가 됩니다.\n나중에 /mlc 공개 로 알릴 수 있습니다.")
    .button("§2알리기")
    .button("§8조용히");
  const response = await showForm(player, form);
  if (!player.isValid) return;
  if (response && !response.canceled && response.selection === 0) {
    revealAdmin(player);
  } else {
    player.sendMessage(PREFIX + "§7조용히 접속 중입니다. (투명) §e/mlc 공개§7 로 접속을 알릴 수 있습니다.");
  }
}

world.afterEvents.playerSpawn.subscribe(({ player, initialSpawn }) => {
  if (!initialSpawn) return;
  if (isBanned(player)) return;
  if (isAdmin(player)) {
    // 고를 때까지는 조용히 + 투명
    hideAdmin(player);
    // 접속 로딩 화면이 끝난 뒤에 물어봄
    system.runTimeout(() => {
      if (player.isValid) afterLoading(player, () => askAdmin(player).catch(() => {}));
    }, 20);
    return;
  }
  announceJoin(player);
});

world.beforeEvents.playerLeave.subscribe(({ player }) => {
  const name = player.name;
  const id = player.id;
  const quiet = silent.has(id) || isBanned(player);
  silent.delete(id);
  if (!quiet) system.run(() => announce("left", name));
});

// 조용히 접속한 관리자는 계속 투명
system.runInterval(() => {
  for (const player of world.getAllPlayers()) {
    if (silent.has(player.id)) goInvisible(player);
  }
}, 20 * 60 * 5);
