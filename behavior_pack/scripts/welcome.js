import { InputPermissionCategory, system, world } from "@minecraft/server";
import { loadingPlayers } from "./util.js";
import { getPreviousVisit } from "./players.js";
import { isBanned } from "./bans.js";
import { isSilent } from "./joinleave.js";
import { AFTER_SCHOOL, GENERAL, LATE_NIGHT, WELCOME_BACK } from "./greetings.js";

// 다시 들어온 플레이어: 나간 위치 50칸 위에서 아래를 내려다보며 "저장 데이터 불러오는중..." 로딩 화면 →
// 인사말 → 2초 뒤 나간 자리로 내려감. 로딩 중에는 투명하고 움직일 수 없으며 떨어지지 않음.

const LONG_ABSENCE_MS = 3 * 24 * 60 * 60 * 1000;
const HEIGHT = 50;
const GREETING_TICKS = 40; // 인사말 뒤 2초
const waiters = new Map(); // 플레이어 id -> 로딩 끝나면 실행할 함수들

const pick = (list) => list[Math.floor(Math.random() * list.length)];

/** 3일 넘게 안 들어왔다가 온 플레이어인지 */
export function isLongAbsence(player) {
  const previous = getPreviousVisit(player.id);
  return !!previous && Date.now() - previous.lastSeen >= LONG_ABSENCE_MS;
}

/** 로딩 화면이 끝난 뒤 실행 (로딩 중이 아니면 바로) */
export function afterLoading(player, callback) {
  if (!loadingPlayers.has(player.id)) {
    callback();
    return;
  }
  const list = waiters.get(player.id) ?? [];
  list.push(callback);
  waiters.set(player.id, list);
}

function finishWaiters(playerId) {
  const list = waiters.get(playerId) ?? [];
  waiters.delete(playerId);
  for (const callback of list) {
    try {
      callback();
    } catch {}
  }
}

function pickGreeting(longAbsence) {
  if (longAbsence) return pick(WELCOME_BACK);
  const hour = (new Date().getUTCHours() + 9) % 24; // 한국 시간
  if (hour >= 14 && hour < 17 && Math.random() < 0.7) return pick(AFTER_SCHOOL);
  if (hour >= 0 && hour < 4 && Math.random() < 0.7) return pick(LATE_NIGHT);
  return pick(GENERAL);
}

function setInput(player, enabled) {
  for (const category of [InputPermissionCategory.Movement, InputPermissionCategory.Camera]) {
    try {
      player.inputPermissions.setPermissionCategory(category, enabled);
    } catch {}
  }
}

function progressBar(percent) {
  const filled = Math.round(percent / 10);
  return `§a${"■".repeat(filled)}§8${"■".repeat(10 - filled)} §f${percent}%`;
}

function playIntro(player, saved, longAbsence) {
  const id = player.id;
  const name = player.name;
  let dimension;
  try {
    dimension = world.getDimension(saved.dimension);
  } catch {
    return;
  }
  const target = { x: saved.x, y: saved.y, z: saved.z };
  const sky = { x: saved.x, y: Math.min(dimension.heightRange.max - 2, saved.y + HEIGHT), z: saved.z };
  const loadTicks = Math.floor(80 + Math.random() * 120); // 4~10초
  const greeting = pickGreeting(longAbsence);

  loadingPlayers.add(id);
  setInput(player, false);
  for (const effect of ["invisibility", "resistance", "weakness", "mining_fatigue"]) {
    try {
      player.addEffect(effect, loadTicks + GREETING_TICKS + 100, { amplifier: effect === "invisibility" ? 0 : 255, showParticles: false });
    } catch {}
  }

  let tick = 0;
  let shownPercent = 0;
  const handle = system.runInterval(() => {
    if (!player.isValid) {
      system.clearRun(handle);
      loadingPlayers.delete(id);
      waiters.delete(id);
      return;
    }
    tick++;
    try {
      // 하늘에 고정 + 아래(나간 자리)를 내려다봄
      player.teleport(sky, { dimension, facingLocation: target });
    } catch {}

    if (tick <= loadTicks) {
      if (tick % 4 === 1) {
        // 퍼센트가 고르지 않게 올라가서 진짜 불러오는 것처럼
        const goal = Math.floor((tick / loadTicks) * 100);
        shownPercent = Math.min(99, Math.max(shownPercent, goal - Math.floor(Math.random() * 8)));
        player.onScreenDisplay.setTitle(`§e${name}§f 플레이어 저장 데이터`, {
          subtitle: "§7불러오는중...",
          fadeInDuration: 0,
          stayDuration: 20,
          fadeOutDuration: 0,
        });
        player.onScreenDisplay.setActionBar(progressBar(shownPercent));
      }
      if (tick === loadTicks) {
        player.onScreenDisplay.setActionBar(progressBar(100));
        player.onScreenDisplay.setTitle(`§e${greeting}`, {
          subtitle: `§f${name}님`,
          fadeInDuration: 5,
          stayDuration: GREETING_TICKS + 20,
          fadeOutDuration: 10,
        });
      }
      return;
    }

    if (tick >= loadTicks + GREETING_TICKS) {
      system.clearRun(handle);
      try {
        player.teleport(target, { dimension, rotation: { x: saved.rx ?? 0, y: saved.ry ?? 0 } });
      } catch {}
      setInput(player, true);
      try {
        for (const effect of ["resistance", "weakness", "mining_fatigue"]) player.removeEffect(effect);
        if (!isSilent(player)) player.removeEffect("invisibility");
      } catch {}
      loadingPlayers.delete(id);
      finishWaiters(id);
    }
  }, 1);
}

// 로딩 중에는 블럭 부수기/놓기/상호작용/아이템 사용/때리기 전부 막음
world.beforeEvents.playerBreakBlock.subscribe((event) => {
  if (loadingPlayers.has(event.player.id)) event.cancel = true;
});
world.beforeEvents.playerInteractWithBlock.subscribe((event) => {
  if (loadingPlayers.has(event.player.id)) event.cancel = true;
});
world.beforeEvents.playerInteractWithEntity.subscribe((event) => {
  if (loadingPlayers.has(event.player.id)) event.cancel = true;
});
world.beforeEvents.itemUse.subscribe((event) => {
  if (loadingPlayers.has(event.source.id)) event.cancel = true;
});

world.afterEvents.playerSpawn.subscribe(({ player, initialSpawn }) => {
  if (!initialSpawn) return;
  system.run(() => {
    if (!player.isValid || isBanned(player)) return;
    const previous = getPreviousVisit(player.id);
    if (!previous?.location) return; // 처음 온 플레이어 / 위치 기록 없음
    // 신규 스폰으로 옮기는 중이던 플레이어는 건드리지 않음
    const spawnState = world.getDynamicProperty(`mlc:sp:${player.id}`);
    if (typeof spawnState === "string" && spawnState.startsWith("{")) return;
    playIntro(player, previous.location, isLongAbsence(player));
  });
});

// 혹시 남아 있으면 정리 (로딩 중 접속 종료 후 재접속 대비)
world.afterEvents.playerSpawn.subscribe(({ player, initialSpawn }) => {
  if (initialSpawn && !loadingPlayers.has(player.id)) setInput(player, true);
});
