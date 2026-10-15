// Liefert das Format, das public/index.html erwartet:
// { users: [{ id, username, displayName, headshot }] }

function validHeadshotURL(value) {
  if (typeof value !== "string") return null;

  try {
    const url = new URL(value);

    if (
      url.protocol === "https:" &&
      (url.hostname === "rbxcdn.com" || url.hostname.endsWith(".rbxcdn.com"))
    ) {
      return url.href;
    }
  } catch {}

  return null;
}

function json(body, status = 200, headers = {}) {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store", ...headers }
  });
}

export default async (request) => {
  const url = new URL(request.url);
  const keyword = (url.searchParams.get("keyword") || "").trim();

  if (keyword.length < 3 || keyword.length > 50) {
    return json({ error: "Bitte zwischen 3 und 50 Zeichen eingeben." }, 400);
  }

  try {
    const searchURL = new URL("https://users.roblox.com/v1/users/search");
    searchURL.searchParams.set("keyword", keyword);
    searchURL.searchParams.set("limit", "10");

    const searchResponse = await fetch(searchURL, {
      signal: AbortSignal.timeout(10000)
    });

    if (searchResponse.status === 429) {
      const seconds = Number(searchResponse.headers.get("retry-after")) || 60;
      return json(
        {
          error: `Roblox begrenzt die Suche. Bitte etwa ${seconds} Sekunden warten.`,
          retryAfter: seconds
        },
        429,
        { "Retry-After": String(seconds) }
      );
    }

    if (searchResponse.status === 400) {
      return json(
        { error: "Roblox hat diese Suche abgelehnt. Versuche einen anderen Namen." },
        400
      );
    }

    if (!searchResponse.ok) {
      return json({ error: "Die Roblox-Suche ist gerade nicht verfügbar." }, 502);
    }

    const searchData = await searchResponse.json();
    const users = Array.isArray(searchData.data)
      ? searchData.data
          .filter(user => Number.isSafeInteger(user.id) && typeof user.name === "string")
          .slice(0, 10)
      : [];

    if (!users.length) return json({ users: [] });

    // Alle Avatare mit einer einzigen Anfrage laden.
    const images = new Map();

    try {
      const thumbURL = new URL("https://thumbnails.roblox.com/v1/users/avatar-headshot");
      thumbURL.searchParams.set("userIds", users.map(user => user.id).join(","));
      thumbURL.searchParams.set("size", "150x150");
      thumbURL.searchParams.set("format", "Png");
      thumbURL.searchParams.set("isCircular", "false");

      const thumbResponse = await fetch(thumbURL, {
        signal: AbortSignal.timeout(10000)
      });

      if (thumbResponse.ok) {
        const thumbData = await thumbResponse.json();

        for (const item of thumbData.data || []) {
          const imageURL = item.state === "Completed" && validHeadshotURL(item.imageUrl);
          if (imageURL) images.set(item.targetId, imageURL);
        }
      }
    } catch {}

    return json({
      users: users.map(user => ({
        id: user.id,
        username: user.name,
        displayName: typeof user.displayName === "string" ? user.displayName : user.name,
        headshot: images.get(user.id) || null
      }))
    });
  } catch {
    return json({ error: "Verbindung zu Roblox fehlgeschlagen." }, 502);
  }
};

export const config = {
  path: "/api/search-users"
};
