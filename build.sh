#!/bin/sh
# 비헤이비어 팩 + 리소스 팩을 dist/MLC_MC.mcaddon 하나로 묶습니다 (각각의 .mcpack 도 만듦).
# 배포용 팩에서는 주석을 모두 지웁니다 (처음 한 번 npm install 필요).
set -e
cd "$(dirname "$0")"
[ -d node_modules/typescript ] || npm install --silent
node tools/strip_comments.mjs behavior_pack build/behavior_pack
node tools/strip_comments.mjs resource_pack build/resource_pack
mkdir -p dist
rm -f dist/MLC_MC.mcpack dist/MLC_MC_BP.mcpack dist/MLC_MC_RP.mcpack dist/MLC_MC.mcaddon
(cd build/behavior_pack && zip -qr ../../dist/MLC_MC_BP.mcpack .)
(cd build/resource_pack && zip -qr ../../dist/MLC_MC_RP.mcpack .)
(cd build && zip -qr ../dist/MLC_MC.mcaddon behavior_pack resource_pack)
echo "dist/MLC_MC.mcaddon 생성 완료 (비헤이비어 + 리소스)"
