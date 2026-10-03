#!/bin/sh
# 비헤이비어 팩 + 리소스 팩을 dist/MLC_MC.mcaddon 하나로 묶습니다 (각각의 .mcpack 도 만듦).
set -e
cd "$(dirname "$0")"
mkdir -p dist
rm -f dist/MLC_MC.mcpack dist/MLC_MC_BP.mcpack dist/MLC_MC_RP.mcpack dist/MLC_MC.mcaddon
(cd behavior_pack && zip -qr ../dist/MLC_MC_BP.mcpack .)
(cd resource_pack && zip -qr ../dist/MLC_MC_RP.mcpack .)
zip -qr dist/MLC_MC.mcaddon behavior_pack resource_pack
echo "dist/MLC_MC.mcaddon 생성 완료 (비헤이비어 + 리소스)"
