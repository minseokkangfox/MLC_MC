// 팩을 build/ 에 복사하면서 주석을 모두 지웁니다 (배포용 팩에서 기능을 유추할 수 없게).
// 사용법: node tools/strip_comments.mjs <원본 폴더> <출력 폴더>
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const [src, out] = process.argv.slice(2);

function strip(file, text) {
  if (file.endsWith(".js")) {
    return ts.transpileModule(text, {
      compilerOptions: { removeComments: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    }).outputText;
  }
  if (file.endsWith(".json")) {
    const source = ts.parseJsonText(file, text);
    if (source.parseDiagnostics?.length) throw new Error(`${file}: JSON 오류`);
    return JSON.stringify(ts.convertToObject(source, []));
  }
  if (file.endsWith(".lang")) {
    return text
      .split("\n")
      .filter((line) => !line.trim().startsWith("##") && line.trim() !== "")
      .join("\n") + "\n";
  }
  return undefined;
}

function copy(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const a = path.join(from, entry.name);
    const b = path.join(to, entry.name);
    if (entry.isDirectory()) {
      copy(a, b);
      continue;
    }
    const result = strip(entry.name, fs.readFileSync(a, "utf8"));
    if (result === undefined) fs.copyFileSync(a, b);
    else fs.writeFileSync(b, result);
  }
}

fs.rmSync(out, { recursive: true, force: true });
copy(src, out);
