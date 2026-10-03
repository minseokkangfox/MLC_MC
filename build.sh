#!/bin/sh
# behavior_pack 폴더를 dist/MLC_MC.mcpack 으로 묶습니다.
set -e
cd "$(dirname "$0")"
mkdir -p dist
rm -f dist/MLC_MC.mcpack
(cd behavior_pack && zip -qr ../dist/MLC_MC.mcpack .)
echo "dist/MLC_MC.mcpack 생성 완료"
