/**
 * 长任务证据检查模块
 *
 * 负责：
 * - 对模型生成的 todo CLI 做独立黑盒复测
 * - 静态检查 test.js 是否真实读取 todo.js / todo.json
 * - 避免 client-e2e runner 主体继续膨胀
 *
 * @module scripts/lib/long-task-checks
 */

const fs = require('fs');
const path = require('path');
const { runCommand } = require('../certification/runner-utils');

async function blackboxRetest(workspaceDir) {
  const testPath = path.join(workspaceDir, 'certification-blackbox.test.js');
  fs.writeFileSync(testPath, [
    "const assert = require('assert');",
    "const fs = require('fs');",
    "const cp = require('child_process');",
    "function lines(text) { return text.trim().split(/\\r?\\n/).filter(Boolean); }",
    "function hasId(line, id) { return new RegExp(`(^|\\\\D)${id}(\\\\D|$)`).test(line); }",
    "function assertTodoLine(line, id, task, done) {",
    "  assert(line.includes(task), `missing task ${task}: ${line}`);",
    "  assert(hasId(line, id), `missing id ${id}: ${line}`);",
    "  const doneMarker = /\\[x\\]|\\[done\\]|✓|✔|✅/i.test(line);",
    "  const openMarker = /\\[\\s\\]|☐|○/i.test(line);",
    "  assert.strictEqual(doneMarker, done, `done marker mismatch: ${line}`);",
    "  if (!done) assert(openMarker, `missing open marker: ${line}`);",
    "}",
    "try { fs.unlinkSync('todo.json'); } catch {}",
    "cp.execFileSync(process.execPath, ['todo.js', 'add', '写文档']);",
    "cp.execFileSync(process.execPath, ['todo.js', 'add', '修bug']);",
    "let list = lines(cp.execFileSync(process.execPath, ['todo.js', 'list'], {encoding:'utf8'}));",
    "assert.strictEqual(list.length, 2);",
    "assertTodoLine(list[0], 1, '写文档', false);",
    "assertTodoLine(list[1], 2, '修bug', false);",
    "cp.execFileSync(process.execPath, ['todo.js', 'done', '1']);",
    "list = lines(cp.execFileSync(process.execPath, ['todo.js', 'list'], {encoding:'utf8'}));",
    "assert.strictEqual(list.length, 2);",
    "assertTodoLine(list[0], 1, '写文档', true);",
    "assertTodoLine(list[1], 2, '修bug', false);",
    "console.log('ALL TESTS PASS');",
    '',
  ].join('\n'));
  return runCommand(process.execPath, [testPath], { cwd: workspaceDir, timeoutMs: 30000 });
}

function readsNamedFile(source, fileName) {
  const escaped = fileName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (new RegExp(`(?:readFileSync|require)\\s*\\([^;\\n]{0,160}${escaped}`).test(source)) return true;
  const assignment = new RegExp(`(?:const|let|var)\\s+(\\w+)\\s*=\\s*[^;\\n]{0,160}${escaped}`, 'g');
  return [...source.matchAll(assignment)].some(([, variable]) => (
    new RegExp(`(?:readFileSync|require)\\s*\\(\\s*${variable}\\b`).test(source)
  ));
}

function readsTodoJsonViaExport(testJs, todoJs) {
  if (!/(?:readFileSync|require)\s*\(\s*\w+\.TODO_FILE\b/.test(testJs)) return false;
  return /TODO_FILE[\s\S]{0,160}todo\.json/.test(todoJs)
    && /module\.exports[\s\S]{0,160}TODO_FILE/.test(todoJs);
}

function staticCheckLongTask(workspaceDir) {
  try {
    const testJs = fs.readFileSync(path.join(workspaceDir, 'test.js'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    const todoJs = fs.existsSync(path.join(workspaceDir, 'todo.js'))
      ? fs.readFileSync(path.join(workspaceDir, 'todo.js'), 'utf8')
      : '';
    return {
      usesAssert: /require\(['"]assert['"]\)/.test(testJs),
      readsTodoJs: /(?:execFileSync|spawnSync|execSync)[\s\S]{0,160}todo\.js/.test(testJs)
        || readsNamedFile(testJs, 'todo.js'),
      readsTodoJson: readsNamedFile(testJs, 'todo.json') || readsTodoJsonViaExport(testJs, todoJs),
    };
  } catch {
    return { usesAssert: false, readsTodoJs: false, readsTodoJson: false };
  }
}

module.exports = {
  blackboxRetest,
  staticCheckLongTask,
};
