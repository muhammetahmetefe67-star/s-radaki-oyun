// Oylama fonksiyonu. Oyları Upstash Redis veritabanında saklar.
// Vercel'de Upstash Redis'i projeye bağlayınca gerekli değişkenler otomatik eklenir.
const URL_ = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

async function redis(cmds) {
  const r = await fetch(URL_ + "/pipeline", {
    method: "POST",
    headers: { Authorization: "Bearer " + TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify(cmds),
  });
  return r.json();
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (!URL_ || !TOKEN) {
    res.status(500).json({ error: "Veritabanı bağlı değil" });
    return;
  }
  try {
    if (req.method === "GET") {
      const top = (await redis([["ZREVRANGE", "votes", 0, 49, "WITHSCORES"]]))[0].result || [];
      const slugs = [];
      const votes = [];
      for (let i = 0; i < top.length; i += 2) {
        slugs.push(top[i]);
        votes.push(Number(top[i + 1]));
      }
      if (!slugs.length) {
        res.status(200).json([]);
        return;
      }
      const metas = (await redis([["HMGET", "meta", ...slugs]]))[0].result || [];
      const out = slugs.map((slug, i) => {
        let m = {};
        try { m = JSON.parse(metas[i] || "{}"); } catch (e) {}
        return { slug, name: m.name || slug, image: m.image || "", votes: votes[i] };
      });
      res.status(200).json(out);
      return;
    }

    if (req.method === "POST") {
      const b = req.body || {};
      const slug = String(b.slug || "");
      const name = String(b.name || "").slice(0, 120);
      const image = String(b.image || "");
      if (!/^[a-z0-9-]{1,100}$/.test(slug) || !name) {
        res.status(400).json({ error: "Geçersiz oyun" });
        return;
      }
      const safeImage = image.indexOf("https://media.rawg.io/") === 0 ? image : "";
      const ip = String(req.headers["x-forwarded-for"] || "anon").split(",")[0].trim();
      // Aynı kişi aynı oyuna 24 saatte bir kez oy verebilir.
      const lock = (await redis([["SET", "lock:" + ip + ":" + slug, "1", "NX", "EX", 86400]]))[0].result;
      if (lock !== "OK") {
        res.status(200).json({ ok: false, already: true });
        return;
      }
      await redis([
        ["ZINCRBY", "votes", 1, slug],
        ["HSET", "meta", slug, JSON.stringify({ name, image: safeImage })],
      ]);
      res.status(200).json({ ok: true });
      return;
    }
    res.status(405).json({ error: "Yöntem desteklenmiyor" });
  } catch (e) {
    res.status(502).json({ error: "Veritabanına ulaşılamadı" });
  }
};
