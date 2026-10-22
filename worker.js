// «Приёмник» публикаций BlockPhone для Cloudflare Workers (бесплатно).
// Телефон присылает архив приложения → приёмник кладёт его в ветку репозитория и открывает Pull Request (заявку).
// Владелец каталога проверяет и нажимает Merge — GitHub Actions сами пересобирают catalog.json.
//
// Настройка (Cloudflare → Workers & Pages → ваш worker → Settings → Variables and Secrets):
//   GITHUB_TOKEN — секрет (Secret): токен GitHub с доступом только к этому репозиторию (Contents и Pull requests: Read and write)
//   REPO_OWNER   — ник на GitHub (Jdhihfgiuahfgy)
//   REPO_NAME    — имя репозитория (blockphone-apps)
//
// Отзывы: POST /review (JSON: app, stars 1..5, text, player, serverId, version). Кто пишет, проверяет Mojang
// (sessionserver hasJoined — как при входе на сервер), поэтому отзыв может оставить только лицензионный аккаунт; один
// отзыв на приложение от игрока (новый заменяет старый). Отзывы — reviews/<id>.json в main (без заявок); сводку
// reviews/summary.json пересобирает GitHub Actions (build_catalog.py). Удалить отзыв — отредактировать файл на GitHub.
//
// Авторство: owners.json в репозитории хранит для каждого приложения отпечаток (SHA-256) секретного ключа автора.
// Обновить приложение может только тот, у кого этот ключ (он есть только на устройстве автора). Приложения, которые лежат
// в apps-src, но не записаны в owners.json (стартовые или загруженные владельцем вручную), с телефона не обновить.

const MAX_ZIP = 10 * 1024 * 1024;

export default {
  async fetch(request, env) {
    if (request.method === "GET") {
      return new Response("BlockPhone app store receiver: OK");
    }
    if (request.method !== "POST") {
      return json({ error: "method not allowed" }, 405);
    }
    if (new URL(request.url).pathname === "/review") {
      return review(request, env);
    }
    const id = (request.headers.get("X-App-Id") || "").toLowerCase();
    const version = (request.headers.get("X-App-Version") || "?").slice(0, 32).replace(/[^\w.\-]/g, "");
    const player = request.headers.get("X-Player") || "";
    const authorKey = request.headers.get("X-Author-Key") || "";
    if (!/^[0-9a-f]{64}$/.test(authorKey)) {
      return json({ error: "no author key (update BlockPhone)" }, 400);
    }
    if (!/^[a-z0-9_-]{1,32}$/.test(id)) {
      return json({ error: "bad app id" }, 400);
    }
    if (!/^[A-Za-z0-9_]{1,16}$/.test(player)) {
      return json({ error: "bad player name" }, 400);
    }
    const body = new Uint8Array(await request.arrayBuffer());
    if (body.length < 22 || body.length > MAX_ZIP) {
      return json({ error: "archive must be 1 byte .. 10 MB" }, 400);
    }
    if (body[0] !== 0x50 || body[1] !== 0x4b) {
      return json({ error: "not a zip archive" }, 400);
    }

    const gh = github(env);

    // Кто автор: owners.json (id → sha256 ключа) и есть ли приложение в каталоге.
    const keyHash = await sha256hex(authorKey);
    let owners = {};
    let ownersSha;
    const ownersRes = await gh("/contents/owners.json?ref=main");
    if (ownersRes.ok) {
      const file = await ownersRes.json();
      ownersSha = file.sha;
      owners = JSON.parse(decodeBase64(file.content));
    }
    if (owners[id]) {
      if (owners[id] !== keyHash) {
        return json({ error: "this app belongs to another author" }, 403);
      }
    } else {
      const exists = await gh(`/contents/apps-src/${id}.zip?ref=main`);
      if (exists.ok) {
        return json({ error: "this app belongs to the catalog owner" }, 403);
      }
    }

    const main = await gh("/git/ref/heads/main");
    if (!main.ok) {
      return json({ error: "github: cannot read main (" + main.status + ")" }, 502);
    }
    const base = (await main.json()).object.sha;
    const branch = `submit/${id}-${Date.now()}`;
    let r = await gh("/git/refs", { method: "POST", body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: base }) });
    if (!r.ok) {
      return json({ error: "github: cannot create branch (" + r.status + ")" }, 502);
    }
    const path = `apps-src/${id}.zip`;
    const existing = await gh(`/contents/${path}?ref=${encodeURIComponent(branch)}`);
    const sha = existing.ok ? (await existing.json()).sha : undefined;
    r = await gh(`/contents/${path}`, {
      method: "PUT",
      body: JSON.stringify({ message: `${id} ${version} от ${player}`, content: base64(body), branch, sha }),
    });
    if (!r.ok) {
      return json({ error: "github: cannot upload (" + r.status + ")" }, 502);
    }
    if (!owners[id]) {
      // Новое приложение: записать автора (вступит в силу, когда заявку одобрят).
      owners[id] = keyHash;
      r = await gh("/contents/owners.json", {
        method: "PUT",
        body: JSON.stringify({ message: `Автор ${id}: ${player}`, content: btoa(unescape(encodeURIComponent(JSON.stringify(owners, null, 2)))),
          branch, sha: ownersSha }),
      });
      if (!r.ok) {
        return json({ error: "github: cannot save author (" + r.status + ")" }, 502);
      }
    }
    r = await gh("/pulls", {
      method: "POST",
      body: JSON.stringify({
        title: `Приложение ${id} ${version} от ${player}`,
        head: branch,
        base: "main",
        body:
          `Отправлено из телефона игроком **${player}**.\n\n` +
          `Проверка «Check submission» ниже покажет, всё ли в порядке с архивом. ` +
          `Посмотрите файлы и нажмите **Merge pull request** — приложение появится в Магазине. ` +
          `Не подходит — **Close pull request**.`,
      }),
    });
    if (!r.ok) {
      return json({ error: "github: cannot open pull request (" + r.status + ")" }, 502);
    }
    const pr = await r.json();
    return json({ ok: true, pr: pr.number });
  },
};

function github(env) {
  return (path, init = {}) =>
    fetch(`https://api.github.com/repos/${env.REPO_OWNER}/${env.REPO_NAME}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "blockphone-store",
        "Content-Type": "application/json",
      },
    });
}

const MAX_REVIEW_TEXT = 500;
const MAX_REVIEWS = 1000;

async function review(request, env) {
  const raw = await request.text();
  if (raw.length > 8192) {
    return json({ error: "too big" }, 400);
  }
  let body;
  try {
    body = JSON.parse(raw);
  } catch (e) {
    return json({ error: "bad json" }, 400);
  }
  const id = String(body.app || "").toLowerCase();
  const stars = Number(body.stars);
  const player = String(body.player || "");
  const serverId = String(body.serverId || "");
  const version = String(body.version || "").slice(0, 32).replace(/[^\w.\-]/g, "");
  // Текст: без управляющих символов, переносы — не больше двух подряд.
  const text = String(body.text || "")
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, MAX_REVIEW_TEXT);
  if (!/^[a-z0-9_-]{1,32}$/.test(id)) {
    return json({ error: "bad app id" }, 400);
  }
  if (!Number.isInteger(stars) || stars < 1 || stars > 5) {
    return json({ error: "stars must be 1..5" }, 400);
  }
  if (!/^[A-Za-z0-9_]{1,16}$/.test(player) || !/^[0-9a-f]{8,40}$/.test(serverId)) {
    return json({ error: "bad player" }, 400);
  }

  // Это правда этот игрок? Игра только что «вошла» на сервер serverId — Mojang подтверждает.
  const mojang = await fetch(
    `https://sessionserver.mojang.com/session/minecraft/hasJoined?username=${encodeURIComponent(player)}&serverId=${serverId}`,
  );
  if (mojang.status !== 200) {
    return json({ error: "Mojang did not confirm the account (licensed Minecraft only)" }, 403);
  }
  const profile = await mojang.json();
  const uuid = String(profile.id || "");
  const name = String(profile.name || player);
  if (!/^[0-9a-f]{32}$/.test(uuid)) {
    return json({ error: "Mojang did not confirm the account" }, 403);
  }

  const gh = github(env);
  // Приложение должно быть в каталоге.
  const catalog = await gh("/contents/catalog.json?ref=main");
  if (!catalog.ok) {
    return json({ error: "github: cannot read catalog (" + catalog.status + ")" }, 502);
  }
  const apps = JSON.parse(decodeBase64((await catalog.json()).content)).apps || [];
  if (!apps.some((a) => a.id === id)) {
    return json({ error: "no such app in the catalog" }, 404);
  }

  // Записать в reviews/<id>.json (если файл одновременно изменили — повторить).
  const path = `reviews/${id}.json`;
  for (let attempt = 0; attempt < 4; attempt++) {
    const existing = await gh(`/contents/${path}?ref=main`);
    let reviews = [];
    let sha;
    if (existing.ok) {
      const file = await existing.json();
      sha = file.sha;
      reviews = JSON.parse(decodeBase64(file.content)).reviews || [];
    }
    reviews = reviews.filter((r) => r.uuid !== uuid);
    reviews.unshift({ uuid, player: name, stars, text, version, time: Date.now() });
    reviews = reviews.slice(0, MAX_REVIEWS);
    const put = await gh(`/contents/${path}`, {
      method: "PUT",
      body: JSON.stringify({
        message: `Отзыв ${id}: ${stars}★ от ${name}`,
        content: btoa(unescape(encodeURIComponent(JSON.stringify({ reviews }, null, 1)))),
        branch: "main",
        sha,
      }),
    });
    if (put.ok) {
      return json({ ok: true });
    }
    if (put.status !== 409 && put.status !== 422) {
      return json({ error: "github: cannot save review (" + put.status + ")" }, 502);
    }
  }
  return json({ error: "busy, try again" }, 503);
}

async function sha256hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function decodeBase64(text) {
  const bin = atob(text.replace(/\n/g, ""));
  return decodeURIComponent(escape(bin));
}

function base64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}
