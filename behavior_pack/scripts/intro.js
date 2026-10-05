import { system } from "@minecraft/server";
import { CONFIG } from "./config.js";

// 서버 로고 + 설명 화면 (처음 들어온 플레이어가 하늘에서 천천히 떨어지는 동안, 관리자는 /hll 로 다시 보기)
// 로고 그림은 리소스팩 font/glyph_E1.png 에 들어 있고, 아래 특수 문자 2개가 그 그림 조각입니다 (tools/make_logo_glyph.py).
export const LOGO = "\ue100\ue101";

export const INTRO_TICKS = CONFIG.intro.seconds * 20;

/** 로고와 서버 설명을 seconds 초 동안 보여줌 */
export function showIntro(player) {
  // 로고는 부제목 줄에 (제목 줄은 글자가 너무 크게 그려짐), 설명은 화면 아래쪽에 돌아가며
  const lines = [CONFIG.intro.subtitle, ...CONFIG.intro.lines];
  let tick = 0;
  const handle = system.runInterval(() => {
    if (!player.isValid || tick >= INTRO_TICKS) {
      system.clearRun(handle);
      return;
    }
    if (tick % 20 === 0) {
      player.onScreenDisplay.setTitle(" ", {
        subtitle: LOGO,
        fadeInDuration: tick === 0 ? 10 : 0,
        stayDuration: tick + 20 >= INTRO_TICKS ? 30 : 40,
        fadeOutDuration: 10,
      });
    }
    // 아래쪽 설명은 몇 줄을 돌아가며 보여줌
    if (tick % 40 === 0 && lines.length > 0) {
      player.onScreenDisplay.setActionBar(lines[Math.floor(tick / 40) % lines.length]);
    }
    tick += 5;
  }, 5);
}
