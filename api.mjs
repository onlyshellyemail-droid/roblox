
export default async (request) => {
  const url = new URL(request.url);
  const keyword = (url.searchParams.get("keyword") || "").trim();

  if (!keyword) {
    return Response.json(
      { error: "Bitte einen Suchbegriff eingeben." },
      { status: 400 }
    );
  }

  try {
    const searchResponse = await fetch(
      "https://users.roblox.com/v1/users/search?keyword=" +
      encodeURIComponent(keyword) +
      "&limit=10"
    );

    if (!searchResponse.ok) {
      return Response.json(
        { error: "Die Roblox-Suche ist gerade nicht verfügbar." },
        { status: 502 }
      );
    }

    const searchData = await searchResponse.json();
    const users = searchData.data || [];

    const results = await Promise.all(
      users.map(async (user) => {
        try {
          const thumbResponse = await fetch(
            "https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=" +
            user.id +
            "&size=150x150&format=Png&isCircular=false"
          );

          const thumbData = thumbResponse.ok
            ? await thumbResponse.json()
            : { data: [] };

          return {
            id: user.id,
            name: user.name,
            displayName: user.displayName,
            avatar: thumbData.data?.[0]?.imageUrl || null
          };
        } catch {
          return {
            id: user.id,
            name: user.name,
            displayName: user.displayName,
            avatar: null
          };
        }
      })
    );

    return Response.json({ data: results });
  } catch {
    return Response.json(
      { error: "Verbindung zu Roblox fehlgeschlagen." },
      { status: 502 }
    );
  }
};

export const config = {
  path: "/api/search-users"
};
