// MLC 렐름 관리 애드온 설정
// 숫자를 바꾼 뒤 팩을 다시 만들어 적용하면 됩니다.

export const CONFIG = {
  // 관리자 게이머태그 (대소문자/띄어쓰기 무시하고 비교)
  admins: ["minseok Kang579"],

  gamemode: {
    // 강제 서바이벌 모드일 때 몇 틱마다 게임모드를 검사할지 (20틱 = 1초)
    checkIntervalTicks: 10,
  },

  commandBlock: {
    // 강제 서바이벌 모드가 켜져 있을 때 커맨드 블록을 찾아서 제거
    remove: true,
    // 플레이어 주변 몇 청크까지 검사할지
    scanChunkRadius: 6,
    // 같은 청크를 다시 검사하기까지 걸리는 시간 (틱)
    rescanTicks: 20 * 60 * 5,
  },

  newSpawn: {
    enabled: true,
    // 처음 들어온 플레이어를 월드 스폰에서 이 거리 사이 랜덤 위치로 보냄
    minDistance: 2000,
    maxDistance: 4000,
    // 첫 접속 위치가 월드 스폰에서 이 거리 안이고 인벤토리가 비어 있어야 "신규"로 판단
    spawnCheckRadius: 64,
  },

  wither: {
    // 위더가 소환된 뒤 이 시간이 지나면 제거 (밀리초) - 2시간
    maxLifeMs: 2 * 60 * 60 * 1000,
    checkIntervalTicks: 20 * 30,
  },

  tnt: {
    // TNT / TNT 카트는 자연 블럭 + 터트린 사람이 설치한 블럭만 부숨
    enabled: true,
  },

  bookBan: {
    enabled: true,
    // 책 한 권의 최대 용량 (UTF-8 바이트). 손으로 50쪽을 꽉 채운 영어 책이 약 13KB
    maxBookBytes: 16000,
    // 셜커 상자 하나에 든 아이템 전체 최대 용량 (바이트)
    maxShulkerBytes: 64000,
    // 플레이어 인벤토리 검사 주기 (틱)
    scanIntervalTicks: 40,
  },
};
