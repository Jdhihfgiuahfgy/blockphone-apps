// «Приёмник» публикаций BlockPhone для Cloudflare Workers (бесплатно).
// Телефон присылает архив приложения → приёмник кладёт его в ветку репозитория и открывает Pull Request (заявку).
// Владелец каталога проверяет и нажимает Merge — GitHub Actions сами пересобирают catalog.json.
//
// Настройка (Cloudflare → Workers & Pages → ваш worker → Settings → Variables and Secrets):
//   GITHUB_TOKEN — секрет (Secret): токен GitHub с доступом только к этому репозиторию (Contents и Pull requests: Read and write)
//   REPO_OWNER   — ник на GitHub (Jdhihfgiuahfgy)
//   REPO_NAME    — имя репозитория (blockphone-apps)
//
// Отзывы: POST /review (JSON: app, stars 1..5, text, player, version). Один отзыв на приложение с одного ника и с одного
// IP: новый от того же ника заменяет старый; с IP, где уже есть отзыв другого ника, — отказ. IP в файл не пишется —
// только его отпечаток (HMAC с GITHUB_TOKEN, по нему IP не узнать); сравнивается подсеть: IPv4 /24, IPv6 /64. Проверить лицензию у Mojang отсюда нельзя: Mojang
// не пускает запросы с серверов Cloudflare (HTTP 403). Отзывы — reviews/<id>.json в main (без заявок); сводку
// reviews/summary.json пересобирает GitHub Actions (build_catalog.py). Удалить отзыв — отредактировать файл на GitHub.
//
// Авторство: owners.json в репозитории хранит для каждого приложения отпечаток (SHA-256) секретного ключа автора.
// Обновить приложение может только тот, у кого этот ключ (он есть только на устройстве автора). Приложения, которые лежат
// в apps-src, но не записаны в owners.json (стартовые или загруженные владельцем вручную), с телефона не обновить.

const MAX_ZIP = 25 * 1024 * 1024;

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
    if (new URL(request.url).pathname === "/feedback") {
      return feedback(request, env);
    }
    const id = (request.headers.get("X-App-Id") || "").toLowerCase();
    const version = (request.headers.get("X-App-Version") || "?").slice(0, 32).replace(/[^\w.\-]/g, "");
    const player = request.headers.get("X-Player") || "";
    const authorKey = request.headers.get("X-Author-Key") || "";
    const uid = (request.headers.get("X-App-Uid") || "").toLowerCase();
    // Чейнджлог («что нового») — base64 UTF-8, пишет автор при публикации.
    let changelog = "";
    try {
      changelog = decodeBase64(request.headers.get("X-Changelog") || "")
        .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, "")
        .replace(/\n{3,}/g, "\n\n")
        .trim()
        .slice(0, 1500);
    } catch (e) {
      return json({ error: "bad changelog" }, 400);
    }
    if (uid && !/^[a-z0-9]{6,24}$/.test(uid)) {
      return json({ error: "bad app uid" }, 400);
    }
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
      return json({ error: "archive must be 1 byte .. 25 MB" }, 400);
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
    if (changelog) {
      // changelogs/<id>.json — build_catalog.py кладёт текст в catalog.json («В последнем обновлении»).
      const notesPath = `changelogs/${id}.json`;
      const notesOld = await gh(`/contents/${notesPath}?ref=${encodeURIComponent(branch)}`);
      const notesSha = notesOld.ok ? (await notesOld.json()).sha : undefined;
      const notes = JSON.stringify({ version, text: changelog, time: Date.now(), uid }, null, 1);
      r = await gh(`/contents/${notesPath}`, {
        method: "PUT",
        body: JSON.stringify({ message: `Что нового в ${id} ${version}`, content: btoa(unescape(encodeURIComponent(notes))),
          branch, sha: notesSha }),
      });
      if (!r.ok) {
        return json({ error: "github: cannot save changelog (" + r.status + ")" }, 502);
      }
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
          (uid ? `uid: \`${uid}\`\n\n` : "") +
          (changelog ? `### Что нового в версии ${version}\n\n${changelog.split("\n").map((l) => "> " + l).join("\n")}\n\n` : "") +
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

// Жалобы и предложения: POST /feedback (JSON: kind bug|idea|complaint, text до 3000, player, mod, minecraft, lang,
// images — до 4 JPEG в base64). Пишутся одним коммитом в feedback/<дата>/<время>-<ник>-<вид>/ (message.md + 1.jpg …) в
// репозиторий FEEDBACK_REPO (если задан; иначе — REPO_NAME). Не чаще 3 обращений за 10 минут с одной подсети.
const FEEDBACK_KINDS = { bug: "Ошибка", idea: "Предложение", complaint: "Жалоба" };

async function feedback(request, env) {
  const raw = await request.text();
  if (raw.length > 9 * 1024 * 1024) {
    return json({ error: "too big" }, 400);
  }
  let body;
  try {
    body = JSON.parse(raw);
  } catch (e) {
    return json({ error: "bad json" }, 400);
  }
  const kind = String(body.kind || "");
  const player = String(body.player || "");
  const text = String(body.text || "").replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, "").trim().slice(0, 3000);
  const images = Array.isArray(body.images) ? body.images.slice(0, 4).map(String) : [];
  if (!FEEDBACK_KINDS[kind] || !/^[A-Za-z0-9_]{1,16}$/.test(player) || text.length < 10) {
    return json({ error: "bad feedback" }, 400);
  }
  for (const img of images) {
    if (img.length > 2200000 || !/^[A-Za-z0-9+/=]+$/.test(img) || !img.startsWith("/9j/")) {
      return json({ error: "bad image (JPEG up to 1.5 MB)" }, 400);
    }
  }

  // Не чаще 3 обращений за 10 минут с одной подсети (кэш Cloudflare в этом дата-центре).
  const net = (await hmacHex(env.GITHUB_TOKEN || "blockphone", networkOf(request.headers.get("CF-Connecting-IP") || ""))).slice(0, 24);
  const cache = caches.default;
  const key = new Request(`https://blockphone-limit.invalid/feedback/${net}`);
  const hit = await cache.match(key);
  const count = hit ? Number(await hit.text()) || 0 : 0;
  if (count >= 3) {
    return json({ error: "too often" }, 429);
  }
  await cache.put(key, new Response(String(count + 1), { headers: { "Cache-Control": "max-age=600" } }));

  const repo = env.FEEDBACK_REPO || env.REPO_NAME;
  const gh = (path, init = {}) =>
    fetch(`https://api.github.com/repos/${env.REPO_OWNER}/${repo}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "blockphone-store",
        "Content-Type": "application/json",
      },
    });
  const now = new Date();
  const date = now.toISOString().slice(0, 10);
  const time = now.toISOString().slice(11, 19).replace(/:/g, "-");
  const folder = `feedback/${date}/${time}-${player}-${kind}`;
  const meta = (v) => String(v || "?").slice(0, 40).replace(/[^\w .+\-]/g, "");
  let md = `# ${FEEDBACK_KINDS[kind]} от ${player}\n\n`;
  md += `- Время (UTC): ${now.toISOString().replace("T", " ").slice(0, 19)}\n`;
  md += `- BlockPhone ${meta(body.mod)}, Minecraft ${meta(body.minecraft)}, язык ${meta(body.lang)}\n\n`;
  md += text.split("\n").map((l) => "> " + l).join("\n") + "\n";
  images.forEach((_, i) => {
    md += `\n![Скриншот ${i + 1}](${i + 1}.jpg)\n`;
  });

  for (let attempt = 0; attempt < 3; attempt++) {
    const ref = await gh("/git/ref/heads/main");
    if (!ref.ok) {
      return json({ error: "github: cannot read main (" + ref.status + ")" }, 502);
    }
    const head = (await ref.json()).object.sha;
    const commit = await (await gh(`/git/commits/${head}`)).json();
    const tree = [{ path: `${folder}/message.md`, mode: "100644", type: "blob", content: md }];
    for (let i = 0; i < images.length; i++) {
      const blob = await gh("/git/blobs", { method: "POST", body: JSON.stringify({ content: images[i], encoding: "base64" }) });
      if (!blob.ok) {
        return json({ error: "github: cannot upload image (" + blob.status + ")" }, 502);
      }
      tree.push({ path: `${folder}/${i + 1}.jpg`, mode: "100644", type: "blob", sha: (await blob.json()).sha });
    }
    const newTree = await gh("/git/trees", { method: "POST", body: JSON.stringify({ base_tree: commit.tree.sha, tree }) });
    if (!newTree.ok) {
      return json({ error: "github: cannot save (" + newTree.status + ")" }, 502);
    }
    const newCommit = await gh("/git/commits", {
      method: "POST",
      body: JSON.stringify({ message: `${FEEDBACK_KINDS[kind]} от ${player}`, tree: (await newTree.json()).sha, parents: [head] }),
    });
    if (!newCommit.ok) {
      return json({ error: "github: cannot save (" + newCommit.status + ")" }, 502);
    }
    const update = await gh("/git/refs/heads/main", { method: "PATCH", body: JSON.stringify({ sha: (await newCommit.json()).sha }) });
    if (update.ok) {
      return json({ ok: true });
    }
    if (update.status !== 422 && update.status !== 409) {
      return json({ error: "github: cannot save (" + update.status + ")" }, 502);
    }
  }
  return json({ error: "busy, try again" }, 503);
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
  if (!/^[A-Za-z0-9_]{1,16}$/.test(player)) {
    return json({ error: "bad player" }, 400);
  }
  const name = player;
  const nick = player.toLowerCase();
  const ip = networkOf(request.headers.get("CF-Connecting-IP") || "");
  const ipHash = (await hmacHex(env.GITHUB_TOKEN || "blockphone", ip)).slice(0, 24);

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
    // С этого IP уже писал другой ник — не принимать (один отзыв с одного IP).
    if (reviews.some((r) => r.ip === ipHash && String(r.player || "").toLowerCase() !== nick)) {
      return json({ error: "one_per_ip" }, 403);
    }
    reviews = reviews.filter((r) => String(r.player || "").toLowerCase() !== nick);
    reviews.unshift({ uuid: nick, player: name, stars, text, version, time: Date.now(), ip: ipHash });
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

// Подсеть адреса: IPv4 — первые три числа, IPv6 — сеть /64 (адрес устройства в ней меняется).
function networkOf(ip) {
  if (!ip.includes(":")) {
    // У многих провайдеров внешний IPv4 меняется от запроса к запросу внутри одной подсети — сравниваем /24.
    return ip.split(".").slice(0, 3).join(".") + ".0/24";
  }
  let [head, tail] = ip.split("::");
  const h = head ? head.split(":") : [];
  const t = tail !== undefined && tail ? tail.split(":") : [];
  const groups = tail !== undefined ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t] : h;
  return groups.slice(0, 4).map((g) => parseInt(g || "0", 16).toString(16)).join(":") + "::/64";
}

async function hmacHex(key, text) {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(text));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
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
