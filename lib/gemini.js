import { GoogleGenAI, Type } from "@google/genai";

const MODEL = "gemini-3.6-flash";
const MAX_RETRIES = 4;
const RETRYABLE = /"code":\s*(429|500|503)|UNAVAILABLE|RESOURCE_EXHAUSTED/;
const DAILY_QUOTA_EXCEEDED = /PerDay/;

let client;
function getClient() {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY が設定されていません(.env を確認してください)。");
  }
  if (!client) client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  return client;
}

// Geminiは一時的な高負荷で503/RESOURCE_EXHAUSTEDを返すことがあるため指数バックオフでリトライする。
async function generateContentWithRetry(params) {
  let attempt = 0;
  for (;;) {
    try {
      return await getClient().models.generateContent(params);
    } catch (err) {
      if (DAILY_QUOTA_EXCEEDED.test(err.message)) {
        throw new Error(
          "Geminiの1日あたりのリクエスト上限に達しました(無料枠は1日20回など)。" +
            "翌日まで待つか、Google AI Studioで有料プランに切り替えてください。",
        );
      }
      if (!RETRYABLE.test(err.message) || attempt >= MAX_RETRIES) throw err;
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
      attempt += 1;
    }
  }
}

const CHUNK_SIZE = 25; // 大きなバッチだと件数がズレることがあるため、小さく分けて確実性を上げる
const CHUNK_RETRIES = 2;

function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
  return chunks;
}

async function generateArrayOnce({ prompt, arrayField, expectedLength }) {
  const response = await generateContentWithRetry({
    model: MODEL,
    contents: prompt,
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          [arrayField]: { type: Type.ARRAY, items: { type: Type.STRING } },
        },
        required: [arrayField],
      },
    },
  });

  let parsed;
  try {
    parsed = JSON.parse(response.text);
  } catch {
    return null;
  }

  const arr = parsed[arrayField];
  return Array.isArray(arr) && arr.length === expectedLength ? arr : null;
}

// items をチャンクに分けて生成し、件数が合わなければチャンク単位でリトライ、
// それでも合わなければ1件ずつ個別生成にフォールバックして必ず要素数を揃える。
async function generateArrayRobust({ items, arrayField, buildPrompt, fallbackFor }) {
  const chunks = chunkArray(items, CHUNK_SIZE);
  const results = [];

  for (const chunkItems of chunks) {
    let arr = null;
    for (let attempt = 0; attempt <= CHUNK_RETRIES && !arr; attempt++) {
      arr = await generateArrayOnce({
        prompt: buildPrompt(chunkItems),
        arrayField,
        expectedLength: chunkItems.length,
      });
    }

    if (!arr) {
      arr = [];
      for (const item of chunkItems) {
        const single = await generateArrayOnce({
          prompt: buildPrompt([item]),
          arrayField,
          expectedLength: 1,
        });
        arr.push(single ? single[0] : fallbackFor(item));
      }
    }

    results.push(...arr);
  }

  return results;
}

// カード化: 下線を引いた箇所を、そのまま書き写さず20文字以内に要約する。
export async function summarizeUnits(units) {
  return generateArrayRobust({
    items: units,
    arrayField: "headlines",
    buildPrompt: (chunkUnits) => {
      const list = chunkUnits.map((u, i) => `${i + 1}. ${u}`).join("\n");
      return (
        `以下は議事録から抜き出した重要箇所です。KJ法の「カード化」に従い、` +
        `それぞれの内容を最も簡潔に表すよう、おおよそ20文字以内に要約してください。\n\n` +
        `制約:\n` +
        `- 入力と同じ順序・同じ件数(${chunkUnits.length}件)で、1項目につき1つずつ出力すること\n` +
        `- そのまま書き写さず、要点だけを短く言い切ること(体言止め可)\n` +
        `- 元の意味を変えないこと。憶測で情報を足さないこと\n\n${list}`
      );
    },
    fallbackFor: (unit) => (unit.length > 20 ? `${unit.slice(0, 20)}…` : unit),
  });
}

// 概念化: グループに「見出し」を付ける。付箋に書ける程度の短い言葉にする。
export async function labelGroups(groupsMemberTexts) {
  return generateArrayRobust({
    items: groupsMemberTexts,
    arrayField: "labels",
    buildPrompt: (chunkGroups) => {
      const list = chunkGroups
        .map((members, i) => `【グループ${i + 1}】\n${members.map((m) => `- ${m}`).join("\n")}`)
        .join("\n\n");
      return (
        `以下はKJ法でグルーピングされたカード群です。各グループに「見出し」を1つずつ付けてください。\n\n` +
        `制約:\n` +
        `- 見出しはグループ全体を貫く趣旨を表す短い名詞句にすること(3〜12文字程度。例:「介護」「足腰の衰え」「メル友」)\n` +
        `- 個々のカードの言い換えにせず、一段抽象化すること\n` +
        `- 各グループに1つずつ、同じ順序・同じ件数(${chunkGroups.length}件)で出力すること\n\n${list}`
      );
    },
    fallbackFor: (members) => members[0],
  });
}

// 新たなストーリーのアウトラインを把握する(例: 1. 高齢者の孤独 / 1-1. 老々介護)。
export async function writeOutline(hierarchyOutline, relationsOutline) {
  const prompt =
    `以下はKJ法で整理した図解の内容です。ここから浮かび上がる「新たなストーリーのアウトライン」を作成してください。\n\n` +
    `制約:\n` +
    `- 元データの用語をなぞるのではなく、分析から見えてくる筋書きとして再構成すること\n` +
    `- 大項目は3〜5個、それぞれに小項目を2〜4個。各項目は20文字以内の簡潔な名詞句にすること\n` +
    `- グループ間の前後関係・因果関係が筋の通った順序になるよう並べること\n` +
    `- まだ実施されていない事柄を、完了した事実のように表現しないこと\n\n` +
    `【グループの階層構造】\n${hierarchyOutline}\n\n【グループ間の関係性】\n${relationsOutline}`;

  const response = await generateContentWithRetry({
    model: MODEL,
    contents: prompt,
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          outline: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                title: { type: Type.STRING },
                items: { type: Type.ARRAY, items: { type: Type.STRING } },
              },
              required: ["title", "items"],
            },
          },
        },
        required: ["outline"],
      },
    },
  });

  try {
    const parsed = JSON.parse(response.text);
    return Array.isArray(parsed.outline) ? parsed.outline : [];
  } catch {
    return [];
  }
}

// 再文章化: アウトラインをもとに、客観的で論理的なストーリーラインに再構成する。
export async function writeNarrative(outline, relationsOutline) {
  const outlineText = outline
    .map((section, i) =>
      [`${i + 1}. ${section.title}`, ...section.items.map((item, j) => `  ${i + 1}-${j + 1}. ${item}`)].join("\n"),
    )
    .join("\n");

  const prompt =
    `以下はKJ法で作成したストーリーのアウトラインと、グループ間の関係性です。` +
    `このアウトラインの順序に沿って、全体を客観的で論理的な文章(ストーリーライン)に再構成してください。\n\n` +
    `制約:\n` +
    `- 箇条書きではなく、つながりのある文章として書くこと\n` +
    `- 主観的な感想や、データから読み取れない解釈を加えないこと\n` +
    `- 元データでの確度(決定済み/提案段階/予定/依頼中)を変えないこと。` +
    `まだ実施されていないことを、完了した事実のように書かないこと\n` +
    `- 前後関係・因果関係が読み手に伝わるように接続すること\n\n` +
    `【アウトライン】\n${outlineText}\n\n【グループ間の関係性】\n${relationsOutline}`;

  const response = await generateContentWithRetry({ model: MODEL, contents: prompt });
  return response.text.trim();
}
