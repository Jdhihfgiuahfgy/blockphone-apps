// «Приёмник» публикаций BlockPhone для Cloudflare Workers (бесплатно).
// Телефон присылает архив приложения → приёмник кладёт его в ветку репозитория и открывает Pull Request (заявку).
// Владелец каталога проверяет и нажимает Merge — GitHub Actions сами пересобирают catalog.json.
//
// Настройка (Cloudflare → Workers & Pages → ваш worker → Settings → Variables and Secrets):
//   GITHUB_TOKEN — секрет (Secret): токен GitHub с доступом только к этому репозиторию (Contents и Pull requests: Read and write)
//   REPO_OWNER   — ник на GitHub (Jdhihfgiuahfgy)
//   REPO_NAME    — имя репозитория (blockphone-apps)

const MAX_ZIP = 10 * 1024 * 1024;

export default {
  async fetch(request, env) {
    if (request.method === "GET") {
      return new Response("BlockPhone app store receiver: OK");
    }
    if (request.method !== "POST") {
      return json({ error: "method not allowed" }, 405);
    }
    const id = (request.headers.get("X-App-Id") || "").toLowerCase();
    const version = (request.headers.get("X-App-Version") || "?").slice(0, 32).replace(/[^\w.\-]/g, "");
    const player = request.headers.get("X-Player") || "";
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

    const gh = (path, init = {}) =>
      fetch(`https://api.github.com/repos/${env.REPO_OWNER}/${env.REPO_NAME}${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${env.GITHUB_TOKEN}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "blockphone-store",
          "Content-Type": "application/json",
        },
      });

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
