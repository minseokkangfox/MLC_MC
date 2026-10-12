// 팩을 build/ 에 복사하면서 주석을 모두 지웁니다 (배포용 팩에서 기능을 유추할 수 없게).
// 사용법: node tools/strip_comments.mjs <원본 폴더> <출력 폴더>
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const [src, out] = process.argv.slice(2);

// 렐름은 스크립트 오류 한 번에 서버를 꺼버리므로, 콜백을 전부 guard.js 의 __mlcGuard 로 감쌈:
//   X.subscribe(cb), system.run/runTimeout/runInterval(cb), registerCommand(def, cb)
const GUARD = "__mlcGuard";
const TIMERS = new Set(["run", "runTimeout", "runInterval"]);

function guardTransformer(context) {
  const f = context.factory;
  return (sourceFile) => {
    let used = false;
    const wrap = (node) => {
      used = true;
      return f.createCallExpression(f.createIdentifier(GUARD), undefined, [node]);
    };
    const visit = (node) => {
      node = ts.visitEachChild(node, visit, context);
      if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return node;
      const method = node.expression.name.text;
      const target = node.expression.expression.getText ? safeText(node.expression.expression) : "";
      const args = [...node.arguments];
      let index = -1;
      if (method === "subscribe") index = 0;
      else if (TIMERS.has(method) && target === "system") index = 0;
      else if (method === "registerCommand") index = 1;
      if (index < 0 || !args[index]) return node;
      args[index] = wrap(args[index]);
      return f.updateCallExpression(node, node.expression, node.typeArguments, args);
    };
    const result = ts.visitNode(sourceFile, visit);
    if (!used) return result;
    const importDecl = f.createImportDeclaration(
      undefined,
      f.createImportClause(false, undefined, f.createNamedImports([f.createImportSpecifier(false, undefined, f.createIdentifier(GUARD))])),
      f.createStringLiteral("./guard.js")
    );
    return f.updateSourceFile(result, [importDecl, ...result.statements]);
  };
}

function safeText(node) {
  return ts.isIdentifier(node) ? node.text : "";
}

function strip(file, text) {
  if (file.endsWith(".js")) {
    return ts.transpileModule(text, {
      compilerOptions: { removeComments: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
      transformers: file === "guard.js" ? undefined : { before: [guardTransformer] },
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
