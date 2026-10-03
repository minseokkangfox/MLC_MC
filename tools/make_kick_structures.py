#!/usr/bin/env python3
"""밴 kick 용 커맨드 블록 구조물(.mcstructure)을 만듭니다.

애드온 스크립트가 직접 /kick 하면 "호스트에 의해 차단" 이 되어 다시 못 들어오는 문제가 있어서,
관리자가 예전에 쓰던 방식처럼 실제 커맨드 블록이 kick 하도록 합니다.
카테고리마다 구조물 하나: behavior_pack/structures/mlc/kick_<번호>.mcstructure  (= "mlc:kick_<번호>")
커맨드: kick @a[tag=mlc_kick_<번호>] <밴 메시지>

config.js 의 ban.categories 나 discord 를 바꾸면 아래 값도 똑같이 바꾸고 이 파일을 다시 실행하세요.
"""
import os
import struct

CATEGORIES = ["핵", "악용", "괴롭힘", "욕설", "테러", "사기", "도배", "기타"]
DISCORD = "https://discord.gg/s63XD2AuNy"
OUT = os.path.join(os.path.dirname(__file__), "..", "behavior_pack", "structures", "mlc")

END, BYTE, SHORT, INT, LONG, STRING, LIST, COMPOUND = 0, 1, 2, 3, 4, 8, 9, 10


def s(text):
    data = text.encode("utf-8")
    return struct.pack("<H", len(data)) + data


def payload(tag, value):
    if tag == BYTE:
        return struct.pack("<b", value)
    if tag == SHORT:
        return struct.pack("<h", value)
    if tag == INT:
        return struct.pack("<i", value)
    if tag == LONG:
        return struct.pack("<q", value)
    if tag == STRING:
        return s(value)
    if tag == LIST:
        item_tag, items = value
        out = struct.pack("<bi", item_tag if items else END, len(items))
        return out + b"".join(payload(item_tag, item) for item in items)
    if tag == COMPOUND:
        out = b""
        for name, (child_tag, child) in value.items():
            out += struct.pack("<b", child_tag) + s(name) + payload(child_tag, child)
        return out + struct.pack("<b", END)
    raise ValueError(tag)


def structure(command):
    block_entity = {
        "id": (STRING, "CommandBlock"),
        "Command": (STRING, command),
        "CustomName": (STRING, ""),
        "ExecuteOnFirstTick": (BYTE, 1),
        "LPCommandMode": (INT, 0),
        "LPCondionalMode": (BYTE, 0),
        "LPRedstoneMode": (BYTE, 0),
        "LastExecution": (LONG, 0),
        "LastOutput": (STRING, ""),
        "LastOutputParams": (LIST, (STRING, [])),
        "SuccessCount": (INT, 0),
        "TickDelay": (INT, 0),
        "TrackOutput": (BYTE, 0),
        "Version": (INT, 38),
        "auto": (BYTE, 1),
        "conditionMet": (BYTE, 0),
        "conditionalMode": (BYTE, 0),
        "isMovable": (BYTE, 1),
        "powered": (BYTE, 0),
        "x": (INT, 0),
        "y": (INT, 0),
        "z": (INT, 0),
    }
    root = {
        "format_version": (INT, 1),
        "size": (LIST, (INT, [1, 1, 1])),
        "structure_world_origin": (LIST, (INT, [0, 0, 0])),
        "structure": (COMPOUND, {
            "block_indices": (LIST, (LIST, [(INT, [0]), (INT, [-1])])),
            "entities": (LIST, (COMPOUND, [])),
            "palette": (COMPOUND, {
                "default": (COMPOUND, {
                    "block_palette": (LIST, (COMPOUND, [{
                        "name": (STRING, "minecraft:repeating_command_block"),
                        "states": (COMPOUND, {
                            "conditional_bit": (BYTE, 0),
                            "facing_direction": (INT, 1),
                        }),
                        "version": (INT, 18090528),
                    }])),
                    "block_position_data": (COMPOUND, {
                        "0": (COMPOUND, {"block_entity_data": (COMPOUND, block_entity)}),
                    }),
                }),
            }),
        }),
    }
    return struct.pack("<b", COMPOUND) + s("") + payload(COMPOUND, root)


def main():
    os.makedirs(OUT, exist_ok=True)
    for index, category in enumerate(CATEGORIES):
        message = f"서버 규칙을 위반 했습니다. ({category}) 를 위반 이 밴에 문제가 있으면 관리자에게 문의하세요 {DISCORD}"
        command = f"kick @a[tag=mlc_kick_{index}] {message}"
        with open(os.path.join(OUT, f"kick_{index}.mcstructure"), "wb") as f:
            f.write(structure(command))
    print(f"{len(CATEGORIES)}개 구조물 생성: {os.path.normpath(OUT)}")


if __name__ == "__main__":
    main()
