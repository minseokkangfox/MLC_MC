import { EquipmentSlot, system, world } from "@minecraft/server";
import { CONFIG } from "./config.js";
import { PREFIX, isAdmin } from "./util.js";

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

function relocate(player, attempt = 0) {
  const spawn = world.getDefaultSpawnLocation();
  const overworld = world.getDimension("minecraft:overworld");
  const { minDistance, maxDistance } = CONFIG.newSpawn;
  const angle = Math.random() * Math.PI * 2;
  const distance = minDistance + Math.random() * (maxDistance - minDistance);
  const x = Math.floor(spawn.x + Math.cos(angle) * distance);
  const z = Math.floor(spawn.z + Math.sin(angle) * distance);

  // 청크가 로딩될 때까지 하늘에서 천천히 떨어지며 대기
  player.teleport({ x: x + 0.5, y: 300, z: z + 0.5 }, { dimension: overworld });
  player.addEffect("slow_falling", 20 * 60, { showParticles: false });
  player.addEffect("resistance", 20 * 60, { amplifier: 255, showParticles: false });

  let tries = 0;
  const handle = system.runInterval(() => {
    if (!player.isValid) {
      system.clearRun(handle);
      return;
    }
    tries++;
    let top;
    try {
      top = overworld.getTopmostBlock({ x, z });
    } catch {}
    if (!top) {
      if (tries > 60) system.clearRun(handle); // 30초 안에 로딩 실패 - 그냥 떨어지게 둠
      return;
    }
    system.clearRun(handle);
    if (BAD_GROUND.has(top.typeId) && attempt < MAX_ATTEMPTS) {
      relocate(player, attempt + 1);
      return;
    }
    const target = { x, y: top.location.y + 1, z };
    player.teleport({ x: x + 0.5, y: target.y, z: z + 0.5 }, { dimension: overworld });
    player.setSpawnPoint({ dimension: overworld, ...target });
    player.setDynamicProperty(PENDING_KEY, undefined);
    system.runTimeout(() => {
      if (!player.isValid) return;
      player.removeEffect("slow_falling");
      player.removeEffect("resistance");
    }, 100);
    player.sendMessage(PREFIX + "§a환영합니다! 자원이 많은 곳에서 시작합니다. 이곳이 당신의 스폰 지점입니다.");
  }, 10);
}

world.afterEvents.playerSpawn.subscribe(({ player, initialSpawn }) => {
  if (!initialSpawn || !CONFIG.newSpawn.enabled) return;
  // 접속 직후 위치/인벤토리가 확정되도록 잠시 기다림
  system.runTimeout(() => {
    if (!player.isValid) return;
    if (player.getDynamicProperty(PENDING_KEY) === true) {
      relocate(player);
      return;
    }
    if (player.getDynamicProperty(KNOWN_KEY) === true) return;
    player.setDynamicProperty(KNOWN_KEY, true);
    if (isAdmin(player) || !looksBrandNew(player)) return;
    player.setDynamicProperty(PENDING_KEY, true);
    relocate(player);
  }, 40);
});
