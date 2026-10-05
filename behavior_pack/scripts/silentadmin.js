import { system, world } from "@minecraft/server";
import { ActionFormData } from "@minecraft/server-ui";
import { PREFIX } from "./util.js";
import { isSilent } from "./joinleave.js";
import { showForm } from "./forms.js";

// 조용히 접속한 관리자 전용
// 1) 상자를 열어도 소리/뚜껑 열리는 모습이 안 나오게: 실제로 열지 않고 내용물을 창(폼)으로 보여줌
//    (웅크리고 열면 원래대로 열림)
// 2) 다른 플레이어에게 밀리지 않게: 가만히 서 있을 때 밀려난 만큼 제자리로 되돌림

const SILENT_CONTAINERS = ["chest", "barrel", "shulker_box"];

function isSilentContainer(typeId) {
  if (typeId.includes("ender_chest")) return false; // 엔더 상자는 스크립트로 내용을 볼 수 없음
  return SILENT_CONTAINERS.some((word) => typeId.includes(word));
}

world.beforeEvents.playerInteractWithBlock.subscribe((event) => {
  const { player, block } = event;
  if (!isSilent(player) || player.isSneaking) return;
  if (!isSilentContainer(block.typeId)) return;
  event.cancel = true;
  if (!event.isFirstEvent) return;
  const dimension = block.dimension;
  const location = block.location;
  system.run(() => {
    openSilentContainer(player, dimension, location).catch(() => {});
  });
});

function itemLabel(item) {
  const amount = item.amount > 1 ? ` §8x${item.amount}` : "";
  if (item.nameTag) return { rawtext: [{ text: `§0${item.nameTag}${amount}` }] };
  return { rawtext: [{ text: "§0" }, { translate: item.localizationKey }, { text: amount }] };
}

function getContainer(dimension, location) {
  try {
    return dimension.getBlock(location)?.getComponent("minecraft:inventory")?.container;
  } catch {
    return undefined;
  }
}

async function openSilentContainer(player, dimension, location) {
  for (let round = 0; round < 200; round++) {
    const container = getContainer(dimension, location);
    if (!container || !player.isValid) return;
    const slots = [];
    for (let i = 0; i < container.size; i++) {
      if (container.getItem(i)) slots.push(i);
    }
    const form = new ActionFormData()
      .title("§8상자 (조용히)")
      .body(`§7소리 없이 연 상자입니다. 아이템을 누르면 가져옵니다.\n§7(${slots.length}/${container.size}칸 사용 중, 웅크리고 열면 원래대로 열림)`)
      .button("§2손에 든 아이템 넣기");
    for (const slot of slots) form.button(itemLabel(container.getItem(slot)));
    const response = await showForm(player, form);
    if (!response || response.canceled || response.selection === undefined || !player.isValid) return;

    const fresh = getContainer(dimension, location);
    const inventory = player.getComponent("minecraft:inventory")?.container;
    if (!fresh || !inventory) return;
    if (response.selection === 0) {
      const held = inventory.getItem(player.selectedSlotIndex);
      if (!held) {
        player.sendMessage(PREFIX + "§7손에 든 아이템이 없습니다.");
        continue;
      }
      const leftover = fresh.addItem(held);
      inventory.setItem(player.selectedSlotIndex, leftover);
      if (leftover) player.sendMessage(PREFIX + "§7상자가 가득 차서 일부만 넣었습니다.");
      continue;
    }
    const slot = slots[response.selection - 1];
    const item = fresh.getItem(slot);
    if (!item) continue; // 그 사이 다른 사람이 가져감
    const leftover = inventory.addItem(item);
    fresh.setItem(slot, leftover);
    if (leftover) player.sendMessage(PREFIX + "§7인벤토리가 가득 찼습니다.");
  }
}

// ---------- 밀리지 않기 ----------
const anchors = new Map(); // 플레이어 id -> { x, z, dimension, idle }

system.runInterval(() => {
  for (const player of world.getAllPlayers()) {
    if (!isSilent(player)) {
      anchors.delete(player.id);
      continue;
    }
    try {
      const move = player.inputInfo.getMovementVector();
      const moving = Math.abs(move.x) > 0.01 || Math.abs(move.y) > 0.01;
      const free =
        moving ||
        player.isJumping ||
        !player.isOnGround ||
        player.isFlying ||
        player.isGliding ||
        player.isSwimming ||
        player.isInWater ||
        player.getComponent("minecraft:riding");
      const location = player.location;
      const anchor = anchors.get(player.id);
      if (free || !anchor || anchor.dimension !== player.dimension.id) {
        anchors.set(player.id, { x: location.x, z: location.z, dimension: player.dimension.id, idle: 0 });
        continue;
      }
      // 멈춘 직후 미끄러지는 건 그대로 두고, 완전히 선 뒤의 위치를 기준으로 삼음
      if (anchor.idle < 4) {
        anchors.set(player.id, { x: location.x, z: location.z, dimension: anchor.dimension, idle: anchor.idle + 1 });
        continue;
      }
      const dx = location.x - anchor.x;
      const dz = location.z - anchor.z;
      const moved = dx * dx + dz * dz;
      if (moved > 4) {
        // 크게 이동함 (명령어 순간이동 등) → 새 기준
        anchors.set(player.id, { x: location.x, z: location.z, dimension: anchor.dimension, idle: 0 });
      } else if (moved > 0.0004) {
        player.teleport({ x: anchor.x, y: location.y, z: anchor.z }, { rotation: player.getRotation() });
      }
    } catch {}
  }
}, 1);
