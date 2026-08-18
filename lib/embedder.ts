export async function embed(text: string): Promise<number[]> {
  const token = process.env.HF_API_TOKEN;
  if (!token) throw new Error("HF_API_TOKEN is not configured");

  const resp = await fetch(
    "https://api-inference.huggingface.co/models/franzclarin/ReverseDictionary",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ inputs: text, options: { wait_for_model: true } }),
    }
  );

  if (!resp.ok) {
    const msg = await resp.text().catch(() => resp.statusText);
    throw new Error(`HF API ${resp.status}: ${msg.slice(0, 200)}`);
  }

  const raw = await resp.json();

  // Normalise output shape to [seq, dim] regardless of whether the API returns
  // [dim], [seq, dim], or [1, seq, dim]
  let seqEmbeddings: number[][];
  if (!Array.isArray(raw[0])) {
    seqEmbeddings = [raw as number[]];
  } else if (!Array.isArray((raw as unknown[][])[0][0])) {
    seqEmbeddings = raw as number[][];
  } else {
    seqEmbeddings = (raw as number[][][])[0];
  }

  // Mean pool — mirrors @xenova/transformers { pooling: "mean" }
  const dim = seqEmbeddings[0].length;
  const pooled = Array.from({ length: dim }, (_, i) =>
    seqEmbeddings.reduce((s, t) => s + t[i], 0) / seqEmbeddings.length
  );

  // L2 normalise — mirrors { normalize: true }
  const norm = Math.sqrt(pooled.reduce((s, v) => s + v * v, 0));
  return norm > 0 ? pooled.map(v => v / norm) : pooled;
}
