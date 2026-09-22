const API_URL = "https://api.typesafe.ai/v1/systemone";
const MODEL = "jev-latest";
const MAX_RETRIES = 4;

async function requestOnce(state, questions) {
  const apiKey = process.env.TYPESAFE_API_KEY;
  if (!apiKey) {
    throw new Error("TYPESAFE_API_KEY が設定されていません(.env を確認してください)。");
  }

  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ state, model: MODEL, questions }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const err = new Error(`jev API エラー (${res.status}): ${body || res.statusText}`);
    err.status = res.status;
    throw err;
  }

  return res.json();
}

// 429/529 はドキュメント通り指数バックオフでリトライする。
export async function callSystemOne(state, questions) {
  let attempt = 0;
  for (;;) {
    try {
      return await requestOnce(state, questions);
    } catch (err) {
      const retryable = err.status === 429 || err.status === 529;
      if (!retryable || attempt >= MAX_RETRIES) throw err;
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
      attempt += 1;
    }
  }
}

export async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;

  async function worker() {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
