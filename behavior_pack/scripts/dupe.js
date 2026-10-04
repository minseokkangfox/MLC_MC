import { EquipmentSlot, GameMode, system, world } from "@minecraft/server";
import { formatLocation, isAdmin, notifyAdmins, shortDimension } from "./util.js";
import { queueAdminNotice } from "./inbox.js";

// 복사 버그 막기
// 1) 겹칠 수 없는 아이템(셜커 상자, 도구, 갑옷, 겉날개, 토템, 삼지창, 책 등)에 보이지 않는 고유번호를 붙임.
//    복사 버그로 만든 아이템은 고유번호까지 똑같이 복사되므로, 같은 번호가 동시에 두 곳에 있으면 복사본을 지움.
//    (셜커 상자를 복사하면 안의 내용물까지 통째로 복사되므로 셜커 복사가 가장 크게 막힘)
//    - 바닥에 버리면서 인벤토리에도 남는 렉 복사, 버리고 바로 나가는 접속 종료 복사, 죽을 때 복사,
//      상자/동물 상자 복사 등 "같은 아이템이 두 개가 되는" 복사는 모두 해당
// 2) 최대 개수보다 많이 쌓인 아이템(예: 토템 2개가 한 칸, 다이아 65개)은 최대 개수로 줄임.
//
// 같은 번호를 찾으면 "예전에 있던 곳"을 지금 다시 확인해서 정말 거기에도 있을 때만 복사로 판단하므로
// 상자에 넣고 빼는 정상 플레이는 걸리지 않음. 크리에이티브 모드 플레이어와 관리자는 검사하지 않음.

const UID = "mlc:uid";
const registry = new Map(); // 고유번호 -> 마지막으로 본 곳 ("p:플레이어id" | "b:차원|x|y|z" | "e:엔티티id")
const EQUIPMENT = [EquipmentSlot.Head, EquipmentSlot.Chest, EquipmentSlot.Legs, EquipmentSlot.Feet, EquipmentSlot.Offhand];

const newUid = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

function report(message) {
  if (world.getAllPlayers().some((p) => isAdmin(p))) notifyAdmins(message);
  else queueAdminNotice(message);
}

/** 플레이어의 모든 칸 (인벤토리 + 갑옷 + 왼손) */
function playerSlots(player) {
  const slots = [];
  const inventory = player.getComponent("minecraft:inventory")?.container;
  if (inventory) for (let i = 0; i < inventory.size; i++) slots.push(inventory.getSlot(i));
  const equipment = player.getComponent("minecraft:equippable");
  if (equipment) for (const slot of EQUIPMENT) slots.push(equipment.getEquipmentSlot(slot));
  return slots;
}

function containerSlots(container) {
  const slots = [];
  for (let i = 0; i < container.size; i++) slots.push(container.getSlot(i));
  return slots;
}

function slotsHaveUid(slots, uid) {
  for (const slot of slots) {
    try {
      if (slot.hasItem() && slot.maxAmount === 1 && slot.getDynamicProperty(UID) === uid) return true;
    } catch {}
  }
  return false;
}

/** 그 아이템이 지금도 그곳에 있는지 직접 확인 (확인할 수 없으면 false) */
function stillThere(place, uid) {
  try {
    if (place.startsWith("p:")) {
      const player = world.getAllPlayers().find((p) => p.id === place.slice(2));
      return !!player && slotsHaveUid(playerSlots(player), uid);
    }
    if (place.startsWith("b:")) {
      const [dimensionId, x, y, z] = place.slice(2).split("|");
      const block = world.getDimension(dimensionId).getBlock({ x: Number(x), y: Number(y), z: Number(z) });
      const container = block?.getComponent("minecraft:inventory")?.container;
      return !!container && slotsHaveUid(containerSlots(container), uid);
    }
    if (place.startsWith("e:")) {
      const entity = world.getEntity(place.slice(2));
      const item = entity?.isValid ? entity.getComponent("minecraft:item")?.itemStack : undefined;
      return !!item && item.maxAmount === 1 && item.getDynamicProperty(UID) === uid;
    }
  } catch {}
  return false;
}

/** 새로 본 곳(place)에 있는 아이템이 복사본이면 true */
function isDuplicate(uid, place) {
  const previous = registry.get(uid);
  if (previous && previous !== place && stillThere(previous, uid)) return true;
  registry.set(uid, place);
  return false;
}

/** 칸들을 검사: 고유번호 붙이기, 복사본 지우기, 너무 많이 쌓인 것 줄이기. 지운 아이템 이름 목록 반환 */
function checkSlots(slots, place) {
  const removed = [];
  const seenHere = new Set();
  for (const slot of slots) {
    try {
      if (!slot.hasItem()) continue;
      if (slot.amount > slot.maxAmount) {
        removed.push(`${slot.typeId.replace("minecraft:", "")} ${slot.amount}개→${slot.maxAmount}개`);
        slot.amount = slot.maxAmount;
      }
      if (slot.maxAmount !== 1) continue;
      let uid = slot.getDynamicProperty(UID);
      if (typeof uid !== "string") {
        uid = newUid();
        slot.setDynamicProperty(UID, uid);
        registry.set(uid, place);
        seenHere.add(uid);
        continue;
      }
      if (seenHere.has(uid) || isDuplicate(uid, place)) {
        removed.push(slot.typeId.replace("minecraft:", ""));
        slot.setItem(undefined);
        continue;
      }
      seenHere.add(uid);
    } catch {}
  }
  return removed;
}

function exempt(player) {
  try {
    return isAdmin(player) || player.getGameMode() === GameMode.Creative;
  } catch {
    return true;
  }
}

// 플레이어 인벤토리: 2초마다
system.runInterval(() => {
  for (const player of world.getAllPlayers()) {
    if (exempt(player)) continue;
    const removed = checkSlots(playerSlots(player), `p:${player.id}`);
    if (removed.length > 0) {
      player.sendMessage("§c[MLC] 복사된 아이템이 발견되어 제거되었습니다: " + removed.join(", "));
      report(`§c복사 아이템 제거§r (${player.name}): ${removed.join(", ")}`);
    }
  }
}, 40);

// 상자 등 컨테이너: 열 때마다
world.afterEvents.playerInteractWithBlock.subscribe(({ block, player }) => {
  if (exempt(player)) return;
  let container;
  try {
    container = block.getComponent("minecraft:inventory")?.container;
  } catch {}
  if (!container) return;
  const { x, y, z } = block.location;
  const removed = checkSlots(containerSlots(container), `b:${block.dimension.id}|${x}|${y}|${z}`);
  if (removed.length > 0) {
    player.sendMessage("§c[MLC] 이 상자에서 복사된 아이템이 발견되어 제거되었습니다: " + removed.join(", "));
    report(`§c복사 아이템 제거§r (상자 ${shortDimension(block.dimension.id)} ${formatLocation(block.location)}, 연 사람 ${player.name}): ${removed.join(", ")}`);
  }
});

// 바닥에 떨어진 아이템: 버렸는데 인벤토리에도 그대로 있으면 (렉 복사, 죽을 때 복사) 바닥 것을 지움
world.afterEvents.entitySpawn.subscribe(({ entity }) => {
  if (entity.typeId !== "minecraft:item") return;
  system.run(() => {
    try {
      if (!entity.isValid) return;
      const item = entity.getComponent("minecraft:item")?.itemStack;
      if (!item || item.maxAmount !== 1) return;
      const uid = item.getDynamicProperty(UID);
      if (typeof uid !== "string") return;
      if (isDuplicate(uid, `e:${entity.id}`)) {
        const where = `${shortDimension(entity.dimension.id)} ${formatLocation(entity.location)}`;
        entity.remove();
        report(`§c복사 아이템 제거§r (바닥 ${where}): ${item.typeId.replace("minecraft:", "")}`);
      }
    } catch {}
  });
});
