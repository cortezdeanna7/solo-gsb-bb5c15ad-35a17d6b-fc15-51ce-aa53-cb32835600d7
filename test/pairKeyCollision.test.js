'use strict';

/**
 * 成员对碰撞回归测试：成员 ID 允许包含「|」与内部空格（备份恢复保留原 ID），
 * 成员对必须按有序端点识别，不得用分隔符拼接——否则
 *   b|c→a 与 c→a|b（child|parent 拼出同样的 "a|b|c"）、
 *   b c→a 与 c→a b（child parent 拼出同样的 "a b c"）
 * 会被误判为同一对，导致备份校验误报重复、批量提交静默丢边、
 * 合并去重串项、变更影响比较串对、桥梁分析串键。
 * 真正重复、自指、超两位父母与祖先环路仍须按原规则拒绝。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  createState,
  validateEdge,
  validateEdgeBatch,
  validateBackup,
  previewMergeMembers,
  previewEdgeImpact,
  pairKey,
} = require('../server/familyGraph');
const { findCriticalLinks } = require('../server/criticalLinks');
const { createStore } = require('../server/store');

/** 测试辅助：批量建成员（id 与姓名相同）并建立已有关系 */
function makeState(ids, existing = []) {
  const state = createState();
  for (const id of ids) {
    state.members.push({ id, name: id });
    state.parentsOf[id] = [];
  }
  for (const [p, c] of existing) {
    const r = validateEdge(state, p, c);
    assert.equal(r.error, null, `准备数据失败 ${p} -> ${c}: ${r.error}`);
    state.parentsOf[c].push(p);
  }
  return state;
}

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'family-pairkey-'));
  return path.join(dir, 'family.json');
}

/** 通过备份恢复建立含特殊字符 ID 的成员（恢复保留原 ID），返回已就绪的 store */
function storeWithSpecialIds(file, ids) {
  const store = createStore(file);
  const content = JSON.stringify({
    members: ids.map((id) => ({ id, name: id })),
    edges: [],
  });
  const preview = store.previewRestore(content);
  assert.equal(preview.valid, true, `备份预览应合法：${preview.error}`);
  const restored = store.restoreBackup(content, preview.fingerprint, store.getVersion());
  assert.equal(restored.error, null, `备份恢复应成功：${restored.error}`);
  return store;
}

const edgeSetOf = (edges) => new Set(edges.map((e) => `${e.parentId}→${e.childId}`));

/* ---------------- pairKey 本身 ---------------- */

test('pairKey：有序端点编码不碰撞，含「|」、空格、引号的 ID 各自唯一', () => {
  // 任务给出的两组碰撞用例在规范键下必须不同
  assert.notEqual(pairKey('a', 'b|c'), pairKey('a|b', 'c')); // (子女,父母)：b|c→a 与 c→a|b
  assert.notEqual(pairKey('a', 'b c'), pairKey('a b', 'c')); // (子女,父母)：b c→a 与 c→a b
  assert.notEqual(pairKey('b|c', 'a'), pairKey('b', 'c|a')); // (父母,子女)：桥梁分析方向
  // 有序性：端点对调键不同
  assert.notEqual(pairKey('x', 'y'), pairKey('y', 'x'));
  // 引号、反斜杠、换行等需转义的字符也不会碰撞
  assert.notEqual(pairKey('a"b', 'c'), pairKey('a', 'b"c'));
  assert.notEqual(pairKey('a\\b', 'c'), pairKey('a', 'b\\c'));
  assert.notEqual(pairKey('a\nb', 'c'), pairKey('a', 'b\nc'));
  // 同一对编码稳定
  assert.equal(pairKey('b|c', 'a'), pairKey('b|c', 'a'));
});

/* ---------------- 批量预检 ---------------- */

test('批量预检：b|c→a 与 c→a|b 是两条关系，不互判批内重复', () => {
  const state = makeState(['a', 'b|c', 'c', 'a|b']);
  const r = validateEdgeBatch(state, [
    { parentId: 'b|c', childId: 'a' },
    { parentId: 'c', childId: 'a|b' },
  ]);
  assert.equal(r.valid, true);
  assert.deepEqual(r.items.map((i) => i.errors), [[], []]);
});

test('批量预检：b c→a 与 c→a b 是两条关系，不互判批内重复', () => {
  const state = makeState(['a', 'b c', 'c', 'a b']);
  const r = validateEdgeBatch(state, [
    { parentId: 'b c', childId: 'a' },
    { parentId: 'c', childId: 'a b' },
  ]);
  assert.equal(r.valid, true);
  assert.deepEqual(r.items.map((i) => i.errors), [[], []]);
});

test('批量预检：含「|」ID 的批内真正重复，两个副本都被标记', () => {
  const state = makeState(['a', 'b|c']);
  const r = validateEdgeBatch(state, [
    { parentId: 'b|c', childId: 'a' },
    { parentId: 'b|c', childId: 'a' },
  ]);
  assert.equal(r.valid, false);
  assert.ok(r.items[0].errors.some((m) => /批内重复/.test(m)));
  assert.ok(r.items[1].errors.some((m) => /批内重复/.test(m)));
});

test('批量预检：含「|」ID 的已有重复、自指与环路规则不变', () => {
  const state = makeState(['a', 'b|c'], [['b|c', 'a']]); // 已有 b|c→a
  const r = validateEdgeBatch(state, [
    { parentId: 'b|c', childId: 'a' }, // 与已有关系重复
    { parentId: 'b|c', childId: 'b|c' }, // 自指
    { parentId: 'a', childId: 'b|c' }, // 与已有 b|c→a 合并后成环
  ]);
  assert.equal(r.valid, false);
  assert.ok(r.items[0].errors.some((m) => /已存在/.test(m)));
  assert.ok(r.items[1].errors.some((m) => /自指/.test(m)));
  assert.ok(r.items[2].errors.some((m) => /环路/.test(m)));
});

/* ---------------- 批量提交（静默丢边回归） ---------------- */

test('批量提交：b|c→a 与 c→a|b 两条都写入，重启与撤销后不丢失', () => {
  const file = tmpFile();
  const store = storeWithSpecialIds(file, ['a', 'b|c', 'c', 'a|b']);

  const r = store.commitEdges(
    [
      { parentId: 'b|c', childId: 'a' },
      { parentId: 'c', childId: 'a|b' },
    ],
    store.getVersion(),
  );
  assert.equal(r.error, null);
  assert.equal(store.list().edges.length, 2);
  assert.deepEqual(
    edgeSetOf(store.list().edges),
    new Set(['b|c→a', 'c→a|b']),
  );

  // 重启后关系不丢失
  const reloaded = createStore(file);
  assert.deepEqual(edgeSetOf(reloaded.list().edges), new Set(['b|c→a', 'c→a|b']));

  // 撤销批量提交后两条关系一并回退，数据文件同步
  const undone = reloaded.undoLast(reloaded.getVersion());
  assert.equal(undone.error, null);
  assert.equal(createStore(file).list().edges.length, 0);
});

test('批量提交：b c→a 与 c→a b 分别保存，不静默丢边', () => {
  const file = tmpFile();
  const store = storeWithSpecialIds(file, ['a', 'b c', 'c', 'a b']);

  const r = store.commitEdges(
    [
      { parentId: 'b c', childId: 'a' },
      { parentId: 'c', childId: 'a b' },
    ],
    store.getVersion(),
  );
  assert.equal(r.error, null);
  assert.equal(store.list().edges.length, 2);
  assert.deepEqual(edgeSetOf(store.list().edges), new Set(['b c→a', 'c→a b']));
  // 重启后仍在
  assert.deepEqual(edgeSetOf(createStore(file).list().edges), new Set(['b c→a', 'c→a b']));
});

test('批量提交：含特殊字符 ID 的批内真重复仍整批拒绝、零写入', () => {
  const file = tmpFile();
  const store = storeWithSpecialIds(file, ['a', 'b|c']);
  const before = store.getVersion();
  const r = store.commitEdges(
    [
      { parentId: 'b|c', childId: 'a' },
      { parentId: 'b|c', childId: 'a' },
    ],
    store.getVersion(),
  );
  assert.ok(r.error);
  assert.equal(store.list().edges.length, 0);
  assert.equal(store.getVersion(), before);
});

/* ---------------- 备份校验与恢复 ---------------- */

test('备份校验：b|c→a 与 c→a|b 不互判重复，整份合法', () => {
  const r = validateBackup({
    members: ['a', 'b|c', 'c', 'a|b'].map((id) => ({ id, name: id })),
    edges: [
      { parentId: 'b|c', childId: 'a' },
      { parentId: 'c', childId: 'a|b' },
    ],
  });
  assert.equal(r.valid, true);
  assert.equal(r.error, null);
  assert.deepEqual(r.errors, []);
  assert.equal(r.edgeCount, 2);
  assert.deepEqual(edgeSetOf(r.edges), new Set(['b|c→a', 'c→a|b']));
});

test('备份校验：b c→a 与 c→a b 不互判重复；真正重复仍逐条报错', () => {
  const ok = validateBackup({
    members: ['a', 'b c', 'c', 'a b'].map((id) => ({ id, name: id })),
    edges: [
      { parentId: 'b c', childId: 'a' },
      { parentId: 'c', childId: 'a b' },
    ],
  });
  assert.equal(ok.valid, true);
  assert.equal(ok.edgeCount, 2);

  const dup = validateBackup({
    members: ['a', 'b|c'].map((id) => ({ id, name: id })),
    edges: [
      { parentId: 'b|c', childId: 'a' },
      { parentId: 'b|c', childId: 'a' },
    ],
  });
  assert.equal(dup.valid, false);
  assert.ok(dup.errors.some((e) => e.where === 'edge' && /重复/.test(e.message)));
});

test('备份恢复：含「|」与空格 ID 的关系恢复后不丢边，撤销、重启均正常', () => {
  const file = tmpFile();
  const store = createStore(file);
  const content = JSON.stringify({
    members: ['a', 'b|c', 'c', 'a|b', 'b c', 'a b'].map((id) => ({ id, name: id })),
    edges: [
      { parentId: 'b|c', childId: 'a' },
      { parentId: 'c', childId: 'a|b' },
      { parentId: 'b c', childId: 'a' },
      { parentId: 'c', childId: 'a b' },
    ],
  });
  const preview = store.previewRestore(content);
  assert.equal(preview.valid, true, `预览应合法：${JSON.stringify(preview.errors)}`);
  assert.equal(preview.edgeCount, 4);

  const restored = store.restoreBackup(content, preview.fingerprint, store.getVersion());
  assert.equal(restored.error, null);
  const expected = new Set(['b|c→a', 'c→a|b', 'b c→a', 'c→a b']);
  assert.deepEqual(edgeSetOf(store.list().edges), expected);

  // 重启后四条关系原样保留（ID 与数据格式不变）
  assert.deepEqual(edgeSetOf(createStore(file).list().edges), expected);

  // 撤销恢复：回到空谱；撤销本身落盘，重启后仍为空谱
  const undone = store.undoLast(store.getVersion());
  assert.equal(undone.error, null);
  assert.equal(createStore(file).list().edges.length, 0);
});

/* ---------------- 合并去重 ---------------- */

test('合并去重：替换得到的 b|c→a 与既有 c→a|b 不串项、不丢边', () => {
  // x→a 在把 x 并入 b|c 后变成 b|c→a；它与既有 c→a|b 是两条不同关系
  const state = makeState(
    ['a', 'b|c', 'c', 'a|b', 'x'],
    [
      ['x', 'a'],
      ['c', 'a|b'],
    ],
  );
  const r = previewMergeMembers(state, 'b|c', 'x');
  assert.equal(r.valid, true);
  assert.equal(r.removedDuplicateCount, 0); // 没有真正重复，不得去重
  assert.equal(r.edges.length, 2);
  assert.deepEqual(edgeSetOf(r.edges), new Set(['b|c→a', 'c→a|b']));
});

test('合并去重：替换后完全相同的关系仍按原规则去重', () => {
  // b|c→a 与 x→a 在把 x 并入 b|c 后真正重复，应去重为一条
  const state = makeState(
    ['a', 'b|c', 'x'],
    [
      ['b|c', 'a'],
      ['x', 'a'],
    ],
  );
  const r = previewMergeMembers(state, 'b|c', 'x');
  assert.equal(r.valid, true);
  assert.equal(r.removedDuplicateCount, 1);
  assert.deepEqual(edgeSetOf(r.edges), new Set(['b|c→a']));
});

/* ---------------- 变更影响比较 ---------------- */

test('变更影响：碰撞成员对 (b|c,a) 与 (b,c|a) 各自独立比较，不串对', () => {
  // (b|c, a)：直边 1 代 + 经 m1 两 2 代 → 矛盾 [1,2]
  // (b, c|a)：直边 1 代 + 经 m2、m3 共 3 代 → 矛盾 [1,3]
  // 旧拼接键下两对同为 "b|c|a"，会在比较表中互相覆盖
  const state = makeState(
    ['b|c', 'a', 'm1', 'b', 'c|a', 'm2', 'm3'],
    [
      ['b|c', 'a'],
      ['b|c', 'm1'],
      ['m1', 'a'],
      ['b', 'c|a'],
      ['b', 'm2'],
      ['m2', 'm3'],
      ['m3', 'c|a'],
    ],
  );

  // 移除 b→c|a 直边：矛盾 (b,c|a) 消失（变为一致 3 代），(b|c,a) 保持 [1,2] 不变
  const r = previewEdgeImpact(state, { action: 'remove', parentId: 'b', childId: 'c|a' });
  assert.equal(r.error, undefined);
  assert.equal(r.beforeTotal, 2);
  assert.equal(r.afterTotal, 1);
  assert.equal(r.unchangedCount, 1); // (b|c,a) 范围不变，计入 unchanged
  assert.deepEqual(r.added, []);
  assert.deepEqual(r.changed, []);
  assert.equal(r.removed.length, 1);
  assert.equal(r.removed[0].ancestorId, 'b');
  assert.equal(r.removed[0].descendantId, 'c|a');
  assert.equal(r.removed[0].before.minGen, 1);
  assert.equal(r.removed[0].before.maxGen, 3);
  // 移除后两人仍有 3 代一致路径
  assert.equal(r.removed[0].after.minGen, 3);
  assert.equal(r.removed[0].after.maxGen, 3);
});

/* ---------------- 桥梁分析 ---------------- */

test('桥梁分析：b|c→a 与 b→c|a 两条边各自定位，不串键', () => {
  // 两个互不相连的二人家族；旧拼接键下两条边同为 "b|c|a"，
  // 边表互相覆盖，桥梁会重复报告同一条边
  const state = makeState(
    ['b|c', 'a', 'b', 'c|a'],
    [
      ['b|c', 'a'],
      ['b', 'c|a'],
    ],
  );
  const r = findCriticalLinks(state);
  assert.equal(r.edgeCount, 2);
  assert.equal(r.componentCount, 2);
  assert.equal(r.bridgeCount, 2);
  assert.deepEqual(
    new Set(r.bridges.map((b) => `${b.parentId}→${b.childId}`)),
    new Set(['b|c→a', 'b→c|a']),
  );
  const first = r.bridges.find((b) => b.parentId === 'b|c');
  assert.deepEqual(first.parentSide, ['b|c']);
  assert.deepEqual(first.childSide, ['a']);
});

test('桥梁分析：含空格 ID 的边与其余边各自独立判定', () => {
  // 链 b c→a 与环（x、y、z 三角形）：链边是桥，环内边不是
  const state = makeState(
    ['b c', 'a', 'x', 'y', 'z'],
    [
      ['b c', 'a'],
      ['x', 'y'],
      ['y', 'z'],
      ['x', 'z'],
    ],
  );
  const r = findCriticalLinks(state);
  assert.equal(r.bridgeCount, 1);
  assert.equal(r.bridges[0].parentId, 'b c');
  assert.equal(r.bridges[0].childId, 'a');
});
