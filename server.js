const express = require("express");
const path = require("path");

const app = express();
const PORT = 3000;

app.disable("x-powered-by");

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

const CACHE_DURATION = 5 * 60 * 1000;
const MAX_CACHE_ENTRIES = 100;

const cache = new Map();
const inFlight = new Map();

let searchBlockedUntil = 0;
let thumbnailsBlockedUntil = 0;
let nextSearchAllowedAt = 0;
let activeSearches = 0;

function parseRetryAfter(value) {
  if (!value) return 60;

  const seconds = Number(value);

  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.max(1, Math.ceil(seconds));
  }

  const date = Date.parse(value);

  if (Number.isFinite(date)) {
    return Math.max(1, Math.ceil((date - Date.now()) / 1000));
  }

  return 60;
}

function rateLimitError(seconds, message) {
  const error = new Error(message);
  error.status = 429;
  error.retryAfter = Math.max(1, Math.ceil(seconds));
  return error;
}

async function robloxJSON(url) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(10000)
  });

  if (!response.ok) {
    const error = new Error("Roblox-Anfrage fehlgeschlagen.");
    error.status = response.status;

    if (response.status === 429) {
      error.retryAfter = parseRetryAfter(
        response.headers.get("retry-after")
      );
    }

    throw error;
  }

  return response.json();
}

function validHeadshotURL(value) {
  if (typeof value !== "string") return null;

  try {
    const url = new URL(value);

    if (
      url.protocol === "https:" &&
      (
        url.hostname === "rbxcdn.com" ||
        url.hostname.endsWith(".rbxcdn.com")
      )
    ) {
      return url.href;
    }
  } catch {}

  return null;
}

async function searchRoblox(keyword) {
  const now = Date.now();

  if (now < searchBlockedUntil) {
    const seconds = Math.ceil((searchBlockedUntil - now) / 1000);

    throw rateLimitError(
      seconds,
      `Roblox-Suchpause: Bitte noch etwa ${seconds} Sekunden warten.`
    );
  }

  if (activeSearches > 0 || now < nextSearchAllowedAt) {
    throw rateLimitError(
      3,
      "Bitte kurz warten, bevor du eine neue Suche startest."
    );
  }

  activeSearches++;
  nextSearchAllowedAt = now + 3000;

  try {
    const searchURL = new URL(
      "https://users.roblox.com/v1/users/search"
    );

    searchURL.searchParams.set("keyword", keyword);
    searchURL.searchParams.set("limit", "10");

    let search;

    try {
      search = await robloxJSON(searchURL);
    } catch (error) {
      if (error.status === 429) {
        const seconds = error.retryAfter || 60;
        searchBlockedUntil = Date.now() + seconds * 1000;

        throw rateLimitError(
          seconds,
          `Roblox begrenzt die Suche. Bitte etwa ${seconds} Sekunden warten.`
        );
      }

      throw error;
    }

    const users = Array.isArray(search.data)
      ? search.data.filter(user => (
          Number.isSafeInteger(user.id) &&
          user.id > 0 &&
          typeof user.name === "string"
        )).slice(0, 10)
      : [];

    if (!users.length) return { users: [] };

    const images = new Map();

    if (Date.now() >= thumbnailsBlockedUntil) {
      const thumbnailURL = new URL(
        "https://thumbnails.roblox.com/v1/users/avatar-headshot"
      );

      thumbnailURL.searchParams.set(
        "userIds",
        users.map(user => user.id).join(",")
      );
      thumbnailURL.searchParams.set("size", "150x150");
      thumbnailURL.searchParams.set("format", "Png");
      thumbnailURL.searchParams.set("isCircular", "false");

      try {
        const result = await robloxJSON(thumbnailURL);
        const thumbnails = Array.isArray(result.data) ? result.data : [];

        for (const item of thumbnails) {
          if (item.state !== "Completed") continue;

          const imageURL = validHeadshotURL(item.imageUrl);
          if (imageURL) images.set(item.targetId, imageURL);
        }
      } catch (error) {
        if (error.status === 429) {
          thumbnailsBlockedUntil =
            Date.now() + (error.retryAfter || 60) * 1000;
        }
      }
    }

    return {
      users: users.map(user => ({
        id: user.id,
        username: user.name,
        displayName:
          typeof user.displayName === "string"
            ? user.displayName
            : user.name,
        headshot: images.get(user.id) || null
      }))
    };
  } finally {
    activeSearches--;
  }
}

app.get("/api/search-users", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");

  if (typeof req.query.keyword !== "string") {
    return res.status(400).json({
      error: "Bitte einen Benutzernamen eingeben."
    });
  }

  const keyword = req.query.keyword.trim();

  if (keyword.length < 3 || keyword.length > 50) {
    return res.status(400).json({
      error: "Bitte zwischen 3 und 50 Zeichen eingeben."
    });
  }

  const key = keyword.toLowerCase();
  const cached = cache.get(key);

  if (cached && cached.expires > Date.now()) {
    return res.json(cached.result);
  }

  try {
    let promise = inFlight.get(key);

    if (!promise) {
      promise = searchRoblox(keyword)
        .then(result => {
          for (const [cacheKey, entry] of cache) {
            if (entry.expires <= Date.now()) cache.delete(cacheKey);
          }

          if (cache.size >= MAX_CACHE_ENTRIES) {
            cache.delete(cache.keys().next().value);
          }

          cache.set(key, {
            result,
            expires: Date.now() + CACHE_DURATION
          });

          return result;
        })
        .finally(() => {
          inFlight.delete(key);
        });

      inFlight.set(key, promise);
    }

    return res.json(await promise);
  } catch (error) {
    if (error.status === 429) {
      const seconds = error.retryAfter || 60;

      res.setHeader("Retry-After", String(seconds));

      return res.status(429).json({
        error: error.message,
        retryAfter: seconds
      });
    }

    if (error.status === 400) {
      return res.status(400).json({
        error: "Roblox hat diese Suche abgelehnt. Versuche einen anderen Namen."
      });
    }

    console.error("Roblox-Suchfehler:", error.message);

    return res.status(502).json({
      error: "Roblox ist gerade nicht erreichbar. Bitte später erneut versuchen."
    });
  }
});

// Es gibt absichtlich keinen Endpunkt zum Übertragen von Robux.

const server = app.listen(PORT, "127.0.0.1", () => {
  console.log(`Website öffnen: http://localhost:${PORT}`);
});

server.on("error", error => {
  if (error.code === "EADDRINUSE") {
    console.error(
      "Port 3000 ist belegt. Beende den alten Server mit Strg+C."
    );
  } else {
    console.error("Serverfehler:", error.message);
  }

  process.exitCode = 1;
});