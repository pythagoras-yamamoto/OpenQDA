import { randomUUID } from "node:crypto";
import { callSystemOne, mapWithConcurrency } from "./typesafe.js";
import { summarizeUnits, labelGroups, writeOutline, writeNarrative } from "./gemini.js";

const NEW_GROUP_KEY = "__new_group__";
const TOP_LEVEL_TARGET = 5;
const MAX_LEVELS = 4;
const MAX_UNITS = 300;
const CONCURRENCY = 4;
const IMPORTANCE_THRESHOLD = 0.5;
const MAX_RELATION_PAIRS = 120;
const MAX_CARD_PAIRS = 120;

const RELATION_CRITERIA = {
  similar: "似た内容・同じ側面を指している",
  causal: "一方が原因や手段となってもう一方につながる",
  contradictory: "対立・矛盾する内容である",
  sequential: "時系列的に前後する事柄である",
  unrelated: "特に関係がない",
};

const RELATION_LABELS = {
  similar: "類似",
  causal: "因果/手段",
  contradictory: "対立",
  sequential: "前後",
  unrelated: "無関係",
};

// ステップ1「データの単位化」: 発言(行)単位に分割し、タイムスタンプと話者を保持する。
export function splitIntoUnits(rawText) {
  const units = [];

  for (const raw of rawText.split(/\r?\n/)) {
    let rest = raw.trim();
    if (!rest) continue;

    let time = "";
    let speaker = "";

    const timeMatch = rest.match(/^[[(]?((?:\d{1,2}:)?\d{1,2}:\d{2})[\])]?\s*/);
    if (timeMatch) {
      time = timeMatch[1];
      rest = rest.slice(timeMatch[0].length);
    }

    // 「インタビュイー 佐々木:」のように話者名に空白が入る形式も拾う。
    const speakerMatch = rest.match(/^[【[]?([^:：\n]{1,24}?)[\]】]?\s*[:：]\s*/);
    if (speakerMatch) {
      speaker = speakerMatch[1];
      rest = rest.slice(speakerMatch[0].length);
    }

    if (rest.length >= 4) units.push({ index: units.length, time, speaker, text: rest });
  }

  return units;
}

// ステップ2「下線を引く」: 全部を重要とみなさず、分析に値する箇所だけをjevに選ばせる。
async function judgeImportance(texts, onProgress) {
  let done = 0;
  return mapWithConcurrency(texts, CONCURRENCY, async (unit) => {
    const result = await callSystemOne(unit, {
      important: {
        type: "noul",
        instructions:
          "この発言は、議論の内容を理解する上で重要な情報(課題・意見・判断・要望・事実)を含んでいますか。" +
          "単なる相槌・挨拶・確認・場つなぎの発言であれば「いいえ」です。",
      },
    });
    done += 1;
    onProgress?.({ phase: "underline", done, total: texts.length });
    return result.answers.important.noul;
  });
}

async function assignToGroup(text, groups, level) {
  // 最初の段はカード同士の近さで寄せ、2段目以降は「より大きなテーマ」にまとめさせる。
  const instructions =
    level === 0
      ? "この内容は、以下のどのグループの趣旨に最も近いですか。近いものがなければ新しいグループを選んでください。"
      : "この見出しは、以下のどのグループと同じ大きなテーマとしてまとめられますか。まとめられるものがなければ新しいグループを選んでください。";
  const newGroupText =
    level === 0
      ? "既存のどのグループの趣旨にも当てはまらない、新しい話題である"
      : "既存のどのグループとも同じテーマにはまとめられない、独立した話題である";

  const criteria = {};
  for (const g of groups) criteria[g.id] = g.runningRep;
  criteria[NEW_GROUP_KEY] = newGroupText;

  const result = await callSystemOne(text, {
    assignment: { type: "choice", instructions, criteria },
  });

  return result.answers.assignment.choice;
}

// ステップ3「グループ化」: 似た内容を近くに集める逐次オンラインクラスタリング。
async function clusterOnce(nodes, level, onProgress) {
  const groups = [];

  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];

    if (groups.length === 0) {
      groups.push({ id: randomUUID(), runningRep: node.text, memberNodes: [node] });
    } else {
      const choice = await assignToGroup(node.text, groups, level);
      const target = groups.find((g) => g.id === choice);
      if (choice === NEW_GROUP_KEY || !target) {
        groups.push({ id: randomUUID(), runningRep: node.text, memberNodes: [node] });
      } else {
        target.memberNodes.push(node);
      }
    }

    onProgress?.(i + 1, nodes.length);
  }

  return groups.map(({ id, memberNodes }) => ({ id, memberNodes }));
}

// グループ化と見出し付けを、グループ数が十分絞られるまで繰り返す。
async function buildHierarchy(cards, onProgress) {
  let currentNodes = cards.map((card) => ({
    id: card.id,
    text: card.text,
    original: card.original,
    isLeaf: true,
  }));
  const levelSummaries = [];
  let level = 0;

  while (level < MAX_LEVELS) {
    const groups = await clusterOnce(currentNodes, level, (done, total) =>
      onProgress?.({ phase: "cluster", level, done, total }),
    );

    // 2段目以降で1件しか集まらなかったものは、包まずにそのまま上の段へ送る
    // (同じ内容の見出しが何重にも重なるのを防ぐ)。
    const toLabel = level === 0 ? groups : groups.filter((g) => g.memberNodes.length > 1);
    if (level > 0 && toLabel.length === 0) break;

    onProgress?.({ phase: "label", level, done: 0, total: toLabel.length });
    const labels = await labelGroups(toLabel.map((g) => g.memberNodes.map((n) => n.text)));
    onProgress?.({ phase: "label", level, done: toLabel.length, total: toLabel.length });

    let labelIndex = 0;
    const nextNodes = groups.map((g) =>
      level > 0 && g.memberNodes.length === 1
        ? g.memberNodes[0]
        : { id: g.id, text: labels[labelIndex++], isLeaf: false, memberNodes: g.memberNodes },
    );

    levelSummaries.push({ level, groupCount: nextNodes.length, nodeCount: currentNodes.length });
    currentNodes = nextNodes;
    level += 1;

    if (nextNodes.length <= TOP_LEVEL_TARGET) break;
  }

  return { topNodes: currentNodes, levelSummaries };
}

// カードを直接抱えているグループ(図解で枠として描く単位)を集める。
function collectCardGroups(nodes, acc = []) {
  for (const n of nodes) {
    if (n.isLeaf) continue;
    if (n.memberNodes.some((m) => m.isLeaf)) acc.push(n);
    else collectCardGroups(n.memberNodes, acc);
  }
  return acc;
}

// ステップ4「図解化」その1: グループ同士の前後関係・因果関係を把握する。
async function computeGroupRelations(groups, onProgress) {
  if (groups.length < 2) return [];

  const pairs = [];
  for (let gap = 1; gap < groups.length; gap++) {
    for (let i = 0; i + gap < groups.length; i++) pairs.push([groups[i], groups[i + gap]]);
  }
  const limited = pairs.slice(0, MAX_RELATION_PAIRS); // 近い並び順のペアから優先する

  let done = 0;
  return mapWithConcurrency(limited, CONCURRENCY, async ([a, b]) => {
    const result = await callSystemOne(
      { group_a: a.text, group_b: b.text },
      {
        relatedness: {
          type: "score",
          instructions: "2つのグループ(話題のまとまり)は、内容的にどれくらい関連していますか。",
          criteria: [
            "全く無関係。",
            "やや関連がある。",
            "明確に関連している。",
            "強く関連している(同じ問題の異なる側面、または一方がもう一方の原因・手段になっている)。",
          ],
        },
        relation_type: {
          type: "choice",
          instructions: "グループAからグループBへの関係として最も当てはまるものを選んでください。",
          criteria: RELATION_CRITERIA,
        },
      },
    );

    done += 1;
    onProgress?.({ phase: "relations", done, total: limited.length });

    return {
      from: a.id,
      to: b.id,
      relatedness: result.answers.relatedness.score,
      relatednessMax: Object.keys(result.answers.relatedness.legend).length - 1,
      type: result.answers.relation_type.choice,
    };
  });
}

// ステップ4「図解化」その2: グループ内のカード同士の前後関係・因果関係を把握する。
async function computeCardRelations(cardGroups, onProgress) {
  const pairs = [];
  for (const g of cardGroups) {
    const cards = g.memberNodes.filter((m) => m.isLeaf);
    for (let i = 0; i + 1 < cards.length; i++) pairs.push([cards[i], cards[i + 1]]);
  }
  const limited = pairs.slice(0, MAX_CARD_PAIRS);
  if (limited.length === 0) return [];

  let done = 0;
  const edges = await mapWithConcurrency(limited, CONCURRENCY, async ([a, b]) => {
    const result = await callSystemOne(
      { card_a: a.text, card_b: b.text },
      {
        relation_type: {
          type: "choice",
          instructions: "カードAからカードBへの関係として最も当てはまるものを選んでください。",
          criteria: RELATION_CRITERIA,
        },
      },
    );

    done += 1;
    onProgress?.({ phase: "cardRelations", done, total: limited.length });

    return { from: a.id, to: b.id, type: result.answers.relation_type.choice };
  });

  return edges.filter((e) => e.type === "causal" || e.type === "sequential");
}

// 関連の強いグループが隣り合うように並べ替える(似たものを近くに、異なるものを遠くに)。
function orderGroups(groups, relations) {
  if (groups.length <= 2) return groups.map((g) => g.id);

  const pairKey = (a, b) => [a, b].sort().join("|");
  const weight = new Map();
  for (const e of relations) weight.set(pairKey(e.from, e.to), e.relatedness);

  const totalWeight = (id) =>
    groups.reduce((sum, g) => (g.id === id ? sum : sum + (weight.get(pairKey(id, g.id)) ?? 0)), 0);

  const remaining = new Set(groups.map((g) => g.id));
  let current = [...remaining].sort((a, b) => totalWeight(b) - totalWeight(a))[0];
  const order = [current];
  remaining.delete(current);

  while (remaining.size > 0) {
    let best = null;
    let bestWeight = -1;
    for (const id of remaining) {
      const w = weight.get(pairKey(current, id)) ?? 0;
      if (w > bestWeight) {
        bestWeight = w;
        best = id;
      }
    }
    order.push(best);
    remaining.delete(best);
    current = best;
  }

  return order;
}

// ステップ7「検証・考察」: 元データとストーリーラインを照らし合わせ、矛盾がないかjevに確かめさせる。
async function verifyNarrative(rawText, narrative) {
  const result = await callSystemOne(
    { 元データ: rawText, ストーリーライン: narrative },
    {
      consistency: {
        type: "score",
        instructions: "ストーリーラインは、元データの内容とどれくらい整合していますか。",
        criteria: [
          "元データと矛盾しており、内容を正しく説明できていない。",
          "おおむね整合しているが、一部に元データから読み取れない記述がある。",
          "整合している。元データの内容を正しく説明している。",
          "元データ全体を過不足なく、正確に説明できている。",
        ],
      },
      contradiction: {
        type: "noul",
        instructions: "ストーリーラインに、元データと矛盾する記述が含まれていますか。",
      },
      overreach: {
        type: "noul",
        instructions:
          "ストーリーラインは、元データの一部だけを取り出して過度に一般化した、" +
          "あるいはセンセーショナルな解釈を加えていますか。",
      },
    },
  );

  const a = result.answers;
  return {
    consistency: a.consistency.score,
    consistencyMax: Object.keys(a.consistency.legend).length - 1,
    legend: a.consistency.legend,
    contradiction: a.contradiction.noul,
    overreach: a.overreach.noul,
  };
}

function renderHierarchyOutline(nodes, depth = 0) {
  return nodes
    .map((n) => {
      const indent = "  ".repeat(depth);
      if (n.isLeaf) return `${indent}- ${n.text}`;
      return `${indent}- 【${n.text}】\n${renderHierarchyOutline(n.memberNodes, depth + 1)}`;
    })
    .join("\n");
}

function renderRelationsOutline(groups, relations) {
  const textById = new Map(groups.map((g) => [g.id, g.text]));
  const lines = relations
    .filter((e) => e.relatedness >= 1 && e.type !== "unrelated")
    .sort((a, b) => b.relatedness - a.relatedness)
    .map(
      (e) =>
        `- 「${textById.get(e.from)}」→「${textById.get(e.to)}」: ` +
        `${RELATION_LABELS[e.type] ?? e.type}(関連度 ${e.relatedness.toFixed(2)}/${e.relatednessMax})`,
    );
  return lines.length ? lines.join("\n") : "(明確な関連は検出されませんでした)";
}

// 前半: 下線を引いて切片(カード)を作るところまで。ここで人が確認・編集する。
export async function extractCards(rawText, onProgress) {
  const units = splitIntoUnits(rawText);

  if (units.length < 2) {
    throw new Error("分割できる発言が少なすぎます(2件以上必要です)。");
  }
  if (units.length > MAX_UNITS) {
    throw new Error(`発言数が多すぎます(${units.length}件 > 上限${MAX_UNITS}件)。データを分割してください。`);
  }

  const importance = await judgeImportance(units.map((u) => u.text), onProgress);
  const marked = units.map((u, i) => ({
    ...u,
    importance: importance[i],
    important: importance[i] >= IMPORTANCE_THRESHOLD,
  }));

  let targets = marked.filter((u) => u.important);
  if (targets.length < 2) {
    targets = [...marked].sort((a, b) => b.importance - a.importance).slice(0, Math.min(10, marked.length));
  }

  onProgress?.({ phase: "cards", done: 0, total: targets.length });
  const headlines = await summarizeUnits(targets.map((u) => u.text));
  onProgress?.({ phase: "cards", done: targets.length, total: targets.length });

  const cards = targets.map((u, i) => ({
    id: `card-${u.index}`,
    unitIndex: u.index,
    text: headlines[i],
    favorite: false,
  }));

  return { units: marked, cards };
}

// 後半: 確定した切片をもとに、グループ化・図解化・文章化・検証まで行う。
export async function analyzeCards(rawText, inputCards, onProgress) {
  if (!Array.isArray(inputCards) || inputCards.length < 2) {
    throw new Error("切片が少なすぎます(2件以上必要です)。");
  }

  const units = splitIntoUnits(rawText);
  const cards = inputCards.map((c, i) => ({
    id: c.id ?? `card-${i}`,
    text: String(c.text ?? "").trim(),
    original: units[c.unitIndex]?.text ?? c.text,
  }));

  const { topNodes, levelSummaries } = await buildHierarchy(cards, onProgress);

  const cardGroups = collectCardGroups(topNodes);
  const relations = await computeGroupRelations(cardGroups, onProgress);
  const cardRelations = await computeCardRelations(cardGroups, onProgress);
  const layoutOrder = orderGroups(cardGroups, relations);

  // 図解で点線の枠として描くのは、複数のグループをまとめた上位グループだけ。
  const frames = topNodes
    .filter((n) => !cardGroups.includes(n))
    .map((n) => ({
      id: n.id,
      label: n.text,
      groupIds: collectCardGroups([n]).map((g) => g.id),
    }));

  const relationsOutline = renderRelationsOutline(cardGroups, relations);

  onProgress?.({ phase: "outline", done: 0, total: 1 });
  const outline = await writeOutline(renderHierarchyOutline(topNodes), relationsOutline);
  onProgress?.({ phase: "outline", done: 1, total: 1 });

  onProgress?.({ phase: "narrative", done: 0, total: 1 });
  const narrative = await writeNarrative(outline, relationsOutline);
  onProgress?.({ phase: "narrative", done: 1, total: 1 });

  onProgress?.({ phase: "verify", done: 0, total: 1 });
  const verification = await verifyNarrative(rawText, narrative);
  onProgress?.({ phase: "verify", done: 1, total: 1 });

  return {
    levelSummaries,
    topGroups: topNodes,
    cardGroups: cardGroups.map((g) => ({
      id: g.id,
      label: g.text,
      cards: g.memberNodes
        .filter((m) => m.isLeaf)
        .map((c) => ({ id: c.id, text: c.text, original: c.original })),
    })),
    frames,
    relations,
    cardRelations,
    layoutOrder,
    outline,
    narrative,
    verification,
  };
}
