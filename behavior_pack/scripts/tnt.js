import { system, world } from "@minecraft/server";
import { CONFIG } from "./config.js";
import { blockKey } from "./util.js";
import { clearBlockOwner, getBlockOwner, getBlockOwnerIndex, getOwnerIndex } from "./ownership.js";

// TNT / TNT 카트 폭발은 "자연 생성 블럭" 과 "터트린 사람이 설치한 블럭" 만 부숩니다.
// 터트린 사람 = 부싯돌/화염구로 불을 붙인 사람, 없으면 TNT를 설치한 사람.
// 주인을 알 수 없는 TNT는 자연 블럭만 부숩니다.

const OWNER_KEY = "mlc:owner";
const EXPLOSIVES = new Set(["minecraft:tnt", "minecraft:tnt_minecart"]);
const IGNITERS = new Set(["minecraft:flint_and_steel", "minecraft:fire_charge"]);
const NEIGHBORS = [
  { x: 1, y: 0, z: 0 },
  { x: -1, y: 0, z: 0 },
  { x: 0, y: 1, z: 0 },
  { x: 0, y: -1, z: 0 },
  { x: 0, y: 0, z: 1 },
  { x: 0, y: 0, z: -1 },
];

const ignitions = new Map(); // blockKey -> { playerId, tick }
const cartPlacements = []; // { dimensionId, location, playerId, tick }
const entityOwners = new Map(); // entity id -> player id (다이나믹 프로퍼티 백업)
// 폭발에 맞아 연쇄로 불붙을 TNT: 터진 TNT 주인을 물려받음 (불붙은 TNT는 폭발에 밀려 날아가서 위치로는 못 찾음)
const chainPrimed = []; // { dimensionId, x, y, z, owner, tick }

function tagOwner(entity, playerId) {
  if (!playerId) return;
  entityOwners.set(entity.id, playerId);
  try {
    entity.setDynamicProperty(OWNER_KEY, playerId);
  } catch {}
}

function dispenserOwner(dimension, location) {
  for (const offset of NEIGHBORS) {
    const pos = {
      x: Math.floor(location.x) + offset.x,
      y: Math.floor(location.y) + offset.y,
      z: Math.floor(location.z) + offset.z,
    };
    try {
      const block = dimension.getBlock(pos);
      if (block?.typeId === "minecraft:dispenser") {
        const owner = getBlockOwner(dimension.id, pos);
        if (owner) return owner;
      }
    } catch {}
  }
  return undefined;
}

world.beforeEvents.playerInteractWithBlock.subscribe(({ block, itemStack, player }) => {
  if (!CONFIG.tnt.enabled || !itemStack) return;
  if (block.typeId === "minecraft:tnt" && IGNITERS.has(itemStack.typeId)) {
    ignitions.set(blockKey(block.dimension.id, block.location), { playerId: player.id, tick: system.currentTick });
  } else if (itemStack.typeId === "minecraft:tnt_minecart") {
    cartPlacements.push({
      dimensionId: block.dimension.id,
      location: block.location,
      playerId: player.id,
      tick: system.currentTick,
    });
    if (cartPlacements.length > 50) cartPlacements.shift();
  }
});

world.afterEvents.entitySpawn.subscribe(({ entity }) => {
  if (!CONFIG.tnt.enabled) return;
  if (entity.typeId === "minecraft:tnt") {
    const dimension = entity.dimension;
    const location = entity.location;
    const key = blockKey(dimension.id, location);
    const ignition = ignitions.get(key);
    ignitions.delete(key);
    let owner;
    if (ignition && system.currentTick - ignition.tick < 40) owner = ignition.playerId;
    owner ??= chainOwner(dimension.id, location) ?? getBlockOwner(dimension.id, location) ?? dispenserOwner(dimension, location);
    clearBlockOwner(dimension.id, location);
    tagOwner(entity, owner);
  } else if (entity.typeId === "minecraft:tnt_minecart") {
    // 설치 이벤트와 스폰 이벤트 순서가 섞일 수 있어서 조금 기다렸다가 짝을 맞춤
    system.runTimeout(() => {
      if (!entity.isValid || entity.getDynamicProperty(OWNER_KEY) !== undefined) return;
      const now = system.currentTick;
      const loc = entity.location;
      let owner;
      for (let i = cartPlacements.length - 1; i >= 0; i--) {
        const placement = cartPlacements[i];
        if (now - placement.tick > 20 || placement.dimensionId !== entity.dimension.id) continue;
        const dx = placement.location.x + 0.5 - loc.x;
        const dy = placement.location.y + 0.5 - loc.y;
        const dz = placement.location.z + 0.5 - loc.z;
        if (dx * dx + dy * dy + dz * dz <= 9) {
          owner = placement.playerId;
          cartPlacements.splice(i, 1);
          break;
        }
      }
      tagOwner(entity, owner ?? dispenserOwner(entity.dimension, loc));
    }, 2);
  }
});

function chainOwner(dimensionId, location) {
  const now = system.currentTick;
  let best;
  let bestDistance = 25; // 5칸 이내
  for (const c of chainPrimed) {
    if (c.dimensionId !== dimensionId || now - c.tick > 20) continue;
    const d = (c.x - location.x) ** 2 + (c.y - location.y) ** 2 + (c.z - location.z) ** 2;
    if (d < bestDistance) {
      bestDistance = d;
      best = c.owner;
    }
  }
  return best;
}

/** TNT / TNT 카트를 터트린 플레이어 id */
export function explosiveOwner(source) {
  if (!source) return undefined;
  let owner;
  try {
    owner = source.getDynamicProperty(OWNER_KEY);
  } catch {}
  owner ??= entityOwners.get(source.id);
  return typeof owner === "string" ? owner : undefined;
}

world.beforeEvents.explosion.subscribe((event) => {
  if (!CONFIG.tnt.enabled) return;
  const source = event.source;
  if (!source || !EXPLOSIVES.has(source.typeId)) return;
  const owner = explosiveOwner(source);
  const ownerIndex = typeof owner === "string" ? getOwnerIndex(owner) : undefined;
  const dimensionId = event.dimension.id;

  const mine = (index) => index === undefined || (ownerIndex !== undefined && index === ownerIndex);
  const blocks = event.getImpactedBlocks();
  const allowed = blocks.filter((block) => {
    const { x, y, z } = block.location;
    if (!mine(getBlockOwnerIndex(dimensionId, block.location))) return false;
    // 상자/통/화로 등 컨테이너는 TNT로 절대 안 터짐 (애드온 설치 전에 놓은 상자도 보호)
    try {
      if (block.getComponent("minecraft:inventory")) return false;
    } catch {}
    // 다른 사람 블럭(문, 침대, 횃불, 레일 등)을 받치고 있는 블럭도 지켜서 같이 떨어지지 않게
    for (const offset of NEIGHBORS) {
      const neighbor = { x: x + offset.x, y: y + offset.y, z: z + offset.z };
      if (!mine(getBlockOwnerIndex(dimensionId, neighbor))) return false;
    }
    return true;
  });
  if (allowed.length !== blocks.length) event.setImpactedBlocks(allowed);
  if (owner) {
    const now = system.currentTick;
    for (const block of allowed) {
      if (block.typeId !== "minecraft:tnt") continue;
      const { x, y, z } = block.location;
      chainPrimed.push({ dimensionId, x: x + 0.5, y, z: z + 0.5, owner, tick: now });
    }
    while (chainPrimed.length > 0 && now - chainPrimed[0].tick > 40) chainPrimed.shift();
    if (chainPrimed.length > 500) chainPrimed.splice(0, chainPrimed.length - 500);
  }
});

world.afterEvents.entityRemove.subscribe(({ removedEntityId }) => {
  entityOwners.delete(removedEntityId);
});

// 오래된 점화 기록 정리
system.runInterval(() => {
  const now = system.currentTick;
  for (const [key, ignition] of ignitions) {
    if (now - ignition.tick > 100) ignitions.delete(key);
  }
}, 200);
