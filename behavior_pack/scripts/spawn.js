import { EquipmentSlot, system, world } from "@minecraft/server";
import { CONFIG } from "./config.js";
import { PREFIX, isAdmin } from "./util.js";
import { INTRO_TICKS, showIntro } from "./intro.js";
import { getKnownPlayers } from "./players.js";

const KNOWN_KEY = "mlc:known";
const PENDING_KEY = "mlc:pendingRelocate";
const BAD_GROUND = new Set([
  "minecraft:water",
  "minecraft:flowing_water",
  "minecraft:lava",
  "minecraft:flowing_lava",
  "minecraft:bubble_column",
]);
const MAX_ATTEMPTS = 8;

// 애드온 설치 전부터 있던 플레이어는 기록이 없으므로,
// "스폰 근처에서 시작 + 빈 인벤토리 + 레벨 0 + 갑옷 없음" 일 때만 신규로 판단
function looksBrandNew(player) {
  const spawn = world.getDefaultSpawnLocation();
  const dx = player.location.x - spawn.x;
  const dz = player.location.z - spawn.z;
  const radius = CONFIG.newSpawn.spawnCheckRadius;
  if (player.dimension.id !== "minecraft:overworld") return false;
  if (dx * dx + dz * dz > radius * radius) return false;
  if (player.level > 0) return false;
  // 스폰 지점(침대 또는 이 애드온이 정해준 곳)이 있으면 이미 플레이한 사람
  try {
    if (player.getSpawnPoint()) return false;
  } catch {}
  const inventory = player.getComponent("minecraft:inventory")?.container;
  if (inventory && inventory.emptySlotsCount !== inventory.size) return false;
  const equipment = player.getComponent("minecraft:equippable");
  if (equipment) {
    for (const slot of [EquipmentSlot.Head, EquipmentSlot.Chest, EquipmentSlot.Legs, EquipmentSlot.Feet, EquipmentSlot.Offhand]) {
      if (equipment.getEquipment(slot)) return false;
    }
  }
  return true;
}

// 플레이어별 상태는 월드에 저장 (플레이어 데이터보다 확실함)
//   없음 = 아직 판단 안 함, "done" = 끝남(다시는 안 옮김), {x,z} = 옮기는 중
// id 와 이름 둘 다로 저장 (렐름에서 id 가 바뀌어도 이름으로 알아봄)
const stateKey = (player) => `mlc:sp:${player.id}`;
const nameKey = (player) => `mlc:spn:${player.name.toLowerCase().replace(/\s+/g, "")}`;

// /시작2 를 입력해야 랜덤 좌표 시작이 켜짐. 그 전에 들어온 사람은 전부 기존 플레이어로 기록됨
const ARMED_KEY = "mlc:spawnArmed";

export function isNewSpawnArmed() {
  return world.getDynamicProperty(ARMED_KEY) === true;
}

/** /시작2: 지금까지 들어왔던 사람(접속 중 포함)은 기존 플레이어로 확정하고, 이후 처음 들어오는 사람만 랜덤 좌표로 */
export function armNewSpawn() {
  let count = 0;
  for (const known of getKnownPlayers()) {
    world.setDynamicProperty(stateKey(known), "done");
    world.setDynamicProperty(nameKey(known), "done");
    count++;
  }
  world.setDynamicProperty(ARMED_KEY, true);
  return count;
}

export function disarmNewSpawn() {
  world.setDynamicProperty(ARMED_KEY, false);
}

function getState(player) {
  if (world.getDynamicProperty(nameKey(player)) === "done") return "done";
  const raw = world.getDynamicProperty(stateKey(player));
  if (raw === "done") return "done";
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {}
  }
  return undefined;
}

function setState(player, state) {
  world.setDynamicProperty(stateKey(player), state === "done" ? "done" : JSON.stringify(state));
  if (state === "done") world.setDynamicProperty(nameKey(player), "done");
}

function pickTarget() {
  const spawn = world.getDefaultSpawnLocation();
  const { minDistance, maxDistance } = CONFIG.newSpawn;
  const angle = Math.random() * Math.PI * 2;
  const distance = minDistance + Math.random() * (maxDistance - minDistance);
  return { x: Math.floor(spawn.x + Math.cos(angle) * distance), z: Math.floor(spawn.z + Math.sin(angle) * distance) };
}

function farFromWorldSpawn(player) {
  const spawn = world.getDefaultSpawnLocation();
  const dx = player.location.x - spawn.x;
  const dz = player.location.z - spawn.z;
  const min = CONFIG.newSpawn.minDistance / 2;
  return player.dimension.id !== "minecraft:overworld" || dx * dx + dz * dz > min * min;
}

function finish(player, location) {
  setState(player, "done");
  player.setDynamicProperty(PENDING_KEY, undefined);
  player.setDynamicProperty(KNOWN_KEY, true);
  if (location) {
    player.setSpawnPoint({ dimension: world.getDimension("minecraft:overworld"), ...location });
  }
  system.runTimeout(() => {
    if (!player.isValid) return;
    player.removeEffect("slow_falling");
    player.removeEffect("resistance");
  }, 100);
}

/** 땅을 못 찾았을 때: 플레이어가 착지하면 그 자리를 스폰으로 */
function finishWhenLanded(player) {
  setState(player, "done");
  let tries = 0;
  const handle = system.runInterval(() => {
    tries++;
    if (!player.isValid || tries > 120) {
      system.clearRun(handle);
      return;
    }
    if (player.isOnGround) {
      system.clearRun(handle);
      const { x, y, z } = player.location;
      finish(player, { x: Math.floor(x), y: Math.floor(y), z: Math.floor(z) });
    }
  }, 10);
}

function relocate(player, target, attempt = 0) {
  const overworld = world.getDimension("minecraft:overworld");
  const { x, z } = target;
  setState(player, target);
  // 처음 한 번만: 하늘에서 떨어지는 동안 서버 로고 + 설명
  if (attempt === 0) showIntro(player);

  // 청크가 로딩될 때까지 하늘에서 천천히 떨어지며 대기
  player.teleport({ x: x + 0.5, y: 300, z: z + 0.5 }, { dimension: overworld });
  player.addEffect("slow_falling", 20 * 60, { showParticles: false });
  player.addEffect("resistance", 20 * 60, { amplifier: 255, showParticles: false });

  let tries = 0;
  const handle = system.runInterval(() => {
    if (!player.isValid) {
      system.clearRun(handle); // 나갔다 들어오면 같은 위치로 이어서 진행
      return;
    }
    tries++;
    let top;
    try {
      top = overworld.getTopmostBlock({ x, z });
    } catch {}
    // 로고 화면이 끝날 때까지는 계속 천천히 떨어지게 둠
    if (top && attempt === 0 && tries * 10 < INTRO_TICKS) return;
    if (!top) {
      if (tries > 60 + INTRO_TICKS / 10) {
        // 30초 안에 땅을 못 찾음 - 그냥 떨어지게 두고 착지한 곳을 스폰으로
        system.clearRun(handle);
        finishWhenLanded(player);
      }
      return;
    }
    system.clearRun(handle);
    if (BAD_GROUND.has(top.typeId) && attempt < MAX_ATTEMPTS) {
      relocate(player, pickTarget(), attempt + 1);
      return;
    }
    const location = { x, y: top.location.y + 1, z };
    player.teleport({ x: x + 0.5, y: location.y, z: z + 0.5 }, { dimension: overworld });
    finish(player, location);
    player.sendMessage(PREFIX + "§a환영합니다! 자원이 많은 곳에서 시작합니다. 이곳이 당신의 스폰 지점입니다.");
  }, 10);
}

world.afterEvents.playerSpawn.subscribe(({ player, initialSpawn }) => {
  if (!initialSpawn || !CONFIG.newSpawn.enabled) return;
  // 접속 직후 위치/인벤토리가 확정되도록 잠시 기다림
  system.runTimeout(() => {
    if (!player.isValid) return;
    let state = getState(player);
    if (state === "done") return;

    // /시작2 전: 랜덤 좌표로 보내지 않고 기존 플레이어로 기록만 함
    if (state === undefined && !isNewSpawnArmed()) {
      setState(player, "done");
      player.setDynamicProperty(KNOWN_KEY, true);
      return;
    }

    // 이전 버전 기록이 있으면 (옮기던 중이었어도) 더는 옮기지 않음
    if (state === undefined && player.getDynamicProperty(PENDING_KEY) === true) {
      finishWhenLanded(player);
      return;
    }
    if (state === undefined && player.getDynamicProperty(KNOWN_KEY) === true) {
      setState(player, "done");
      return;
    }

    if (state !== undefined) {
      // 옮기던 중에 나갔던 플레이어: 이미 멀리 와 있으면 그대로 끝, 아니면 같은 목적지로 이어서 (새 랜덤 위치는 절대 안 뽑음)
      if (farFromWorldSpawn(player) || typeof state.x !== "number") finishWhenLanded(player);
      else relocate(player, state);
      return;
    }

    if (isAdmin(player) || !looksBrandNew(player)) {
      setState(player, "done");
      player.setDynamicProperty(KNOWN_KEY, true);
      return;
    }
    relocate(player, pickTarget());
  }, 40);
});
