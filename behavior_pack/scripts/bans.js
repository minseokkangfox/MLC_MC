import { system, world } from "@minecraft/server";
import { ActionFormData, ModalFormData } from "@minecraft/server-ui";
import { CONFIG } from "./config.js";
import { PREFIX, isAdmin } from "./util.js";
import { PLAYER_ICON, formatTime, playerButtonText, showForm } from "./forms.js";
import { findOnlinePlayer, getKnownPlayers } from "./players.js";
import { startRollback } from "./activity.js";

const BAN_PREFIX = "mlc:ban:";
const ROLLBACK_CATEGORY = "테러";
const KICK_DELAY_TICKS = 200;

const normalize = (name) => String(name).toLowerCase().replace(/\s+/g, "");

/** @type {Map<string, { id: string, name: string, category: string, reason: string, by: string, time: number }> | undefined} 저장 키 -> 밴 정보 */
let banCache;

function loadBans() {
  if (banCache) return banCache;
  banCache = new Map();
  for (const key of world.getDynamicPropertyIds()) {
    if (!key.startsWith(BAN_PREFIX)) continue;
    try {
      banCache.set(key, JSON.parse(String(world.getDynamicProperty(key))));
    } catch {}
  }
  return banCache;
}

export function getBans() {
  return [...loadBans().values()].sort((a, b) => b.time - a.time);
}

/** 플레이어 id 또는 이름(대소문자/띄어쓰기 무시)으로 밴 찾기 */
function findBan(player) {
  const name = normalize(player.name);
  for (const ban of loadBans().values()) {
    if (ban.id === player.id || normalize(ban.name) === name) return ban;
  }
  return undefined;
}

/** 같은 id 또는 같은 이름으로 저장된 밴을 전부 삭제 */
export function unbanPlayer(ban) {
  const name = normalize(ban.name);
  for (const [key, other] of [...loadBans()]) {
    if (other.id === ban.id || normalize(other.name) === name) {
      world.setDynamicProperty(key, undefined);
      banCache.delete(key);
    }
  }
}

function banText(ban) {
  const reason = ban.reason ? ` (${ban.reason})` : "";
  return `§c서버 규칙을 위반 했습니다.§r (${ban.category}) 를 위반${reason} §7이 밴에 문제가 있으면 관리자에게 문의하세요 §b${CONFIG.ban.discord}`;
}

function kick(player, ban) {
  const name = player.name.replace(/"/g, "");
  try {
    world.getDimension("minecraft:overworld").runCommand(`kick "${name}" ${banText(ban)}`);
  } catch {}
}

const pending = new Set(); // 밴 이유를 보여주고 내보내기를 기다리는 플레이어 id

export function isBanPending(player) {
  return pending.has(player.id);
}

/** 밴 이유를 화면/채팅/창으로 확실히 보여준 뒤 내보냄 */
function removeBannedPlayer(player, ban) {
  if (pending.has(player.id) || isAdmin(player)) return;
  pending.add(player.id);
  const id = player.id;
  try {
    for (const effect of ["blindness", "slowness", "mining_fatigue", "weakness"]) {
      player.addEffect(effect, KICK_DELAY_TICKS + 100, { amplifier: 255, showParticles: false });
    }
    player.onScreenDisplay.setTitle("§c밴 당했습니다", { subtitle: `§f(${ban.category}) 위반`, fadeInDuration: 0, stayDuration: KICK_DELAY_TICKS, fadeOutDuration: 10 });
    player.sendMessage(banText(ban));
  } catch {}
  let kicked = false;
  const kickOnce = () => {
    if (kicked) return;
    kicked = true;
    pending.delete(id);
    if (player.isValid) kick(player, ban);
  };
  const form = new ActionFormData()
    .title("§c서버 이용이 제한되었습니다")
    .body(
      `§c서버 규칙을 위반 했습니다.§r\n\n§e카테고리:§r ${ban.category}\n§e이유:§r ${ban.reason || "(없음)"}\n§e날짜:§r ${formatTime(ban.time)}\n\n` +
        `이 밴에 문제가 있으면 관리자에게 문의하세요\n§b${CONFIG.ban.discord}`
    )
    .button("확인");
  showForm(player, form)
    .then(() => system.runTimeout(kickOnce, 20))
    .catch(() => {});
  system.runTimeout(kickOnce, KICK_DELAY_TICKS);
}

// 밴 당한 플레이어가 기다리는 동안 아무것도 못 하게
world.beforeEvents.playerInteractWithBlock.subscribe((event) => {
  if (pending.has(event.player.id)) event.cancel = true;
});
world.beforeEvents.playerBreakBlock.subscribe((event) => {
  if (pending.has(event.player.id)) event.cancel = true;
});
world.beforeEvents.itemUse.subscribe((event) => {
  if (pending.has(event.source.id)) event.cancel = true;
});

// 밴 당한 플레이어는 접속하면 이유를 보여주고 내보냄 (혹시 몰라 주기적으로도 확인)
world.afterEvents.playerSpawn.subscribe(({ player, initialSpawn }) => {
  if (!initialSpawn) return;
  const ban = findBan(player);
  if (ban) removeBannedPlayer(player, ban);
});

system.runInterval(() => {
  for (const player of world.getAllPlayers()) {
    const ban = findBan(player);
    if (ban) removeBannedPlayer(player, ban);
  }
}, 100);

world.afterEvents.playerLeave.subscribe(({ playerId }) => pending.delete(playerId));

export function banPlayer(admin, target, category, reason) {
  const ban = {
    id: target.id,
    name: target.name,
    category,
    reason: reason.trim().slice(0, 200),
    by: admin.name,
    time: Date.now(),
  };
  world.setDynamicProperty(BAN_PREFIX + target.id, JSON.stringify(ban));
  loadBans().set(BAN_PREFIX + target.id, ban);
  let message = `§e${target.name}§r 를 밴했습니다. (${category}${ban.reason ? ` - ${ban.reason}` : ""})`;
  if (category === ROLLBACK_CATEGORY) {
    const count = startRollback(target.id, target.name);
    message += `\n최근 ${CONFIG.rollback.hours}시간 행동 ${count}개를 되돌립니다.`;
  }
  const online = findOnlinePlayer(target.id);
  if (online) removeBannedPlayer(online, ban);
  admin.sendMessage(PREFIX + message);
}

/** 밴 카테고리/이유 입력 창 */
export async function showBanDetails(admin, target, defaultCategory) {
  const categories = CONFIG.ban.categories;
  const defaultIndex = Math.max(0, categories.indexOf(defaultCategory));
  const form = new ModalFormData()
    .title(`${target.name} 밴`)
    .dropdown(`밴 카테고리 (§c${ROLLBACK_CATEGORY}§r 선택 시 최근 ${CONFIG.rollback.hours}시간 행동 전부 되돌림)`, categories, {
      defaultValueIndex: defaultIndex,
    })
    .textField("이유 (안 써도 됩니다)", "예: 스폰 건물 파괴")
    .submitButton("§c밴하기");
  const response = await showForm(admin, form);
  if (!response || response.canceled || !response.formValues) return false;
  const [categoryIndex, reason] = response.formValues;
  banPlayer(admin, target, categories[Number(categoryIndex)] ?? categories[0], String(reason ?? ""));
  return true;
}

/** /밴 : 접속 중 + 나간 플레이어 목록에서 선택 */
export async function openBanMenu(admin) {
  const banned = new Set(getBans().map((b) => b.id));
  const players = getKnownPlayers().filter((p) => p.id !== admin.id && !banned.has(p.id) && !isAdmin(p));
  if (players.length === 0) {
    admin.sendMessage(PREFIX + "밴할 수 있는 플레이어가 없습니다.");
    return;
  }
  const form = new ActionFormData().title("플레이어 밴").body("밴할 플레이어를 선택하세요.\n위: 접속 중 / 아래: 나간 플레이어");
  for (const p of players) form.button(playerButtonText(p), PLAYER_ICON);
  const response = await showForm(admin, form);
  if (!response || response.canceled || response.selection === undefined) return;
  await showBanDetails(admin, players[response.selection]);
}

/** /밴해제 : 밴 목록 -> 이유 확인 -> 해제 */
export async function openUnbanMenu(admin) {
  while (admin.isValid) {
    const bans = getBans();
    if (bans.length === 0) {
      admin.sendMessage(PREFIX + "밴 당한 플레이어가 없습니다.");
      return;
    }
    const list = new ActionFormData().title("밴 해제").body(`밴 당한 플레이어 ${bans.length}명`);
    for (const ban of bans) list.button(`§4${ban.name}\n§8${ban.category} · ${formatTime(ban.time)}`, PLAYER_ICON);
    const picked = await showForm(admin, list);
    if (!picked || picked.canceled || picked.selection === undefined) return;
    const ban = bans[picked.selection];

    const detail = new ActionFormData()
      .title(`${ban.name} 밴 정보`)
      .body(
        `§e플레이어:§r ${ban.name}\n§e카테고리:§r ${ban.category}\n§e이유:§r ${ban.reason || "(없음)"}\n` +
          `§e밴한 관리자:§r ${ban.by}\n§e날짜:§r ${formatTime(ban.time)}`
      )
      .button("§a밴 해제")
      .button("뒤로");
    const action = await showForm(admin, detail);
    if (!action || action.canceled) return;
    if (action.selection === 0) {
      unbanPlayer(ban);
      admin.sendMessage(PREFIX + `§e${ban.name}§r 의 밴을 해제했습니다.`);
      return;
    }
  }
}
