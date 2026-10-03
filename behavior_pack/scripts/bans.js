import { InputPermissionCategory, system, world } from "@minecraft/server";
import { ActionFormData, ModalFormData } from "@minecraft/server-ui";
import { CONFIG } from "./config.js";
import { PREFIX, isAdmin } from "./util.js";
import { PLAYER_ICON, formatTime, playerButtonText, showForm } from "./forms.js";
import { findOnlinePlayer, getKnownPlayers } from "./players.js";
import { startRollback } from "./activity.js";

const BAN_PREFIX = "mlc:ban:";
const ROLLBACK_CATEGORY = "테러";

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

// 스크립트가 서버(호스트) 이름으로 /kick 을 실행하면 "호스트에 의해 차단" 으로 처리되어
// 렐름이 다시 켜질 때까지 못 들어오는 것으로 보임. 관리자가 직접 /kick 하는 것처럼
// 플레이어(접속 중인 관리자, 없으면 밴 당한 본인)를 명령어 실행 주체로 해서 kick.
const lastKick = new Map(); // 플레이어 id -> 틱 (같은 사람을 연달아 여러 번 kick 하지 않도록)

function kick(player, ban) {
  const now = system.currentTick;
  if (now - (lastKick.get(player.id) ?? -1000) < 40) return;
  lastKick.set(player.id, now);
  const name = player.name.replace(/"/g, "");
  const command = `kick "${name}" ${banText(ban)}`;
  const admin = world.getAllPlayers().find((p) => isAdmin(p));
  for (const source of [admin, player]) {
    if (!source) continue;
    try {
      if (source.runCommand(command).successCount > 0) return;
    } catch {}
  }
  try {
    world.getDimension("minecraft:overworld").runCommand(command);
  } catch {}
}

// ban.useKick 이 false 일 때: kick 대신 "잠금" (접속은 되지만 못 움직이고 아무것도 못 하며 화면에 밴 이유가 계속 뜸).
// 밴을 풀면 바로 원래 자리로 돌아가 다시 플레이할 수 있음.
const JAIL_PREFIX = "mlc:jail:";
const LOCK_EFFECTS = ["blindness", "invisibility", "resistance", "slowness", "mining_fatigue", "weakness"];
const locked = new Set();

function lock(player, ban) {
  if (!locked.has(player.id)) {
    locked.add(player.id);
    if (world.getDynamicProperty(JAIL_PREFIX + player.id) === undefined) {
      const { x, y, z } = player.location;
      world.setDynamicProperty(JAIL_PREFIX + player.id, JSON.stringify({ dimension: player.dimension.id, x, y, z }));
    }
    player.sendMessage(banText(ban));
  }
  try {
    player.inputPermissions.setPermissionCategory(InputPermissionCategory.Movement, false);
  } catch {}
  for (const effect of LOCK_EFFECTS) {
    try {
      player.addEffect(effect, 200, { amplifier: 255, showParticles: false });
    } catch {}
  }
  const reason = ban.reason ? ` (${ban.reason})` : "";
  player.onScreenDisplay.setTitle("§c서버 규칙을 위반 했습니다", {
    subtitle: `§f(${ban.category}) 를 위반${reason}`,
    fadeInDuration: 0,
    stayDuration: 100,
    fadeOutDuration: 0,
  });
  player.onScreenDisplay.setActionBar(`§7이 밴에 문제가 있으면 관리자에게 문의하세요 §b${CONFIG.ban.discord}`);
}

function release(player) {
  locked.delete(player.id);
  try {
    player.inputPermissions.setPermissionCategory(InputPermissionCategory.Movement, true);
  } catch {}
  for (const effect of LOCK_EFFECTS) {
    try {
      player.removeEffect(effect);
    } catch {}
  }
  try {
    player.runCommand("title @s clear");
  } catch {}
  try {
    const saved = JSON.parse(String(world.getDynamicProperty(JAIL_PREFIX + player.id)));
    player.teleport({ x: saved.x, y: saved.y, z: saved.z }, { dimension: world.getDimension(saved.dimension) });
  } catch {}
  world.setDynamicProperty(JAIL_PREFIX + player.id, undefined);
  player.sendMessage(PREFIX + "§a밴이 해제되었습니다. 다시 플레이할 수 있습니다.");
}

function enforce(player) {
  if (isAdmin(player)) return;
  const ban = findBan(player);
  if (ban) {
    if (CONFIG.ban.useKick) kick(player, ban);
    else lock(player, ban);
  } else if (locked.has(player.id) || world.getDynamicProperty(JAIL_PREFIX + player.id) !== undefined) {
    release(player);
  }
}

// 잠긴 플레이어는 블럭/아이템/엔티티 상호작용 전부 막음
world.beforeEvents.playerInteractWithBlock.subscribe((event) => {
  if (locked.has(event.player.id)) event.cancel = true;
});
world.beforeEvents.playerInteractWithEntity.subscribe((event) => {
  if (locked.has(event.player.id)) event.cancel = true;
});
world.beforeEvents.playerBreakBlock.subscribe((event) => {
  if (locked.has(event.player.id)) event.cancel = true;
});
world.beforeEvents.itemUse.subscribe((event) => {
  if (locked.has(event.source.id)) event.cancel = true;
});

world.afterEvents.playerSpawn.subscribe(({ player }) => {
  system.run(() => player.isValid && enforce(player));
});

system.runInterval(() => {
  for (const player of world.getAllPlayers()) {
    try {
      enforce(player);
    } catch {}
  }
}, 40);

world.afterEvents.playerLeave.subscribe(({ playerId }) => locked.delete(playerId));

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
  if (online) enforce(online);
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
      const online = findOnlinePlayer(ban.id) ?? world.getAllPlayers().find((p) => normalize(p.name) === normalize(ban.name));
      if (online) enforce(online);
      admin.sendMessage(PREFIX + `§e${ban.name}§r 의 밴을 해제했습니다.`);
      return;
    }
  }
}
