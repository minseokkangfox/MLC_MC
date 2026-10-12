import { system, world } from "@minecraft/server";
import { isAdmin } from "./util.js";

// 렐름은 스크립트에서 처리 안 된 오류가 한 번만 나도 서버를 꺼버림 ("처리되지 않은 예외 스크립트 와치독").
// 그래서 ./build.sh 가 모든 이벤트/반복/명령어 콜백을 자동으로 __mlcGuard(...) 로 감싸서,
// 오류가 나도 서버가 꺼지지 않고 기록만 남게 함. (관리자에게는 10초에 한 번까지 오류 내용을 알림)

let lastReport = 0;

function report(error) {
  try {
    console.warn(`[MLC] ${error}\n${error?.stack ?? ""}`);
  } catch {}
  const now = Date.now();
  if (now - lastReport < 10000) return;
  lastReport = now;
  const text = String(error).slice(0, 200);
  try {
    system.run(() => {
      try {
        for (const player of world.getAllPlayers()) {
          if (isAdmin(player)) player.sendMessage(`§8[MLC 오류] ${text}`);
        }
      } catch {}
    });
  } catch {}
}

export function __mlcGuard(callback) {
  if (typeof callback !== "function") return callback;
  return function (...args) {
    try {
      const result = callback.apply(this, args);
      if (result && typeof result.then === "function") return result.catch(report);
      return result;
    } catch (error) {
      report(error);
      return undefined;
    }
  };
}
