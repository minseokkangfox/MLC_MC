import { system } from "@minecraft/server";
import { CONFIG } from "./config.js";

// 서버 로고 + 설명 화면 (처음 들어온 플레이어가 하늘에서 천천히 떨어지는 동안, 관리자는 /hll 로 다시 보기)
// 로고 그림은 리소스팩 font/glyph_E1.png 에 들어 있고, 아래 특수 문자 1개가 로고 그림입니다 (tools/make_logo_glyph.py).
export const LOGO = "\ue100";

export const INTRO_TICKS = CONFIG.intro.seconds * 20;

/** 로고와 서버 설명을 seconds 초 동안 보여줌 */
export function showIntro(player) {
  // 로고는 부제목 줄에 한 번만 보냄 (매초 다시 보내면 화면이 툭툭 끊겨 보임)
  player.onScreenDisplay.setTitle(" ", {
    subtitle: LOGO,
    fadeInDuration: 10,
    stayDuration: INTRO_TICKS - 20,
    fadeOutDuration: 10,
  });
  // 아래쪽 설명은 2초마다 다음 줄로
  const lines = [CONFIG.intro.subtitle, ...CONFIG.intro.lines];
  let index = 0;
  const next = () => {
    if (!player.isValid || index * 40 >= INTRO_TICKS) {
      system.clearRun(handle);
      return;
    }
    player.onScreenDisplay.setActionBar(lines[index % lines.length]);
    index++;
  };
  const handle = system.runInterval(next, 40);
  next();
}
