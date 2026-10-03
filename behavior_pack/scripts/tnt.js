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
    owner ??= getBlockOwner(dimension.id, location) ?? dispenserOwner(dimension, location);
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

  const blocks = event.getImpactedBlocks();
  const allowed = blocks.filter((block) => {
    const blockOwner = getBlockOwnerIndex(dimensionId, block.location);
    return blockOwner === undefined || (ownerIndex !== undefined && blockOwner === ownerIndex);
  });
  if (allowed.length !== blocks.length) event.setImpactedBlocks(allowed);
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
