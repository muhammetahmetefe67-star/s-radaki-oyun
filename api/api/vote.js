
const { createHash } = require("crypto");

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

const RANK_KEY = "siroy:rank";
const META_KEY = "siroy:games";

async function redis(command) {
  const response = await fetch(REDIS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${REDIS_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(command)
  });

  const data = await response.json();

  if (!response.ok || data.error) {
    throw new Error(data.error || "Redis error");
  }

  return data.result;
}

async function pipeline(commands) {
  const response = await fetch(REDIS_URL + "/pipeline", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${REDIS_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(commands)
  });

  const data = await response.json();

  if (!response.ok) throw new Error("Redis pipeline error");

  return data.map(item => {
    if (item.error) throw new Error(item.error);
    return item.result;
  });
}

function getIP(req) {
  const forwarded = req.headers["x-forwarded-for"];
  const ip = forwarded
    ? String(forwarded).split(",")[0].trim()
    : req.headers["x-real-ip"];

  return ip || "";
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (!REDIS_URL || !REDIS_TOKEN) {
    return res.status(500).json({
      error: "Veritabanı ayarları eksik."
    });
  }

  try {
    // OY SIRALAMASINI GETİR
    if (req.method === "GET") {
      const result = await redis([
        "ZREVRANGE", RANK_KEY, "0", "9", "WITHSCORES"
      ]);

      if (!result || !result.length) {
        return res.status(200).json([]);
      }

      const slugs = [];

      for (let i = 0; i < result.length; i += 2) {
        slugs.push(result[i]);
      }

      const metadata = await pipeline(
        slugs.map(slug => ["HGET", META_KEY, slug])
      );

      const games = slugs.map((slug, i) => {
        let info = {};

        try {
          info = JSON.parse(metadata[i] || "{}");
        } catch (_) {}

        return {
          slug,
          name: info.name || slug,
          image: info.image || "",
          votes: Number(result[i * 2 + 1]) || 0
        };
      });

      return res.status(200).json(games);
    }

    // SADECE POST KABUL ET
    if (req.method !== "POST") {
      res.setHeader("Allow", "GET, POST");
      return res.status(405).json({ error: "Method not allowed" });
    }

    const body = typeof req.body === "string"
      ? JSON.parse(req.body)
      : req.body || {};

    const slug = String(body.slug || "");
    const name = String(body.name || "").trim();

    if (!/^[a-z0-9-]{1,100}$/i.test(slug) ||
        !name || name.length > 120) {
      return res.status(400).json({
        error: "Geçersiz oyun bilgisi."
      });
    }

    const ip = getIP(req);

    if (!ip) {
      return res.status(400).json({
        error: "Ziyaretçi bilgisi alınamadı."
      });
    }

    const imageURL = String(body.image || "");
    let image = "";

    try {
      const parsed = new URL(imageURL);
      if (
        parsed.protocol === "https:" &&
        parsed.hostname === "media.rawg.io"
      ) {
        image = parsed.href;
      }
    } catch (_) {}

    // IP adresini gizli hash olarak sakla
    const ipHash = createHash("sha256")
      .update(ip)
      .digest("hex");

    const lockKey = `siroy:vote:${ipHash}:${slug}`;

    const metadata = JSON.stringify({
      name,
      image
    });

    // TEK ATOMİK İŞLEM: 24 SAATTE AYNI OYUNA TEKRAR OY YOK
    const script = `
      local locked = redis.call(
        'SET', KEYS[1], '1', 'NX', 'EX', 86400
      )

      if not locked then
        return 0
      end

      redis.call('ZINCRBY', KEYS[2], 1, ARGV[1])
      redis.call('HSET', KEYS[3], ARGV[1], ARGV[2])

      return 1
    `;

    const result = await redis([
      "EVAL",
      script,
      "3",
      lockKey,
      RANK_KEY,
      META_KEY,
      slug,
      metadata
    ]);

    if (Number(result) === 0) {
      return res.status(200).json({
        ok: false,
        already: true
      });
    }

    return res.status(200).json({
      ok: true
    });

  } catch (error) {
    console.error("Vote API error:", error);

    return res.status(500).json({
      error: "Oylama işlemi başarısız."
    });
  }
};
