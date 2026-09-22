const RELATION_LABELS = {
  similar: "類似",
  causal: "因果/手段",
  contradictory: "対立",
  sequential: "前後",
  unrelated: "無関係",
};

const RELATION_STYLE = {
  causal: { color: "var(--rel-causal)", dash: null, arrow: true },
  sequential: { color: "var(--rel-sequential)", dash: null, arrow: true },
  similar: { color: "var(--rel-similar)", dash: "5 4", arrow: false },
  contradictory: { color: "var(--rel-contradictory)", dash: "2 4", arrow: false },
};

const BOX_W = 268;
const CARD_H = 22;
const CARD_GAP = 4;
const CARD_GAP_REL = 20; // カード間に矢印を描くときの隙間
const HEADER_H = 28;
const BOX_PAD = 10;
const COL_GAP = 64;
const ROW_GAP = 52;
const FRAME_PAD = 16;

const state = {
  rawText: "",
  units: [],
  cards: [],
  analysis: null,
  activeCardId: null,
  favOnly: false,
};

const $ = (id) => document.getElementById(id);

/* ---------- 画面遷移・ステータス ---------- */

function showView(name) {
  document.querySelectorAll(".view").forEach((v) => v.classList.toggle("active", v.id === `view-${name}`));
  document.querySelectorAll("#tabs button").forEach((b) => b.classList.toggle("active", b.dataset.view === name));
}

function setStatus(text, isError = false) {
  const el = $("status");
  if (!text) {
    el.hidden = true;
    return;
  }
  el.textContent = text;
  el.classList.toggle("error", isError);
  el.hidden = false;
}

function setBusy(busy) {
  $("extract").disabled = busy;
  $("analyze").disabled = busy;
}

function describeProgress(evt) {
  const level = evt.level !== undefined ? `レベル${evt.level}` : "";
  switch (evt.phase) {
    case "underline": return `重要な発言を判定中(下線) ${evt.done}/${evt.total}`;
    case "cards": return `切片を作成中 ${evt.done}/${evt.total}`;
    case "cluster": return `${level}: グループ化中 ${evt.done}/${evt.total}`;
    case "label": return `${level}: 見出しを作成中 ${evt.done}/${evt.total}`;
    case "relations": return `グループ間の関係を分析中 ${evt.done}/${evt.total}`;
    case "cardRelations": return `切片間の関係を分析中 ${evt.done}/${evt.total}`;
    case "outline": return "ストーリーのアウトラインを作成中…";
    case "narrative": return "ストーリーラインを執筆中…";
    case "verify": return "元データと照合して検証中…";
    default: return "";
  }
}

// NDJSONストリームを読みながら進捗を表示し、最終結果を返す。
async function streamRequest(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok || !res.body) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error ?? res.statusText);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result = null;
  let failure = null;

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop();

    for (const line of lines) {
      if (!line.trim()) continue;
      const evt = JSON.parse(line);
      if (evt.type === "progress") setStatus(describeProgress(evt));
      else if (evt.type === "done") result = evt.result;
      else if (evt.type === "error") failure = evt.error;
    }
  }

  if (failure) throw new Error(failure);
  return result;
}

/* ---------- 元データ(左ペイン) ---------- */

function renderTranscript() {
  const el = $("transcript");
  el.innerHTML = "";

  const cardByUnit = new Map(state.cards.map((c) => [c.unitIndex, c]));

  for (const unit of state.units) {
    const div = document.createElement("div");
    div.className = "utterance";
    div.dataset.unitIndex = String(unit.index);
    if (cardByUnit.has(unit.index)) div.classList.add("marked");

    if (unit.time || unit.speaker) {
      const meta = document.createElement("div");
      meta.className = "utterance-meta";
      if (unit.time) {
        const t = document.createElement("span");
        t.textContent = unit.time;
        meta.appendChild(t);
      }
      if (unit.speaker) {
        const s = document.createElement("span");
        s.className = "speaker";
        s.textContent = unit.speaker;
        meta.appendChild(s);
      }
      div.appendChild(meta);
    }

    const text = document.createElement("div");
    text.className = "utterance-text";
    text.textContent = unit.text;
    div.appendChild(text);

    div.addEventListener("click", () => {
      const card = state.cards.find((c) => c.unitIndex === unit.index);
      if (card) {
        selectCard(card.id, "transcript");
      } else {
        addCardFromUnit(unit);
      }
    });

    el.appendChild(div);
  }

  $("unit-meta").textContent = `${state.units.length}発言 / ${state.cards.length}切片`;
}

/* ---------- 切片カード(右ペイン) ---------- */

function renderCards() {
  const el = $("cards");
  el.innerHTML = "";

  const visible = state.favOnly ? state.cards.filter((c) => c.favorite) : state.cards;

  if (visible.length === 0) {
    const p = document.createElement("p");
    p.className = "empty";
    p.textContent = state.favOnly ? "お気に入りの切片はありません。" : "切片がありません。";
    el.appendChild(p);
    return;
  }

  for (const card of visible) {
    const div = document.createElement("div");
    div.className = "card";
    div.dataset.cardId = card.id;
    if (card.id === state.activeCardId) div.classList.add("active");

    const fav = document.createElement("button");
    fav.className = `card-fav${card.favorite ? " on" : ""}`;
    fav.type = "button";
    fav.textContent = card.favorite ? "♥" : "♡";
    fav.title = "お気に入り";
    fav.addEventListener("click", (e) => {
      e.stopPropagation();
      card.favorite = !card.favorite;
      renderCards();
    });

    const text = document.createElement("div");
    text.className = "card-text";
    text.textContent = card.text;
    text.addEventListener("blur", () => {
      card.text = text.textContent.trim() || card.text;
      text.textContent = card.text;
      text.contentEditable = "false";
    });
    text.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        text.blur();
      }
    });

    const actions = document.createElement("div");
    actions.className = "card-actions";

    const edit = document.createElement("button");
    edit.type = "button";
    edit.textContent = "✎";
    edit.title = "編集";
    edit.addEventListener("click", (e) => {
      e.stopPropagation();
      text.contentEditable = "true";
      text.focus();
      document.getSelection().selectAllChildren(text);
    });

    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "✕";
    remove.title = "この切片を削除";
    remove.addEventListener("click", (e) => {
      e.stopPropagation();
      state.cards = state.cards.filter((c) => c.id !== card.id);
      renderCards();
      renderTranscript();
    });

    actions.append(edit, remove);

    div.addEventListener("click", () => selectCard(card.id, "cards"));
    div.append(fav, text, actions);
    el.appendChild(div);
  }
}

// カードと元データの相互リンク。クリックした側と反対側をスクロールして示す。
function selectCard(cardId, from) {
  state.activeCardId = cardId;
  const card = state.cards.find((c) => c.id === cardId);

  document.querySelectorAll(".card").forEach((el) => el.classList.toggle("active", el.dataset.cardId === cardId));
  document.querySelectorAll(".utterance").forEach((el) =>
    el.classList.toggle("active", card && Number(el.dataset.unitIndex) === card.unitIndex),
  );

  if (!card) return;

  if (from === "cards") {
    document
      .querySelector(`.utterance[data-unit-index="${card.unitIndex}"]`)
      ?.scrollIntoView({ block: "center", behavior: "smooth" });
  } else {
    document
      .querySelector(`.card[data-card-id="${cardId}"]`)
      ?.scrollIntoView({ block: "center", behavior: "smooth" });
  }
}

function addCardFromUnit(unit) {
  const card = {
    id: `card-${unit.index}`,
    unitIndex: unit.index,
    text: unit.text.length > 20 ? `${unit.text.slice(0, 20)}…` : unit.text,
    favorite: false,
  };
  const at = state.cards.findIndex((c) => c.unitIndex > unit.index);
  if (at === -1) state.cards.push(card);
  else state.cards.splice(at, 0, card);

  renderCards();
  renderTranscript();
  selectCard(card.id, "transcript");
}

/* ---------- 図解 ---------- */

function truncate(text, max) {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function svgEl(name, attrs = {}) {
  const el = document.createElementNS("http://www.w3.org/2000/svg", name);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

// 箱の中心から目標点に向かう線が、箱の境界と交わる点を求める。
function edgePoint(box, tx, ty) {
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const dx = tx - cx;
  const dy = ty - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy };
  const sx = dx === 0 ? Infinity : box.w / 2 / Math.abs(dx);
  const sy = dy === 0 ? Infinity : box.h / 2 / Math.abs(dy);
  const s = Math.min(sx, sy);
  return { x: cx + dx * s, y: cy + dy * s };
}

function layoutBoxes(cardGroups, layoutOrder, frames, cardRelations, availableWidth) {
  const byId = new Map(cardGroups.map((g) => [g.id, g]));
  const relatedCards = new Set(cardRelations.map((e) => `${e.from}|${e.to}`));

  const gapAfter = (group, i) => {
    const next = group.cards[i + 1];
    if (!next) return 0;
    return relatedCards.has(`${group.cards[i].id}|${next.id}`) ? CARD_GAP_REL : CARD_GAP;
  };

  const boxHeight = (group) =>
    HEADER_H + group.cards.reduce((h, _, i) => h + CARD_H + gapAfter(group, i), 0) + BOX_PAD;

  // 上位グループは点線の枠として1枠1行に。枠に属さないグループは2列のグリッドに流し込む。
  const orderIndex = new Map(layoutOrder.map((id, i) => [id, i]));
  const rows = [];
  const framed = new Set();

  for (const frame of frames) {
    const ids = [...frame.groupIds].sort((a, b) => (orderIndex.get(a) ?? 0) - (orderIndex.get(b) ?? 0));
    ids.forEach((id) => framed.add(id));
    rows.push({ frame, groups: ids.map((id) => byId.get(id)).filter(Boolean) });
  }

  const loose = layoutOrder.filter((id) => !framed.has(id)).map((id) => byId.get(id)).filter(Boolean);
  const fit = Math.floor((availableWidth + COL_GAP) / (BOX_W + COL_GAP));
  const cols = Math.min(Math.max(loose.length, 1), Math.max(fit, 1), 4);
  for (let i = 0; i < loose.length; i += cols) {
    rows.push({ frame: null, groups: loose.slice(i, i + cols) });
  }

  const boxes = new Map();
  let y = 0;
  let maxRight = 0;

  for (const row of rows) {
    const hasFrame = Boolean(row.frame);
    const top = y + (hasFrame ? FRAME_PAD + 18 : 0);
    let x = hasFrame ? FRAME_PAD : 0;
    let rowHeight = 0;

    for (const group of row.groups) {
      const h = boxHeight(group);
      boxes.set(group.id, { x, y: top, w: BOX_W, h, group });
      rowHeight = Math.max(rowHeight, h);
      x += BOX_W + COL_GAP;
      maxRight = Math.max(maxRight, x - COL_GAP + (hasFrame ? FRAME_PAD : 0));
    }

    row.bounds = {
      x: 0,
      y,
      w: x - COL_GAP + (hasFrame ? FRAME_PAD : 0),
      h: rowHeight + (hasFrame ? FRAME_PAD * 2 + 18 : 0),
    };
    y += row.bounds.h + ROW_GAP;
  }

  return { rows, boxes, width: maxRight + 4, height: Math.max(y - ROW_GAP, 0) + 4, gapAfter };
}

function renderDiagram(analysis) {
  const container = $("diagram");
  container.innerHTML = "";

  const { cardGroups, layoutOrder, frames, relations, cardRelations } = analysis;
  if (cardGroups.length === 0) return;

  // 非表示のまま描くと clientWidth が 0 になるので、ウィンドウ幅で補う。
  const available = Math.max((container.clientWidth || window.innerWidth - 80) - 24, BOX_W);
  const { rows, boxes, width, height, gapAfter } = layoutBoxes(
    cardGroups,
    layoutOrder,
    frames,
    cardRelations,
    available,
  );

  const svg = svgEl("svg", { viewBox: `-2 -2 ${width + 4} ${height + 4}`, width: width + 4, height: height + 4 });

  const defs = svgEl("defs");
  for (const [type, style] of Object.entries(RELATION_STYLE)) {
    const marker = svgEl("marker", {
      id: `arrow-${type}`,
      viewBox: "0 0 10 10",
      refX: "9",
      refY: "5",
      markerWidth: "6",
      markerHeight: "6",
      orient: "auto-start-reverse",
    });
    marker.appendChild(svgEl("path", { d: "M 0 0 L 10 5 L 0 10 z", fill: style.color }));
    defs.appendChild(marker);
  }
  svg.appendChild(defs);

  for (const row of rows) {
    if (!row.frame) continue;
    svg.appendChild(
      svgEl("rect", {
        x: row.bounds.x,
        y: row.bounds.y,
        width: row.bounds.w,
        height: row.bounds.h,
        rx: 12,
        fill: "none",
        stroke: "var(--frame)",
        "stroke-dasharray": "6 5",
      }),
    );
    const label = svgEl("text", { x: row.bounds.x + 12, y: row.bounds.y + 18, class: "frame-label" });
    label.textContent = row.frame.label;
    svg.appendChild(label);
  }

  // 線が増えすぎないよう、関連の強い順に絞って描く。
  const drawnEdges = relations
    .filter((e) => RELATION_STYLE[e.type] && e.relatedness >= 1.5)
    .sort((a, b) => b.relatedness - a.relatedness)
    .slice(0, 10);

  for (const edge of drawnEdges) {
    const style = RELATION_STYLE[edge.type];
    const from = boxes.get(edge.from);
    const to = boxes.get(edge.to);
    if (!from || !to) continue;

    const p1 = edgePoint(from, to.x + to.w / 2, to.y + to.h / 2);
    const p2 = edgePoint(to, from.x + from.w / 2, from.y + from.h / 2);
    const line = svgEl("line", {
      x1: p1.x,
      y1: p1.y,
      x2: p2.x,
      y2: p2.y,
      stroke: style.color,
      "stroke-width": 1.6,
    });
    if (style.dash) line.setAttribute("stroke-dasharray", style.dash);
    if (style.arrow) line.setAttribute("marker-end", `url(#arrow-${edge.type})`);
    svg.appendChild(line);
  }

  for (const box of boxes.values()) {
    const g = svgEl("g");
    g.appendChild(
      svgEl("rect", {
        x: box.x,
        y: box.y,
        width: box.w,
        height: box.h,
        rx: 10,
        fill: "var(--group-bg)",
        stroke: "var(--border)",
      }),
    );

    const header = svgEl("text", { x: box.x + 12, y: box.y + 19, class: "group-label" });
    header.textContent = truncate(box.group.label, 18);
    g.appendChild(header);

    let y = box.y + HEADER_H;
    box.group.cards.forEach((card, i) => {
      const rect = svgEl("rect", {
        x: box.x + 10,
        y,
        width: box.w - 20,
        height: CARD_H,
        rx: 3,
        fill: "var(--note-bg)",
        stroke: "var(--note-border)",
      });
      const title = svgEl("title");
      title.textContent = card.original ?? card.text;
      rect.appendChild(title);

      const label = svgEl("text", { x: box.x + 16, y: y + 15, class: "card-text" });
      label.textContent = truncate(card.text, 21);

      g.append(rect, label);

      const gap = gapAfter(box.group, i);
      if (gap === CARD_GAP_REL) {
        const ax = box.x + box.w / 2;
        g.appendChild(
          svgEl("line", {
            x1: ax,
            y1: y + CARD_H + 3,
            x2: ax,
            y2: y + CARD_H + gap - 3,
            stroke: "var(--rel-causal)",
            "stroke-width": 1.4,
            "marker-end": "url(#arrow-causal)",
          }),
        );
      }
      y += CARD_H + gap;
    });

    svg.appendChild(g);
  }

  container.appendChild(svg);
}

function renderRelations(cardGroups, relations) {
  const el = $("relations");
  const textById = new Map(cardGroups.map((g) => [g.id, g.label]));
  el.innerHTML = "";

  const sorted = relations
    .filter((e) => e.relatedness >= 1.5 && e.type !== "unrelated")
    .sort((a, b) => b.relatedness - a.relatedness);

  if (sorted.length === 0) {
    const li = document.createElement("li");
    li.textContent = "明確な関連は検出されませんでした。";
    el.appendChild(li);
    return;
  }

  for (const edge of sorted) {
    const li = document.createElement("li");
    li.textContent =
      `${textById.get(edge.from)} → ${textById.get(edge.to)} — ` +
      `${RELATION_LABELS[edge.type] ?? edge.type}(関連度 ${edge.relatedness.toFixed(2)}/${edge.relatednessMax})`;
    el.appendChild(li);
  }
}

/* ---------- ストーリー ---------- */

function renderOutline(outline) {
  const el = $("outline");
  el.innerHTML = "";

  outline.forEach((section, i) => {
    const wrap = document.createElement("div");
    wrap.className = "outline-section";

    const title = document.createElement("div");
    title.className = "outline-title";
    title.textContent = `${i + 1}. ${section.title}`;
    wrap.appendChild(title);

    section.items.forEach((item, j) => {
      const sub = document.createElement("div");
      sub.className = "outline-item";
      sub.textContent = `${i + 1}-${j + 1}. ${item}`;
      wrap.appendChild(sub);
    });

    el.appendChild(wrap);
  });
}

function renderVerification(v) {
  const el = $("verification");
  el.innerHTML = "";

  const score = document.createElement("p");
  score.className = "verify-score";
  score.textContent = `整合性: ${v.legend[Math.round(v.consistency)]}(${v.consistency.toFixed(2)} / ${v.consistencyMax})`;
  el.appendChild(score);

  const flags = document.createElement("div");
  flags.className = "verify-flags";
  for (const item of [
    { label: "元データとの矛盾", value: v.contradiction },
    { label: "過度な一般化・センセーショナルな解釈", value: v.overreach },
  ]) {
    const chip = document.createElement("span");
    chip.className = item.value >= 0.5 ? "chip warn" : "chip ok";
    chip.textContent = `${item.label}: ${Math.round(item.value * 100)}%`;
    flags.appendChild(chip);
  }
  el.appendChild(flags);

  if (v.contradiction >= 0.5 || v.overreach >= 0.5 || v.consistency < 1.5) {
    const note = document.createElement("p");
    note.className = "verify-note";
    note.textContent = "矛盾や飛躍の可能性があります。図解に戻って切片やグループを見直してください。";
    el.appendChild(note);
  }
}

/* ---------- 実行 ---------- */

async function extract() {
  const text = $("input").value.trim();
  if (!text) return;

  setBusy(true);
  setStatus("読み込み中…");

  try {
    const result = await streamRequest("/api/extract", { text });
    state.rawText = text;
    state.units = result.units;
    state.cards = result.cards;
    state.analysis = null;
    state.activeCardId = null;

    renderTranscript();
    renderCards();

    document.querySelectorAll("#tabs button").forEach((b) => {
      b.disabled = b.dataset.view !== "source";
    });
    $("copy-cards").hidden = false;
    $("analyze").hidden = false;
    showView("source");

    const excluded = state.units.length - state.cards.length;
    setStatus(`${state.cards.length}件の切片を作成しました(${excluded}件は重要度が低いと判定)。内容を確認・編集してから「グループ化へ進む」を押してください。`);
  } catch (err) {
    setStatus(`エラー: ${err.message}`, true);
  } finally {
    setBusy(false);
  }
}

async function analyze() {
  if (state.cards.length < 2) {
    setStatus("切片が2件以上必要です。", true);
    return;
  }

  setBusy(true);
  setStatus("グループ化を開始します…");

  try {
    const analysis = await streamRequest("/api/analyze", {
      text: state.rawText,
      cards: state.cards.map((c) => ({ id: c.id, unitIndex: c.unitIndex, text: c.text })),
    });
    state.analysis = analysis;

    document.querySelectorAll("#tabs button").forEach((b) => (b.disabled = false));
    showView("diagram");

    renderDiagram(analysis);
    renderRelations(analysis.cardGroups, analysis.relations);
    renderOutline(analysis.outline);
    $("narrative").textContent = analysis.narrative;
    renderVerification(analysis.verification);

    setStatus("分析が完了しました。");
  } catch (err) {
    setStatus(`エラー: ${err.message}`, true);
  } finally {
    setBusy(false);
  }
}

/* ---------- イベント ---------- */

$("file").addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (file) $("input").value = await file.text();
});

$("extract").addEventListener("click", extract);
$("analyze").addEventListener("click", analyze);

$("fav-only").addEventListener("change", (e) => {
  state.favOnly = e.target.checked;
  renderCards();
});

$("copy-cards").addEventListener("click", async () => {
  const text = state.cards.map((c) => c.text).join("\n");
  await navigator.clipboard.writeText(text);
  setStatus(`${state.cards.length}件の切片をコピーしました。`);
});

document.querySelectorAll("#tabs button").forEach((b) => {
  b.addEventListener("click", () => {
    if (b.disabled) return;
    showView(b.dataset.view);
    // 表示されてから測らないと列数が決まらないので、図解は開くたびに描き直す。
    if (b.dataset.view === "diagram" && state.analysis) renderDiagram(state.analysis);
  });
});
