import { system, world } from "@minecraft/server";

// 플레이어가 설치한 블럭의 주인을 기록합니다.
// 서브청크(16x16x16)마다 하나의 월드 다이나믹 프로퍼티에 저장:
//   { "<주인번호>": "<블럭 위치 2글자씩>" }
// 기록이 없는 블럭 = 자연 생성(또는 애드온 설치 전에 놓인) 블럭.

const OWNERS_KEY = "mlc:owners";
const SECTION_PREFIX = "mlc:o:";
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const CHAR_INDEX = new Map([...ALPHABET].map((c, i) => [c, i]));
const DIM_CODE = { "minecraft:overworld": "o", "minecraft:nether": "n", "minecraft:the_end": "e" };
const MAX_CLEAN_CACHE = 3000;

let owners; // 플레이어 id 배열
let ownerIndex; // id -> 번호
const sections = new Map(); // 섹션키 -> Map(로컬위치 -> 주인번호)
const dirty = new Set();

function loadOwners() {
  if (owners) return;
  try {
    owners = JSON.parse(String(world.getDynamicProperty(OWNERS_KEY) ?? "[]"));
  } catch {
    owners = [];
  }
  ownerIndex = new Map(owners.map((id, i) => [id, i]));
}

function ownerToIndex(playerId, create) {
  loadOwners();
  let index = ownerIndex.get(playerId);
  if (index === undefined && create) {
    index = owners.length;
    owners.push(playerId);
    ownerIndex.set(playerId, index);
    world.setDynamicProperty(OWNERS_KEY, JSON.stringify(owners));
  }
  return index;
}

function sectionKey(dimensionId, x, y, z) {
  return `${SECTION_PREFIX}${DIM_CODE[dimensionId] ?? dimensionId}:${x >> 4}:${y >> 4}:${z >> 4}`;
}

function localIndex(x, y, z) {
  return ((x & 15) << 8) | ((y & 15) << 4) | (z & 15);
}

function loadSection(key) {
  let section = sections.get(key);
  if (section) return section;
  section = new Map();
  try {
    const raw = world.getDynamicProperty(key);
    if (typeof raw === "string") {
      const data = JSON.parse(raw);
      for (const owner in data) {
        const packed = data[owner];
        const ownerNum = Number(owner);
        for (let i = 0; i + 1 < packed.length; i += 2) {
          section.set(CHAR_INDEX.get(packed[i]) * 64 + CHAR_INDEX.get(packed[i + 1]), ownerNum);
        }
      }
    }
  } catch {}
  if (sections.size > MAX_CLEAN_CACHE) {
    for (const k of sections.keys()) {
      if (!dirty.has(k)) sections.delete(k);
      if (sections.size <= MAX_CLEAN_CACHE / 2) break;
    }
  }
  sections.set(key, section);
  return section;
}

function saveSection(key) {
  const section = sections.get(key);
  if (!section) return;
  if (section.size === 0) {
    world.setDynamicProperty(key, undefined);
    return;
  }
  const grouped = {};
  for (const [index, owner] of section) {
    grouped[owner] = (grouped[owner] ?? "") + ALPHABET[index >> 6] + ALPHABET[index & 63];
  }
  world.setDynamicProperty(key, JSON.stringify(grouped));
}

function coords(location) {
  return [Math.floor(location.x), Math.floor(location.y), Math.floor(location.z)];
}

export function setBlockOwner(dimensionId, location, playerId) {
  const [x, y, z] = coords(location);
  const key = sectionKey(dimensionId, x, y, z);
  loadSection(key).set(localIndex(x, y, z), ownerToIndex(playerId, true));
  dirty.add(key);
}

export function clearBlockOwner(dimensionId, location) {
  const [x, y, z] = coords(location);
  const key = sectionKey(dimensionId, x, y, z);
  if (loadSection(key).delete(localIndex(x, y, z))) dirty.add(key);
}

/** 블럭 주인의 플레이어 id, 기록 없으면 undefined (읽기 전용 모드에서도 호출 가능) */
export function getBlockOwner(dimensionId, location) {
  const index = getBlockOwnerIndex(dimensionId, location);
  return index === undefined ? undefined : owners[index];
}

export function getBlockOwnerIndex(dimensionId, location) {
  loadOwners();
  const [x, y, z] = coords(location);
  return loadSection(sectionKey(dimensionId, x, y, z)).get(localIndex(x, y, z));
}

export function getOwnerIndex(playerId) {
  return playerId === undefined ? undefined : ownerToIndex(playerId, false);
}

function flush() {
  for (const key of dirty) {
    try {
      saveSection(key);
    } catch {}
  }
  dirty.clear();
}

system.runInterval(flush, 100);
// 블럭 설치/파괴/폭발 시 기록 갱신은 activity.js 에서 처리
