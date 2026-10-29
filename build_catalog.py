"""Сборка каталога BlockPhone из присланных приложений (запускает GitHub Actions, вручную не нужно).

apps-src/<id>.zip — приложения как их прислали (или положили вы). Скрипт проверяет каждый архив (app.json, id совпадает с
именем файла, только файлы приложения, без «../»), перепаковывает в apps/<id>.zip, достаёт иконку в icons/ и пишет
catalog.json с размером и SHA-256. С ключом --check только проверяет (для заявок) и падает при ошибке.
"""
import hashlib
import io
import json
import os
import posixpath
import re
import sys
import zipfile

ALLOWED = {".json", ".lua", ".png", ".obj", ".txt", ".md", ".ogg", ".wav", ".mp3"}
CATEGORIES = {"games", "tools", "social", "media", "education", "finance", "server", "other"}
UID = re.compile(r"^[a-z0-9]{6,24}$")
MAX_UNPACKED = 64 * 1024 * 1024
MAX_FILES = 1200
ID = re.compile(r"^[a-z0-9_-]{1,32}$")


def pick(value, lang="ru_ru"):
    if isinstance(value, dict):
        return value.get(lang) or value.get("en_us") or next(iter(value.values()), "")
    return value or ""


def read_app(path):
    """Файлы приложения из архива: {относительный путь: байты}. Ошибка — ValueError."""
    files = {}
    total = 0
    with zipfile.ZipFile(path) as z:
        for info in z.infolist():
            if info.is_dir():
                continue
            name = posixpath.normpath(info.filename.replace("\\", "/"))
            if name.startswith("../") or name.startswith("/") or ".." in name.split("/"):
                raise ValueError("bad path " + info.filename)
            if os.path.splitext(name)[1].lower() not in ALLOWED:
                continue
            total += info.file_size
            if total > MAX_UNPACKED or len(files) > MAX_FILES:
                raise ValueError("archive is too big")
            files[name] = z.read(info)
    if "app.json" not in files:
        tops = {n.split("/")[0] for n in files if "/" in n}
        if len(tops) == 1:
            top = tops.pop() + "/"
            files = {n[len(top):]: d for n, d in files.items() if n.startswith(top)}
    if "app.json" not in files:
        raise ValueError("no app.json")
    return files


def fingerprints(files):
    """Отпечатки файлов кода и моделей (заметного размера) — по ним находятся копии чужих приложений."""
    return {hashlib.sha256(data).hexdigest(): name for name, data in files.items()
            if os.path.splitext(name)[1].lower() in (".lua", ".obj") and len(data) >= 300}


def find_copies():
    """Пары приложений с одинаковыми файлами кода — копия (одно из них прислано под чужим именем)."""
    prints = {}
    problems = []
    for file in sorted(os.listdir("apps-src")) if os.path.isdir("apps-src") else []:
        if file.endswith(".zip"):
            try:
                prints[file[:-4]] = fingerprints(read_app(os.path.join("apps-src", file)))
            except Exception:  # noqa: BLE001 — битый архив покажет основная проверка
                pass
    ids = sorted(prints)
    for i, a in enumerate(ids):
        for b in ids[i + 1:]:
            same = set(prints[a]) & set(prints[b])
            if same:
                problems.append("%s and %s share code (%s) — looks like a copy" % (a, b, prints[a][next(iter(same))]))
    return problems


def build_reviews_summary():
    """reviews/summary.json: {id: {avg, count}} по файлам reviews/<id>.json (их пишет приёмник)."""
    os.makedirs("reviews", exist_ok=True)
    summary = {}
    for file in sorted(os.listdir("reviews")):
        if not file.endswith(".json") or file == "summary.json":
            continue
        try:
            with open(os.path.join("reviews", file), encoding="utf-8") as f:
                reviews = json.load(f).get("reviews", [])
            stars = [int(r["stars"]) for r in reviews if 1 <= int(r.get("stars", 0)) <= 5]
            if stars:
                summary[file[:-5]] = {"avg": round(sum(stars) / len(stars), 2), "count": len(stars)}
        except Exception as e:  # noqa: BLE001 — испорченный файл отзывов не ломает каталог
            print("ERROR reviews", file, e)
    with open(os.path.join("reviews", "summary.json"), "w", encoding="utf-8") as f:
        json.dump(summary, f, ensure_ascii=False, indent=1)
    print("reviews/summary.json:", len(summary), "apps")


def previous_entries():
    """Записи прошлого catalog.json: id → запись (uid нельзя поменять при обновлении; сломанное обновление — оставить старую)."""
    try:
        with open("catalog.json", encoding="utf-8") as f:
            return {a["id"]: a for a in json.load(f).get("apps", []) if a.get("id")}
    except Exception:  # noqa: BLE001 — каталога ещё нет
        return {}


def read_changelog(app_id):
    """changelogs/<id>.json (пишет приёмник при публикации): {"version", "text", "time"} или None."""
    try:
        with open(os.path.join("changelogs", app_id + ".json"), encoding="utf-8") as f:
            data = json.load(f)
        return {"version": str(data.get("version", "")), "text": str(data.get("text", "")).strip()[:1500],
                "time": int(data.get("time", 0))}
    except Exception:  # noqa: BLE001 — чейнджлога нет
        return None


def main():
    check = "--check" in sys.argv
    apps, errors = [], []
    old_entries = previous_entries()
    old_uids = {k: v["uid"] for k, v in old_entries.items() if v.get("uid")}
    seen_uids = {}
    if check:
        for problem in find_copies():
            errors.append(problem)
            print("ERROR", problem)
    os.makedirs("apps", exist_ok=True)
    os.makedirs("icons", exist_ok=True)
    for file in sorted(os.listdir("apps-src")) if os.path.isdir("apps-src") else []:
        if not file.endswith(".zip"):
            continue
        app_id = file[:-4]
        try:
            if not ID.match(app_id):
                raise ValueError("file name must be <id>.zip (a-z, 0-9, _ -)")
            files = read_app(os.path.join("apps-src", file))
            manifest = json.loads(files["app.json"].decode("utf-8"))
            if manifest.get("id", app_id).lower() != app_id:
                raise ValueError('id in app.json is "%s"' % manifest.get("id"))
            if "script" in manifest and manifest["script"] not in files:
                raise ValueError("script %s not found" % manifest["script"])
            uid = str(manifest.get("uid", "")).lower()
            if uid and not UID.match(uid):
                raise ValueError('bad uid "%s" (6-24 chars a-z 0-9)' % uid)
            if app_id in old_uids and uid != old_uids[app_id]:
                raise ValueError('uid changed from "%s" to "%s" — an update must keep its uid' % (old_uids[app_id], uid))
            if uid and uid in seen_uids:
                raise ValueError('uid "%s" is already used by %s' % (uid, seen_uids[uid]))
            if uid:
                seen_uids[uid] = app_id
            category = str(manifest.get("category", "other")).lower()
            if category not in CATEGORIES:
                category = "other"
            if check:
                notes = read_changelog(app_id)
                print("OK", app_id, manifest.get("version", "1.0"), "uid=" + (uid or "-"), "category=" + category)
                if notes:
                    print("   changelog", notes["version"] + ":", notes["text"][:200].replace("\n", " / "))
                continue
            buf = io.BytesIO()
            with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
                for name in sorted(files):
                    # Постоянная дата внутри архива: одинаковое приложение — одинаковый zip (без лишних изменений).
                    info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
                    info.compress_type = zipfile.ZIP_DEFLATED
                    z.writestr(info, files[name])
            data = buf.getvalue()
            with open(os.path.join("apps", app_id + ".zip"), "wb") as f:
                f.write(data)
            entry = {
                "id": app_id,
                "name": pick(manifest.get("name", app_id)),
                "version": str(manifest.get("version", "1.0")),
                "author": manifest.get("author", ""),
                "description": pick(manifest.get("description", "")),
                "permissions": manifest.get("permissions", []),
                "download": "apps/" + app_id + ".zip",
                "size": len(data),
                "sha256": hashlib.sha256(data).hexdigest(),
                "category": category,
            }
            if uid:
                entry["uid"] = uid
            notes = read_changelog(app_id)
            if notes and notes["text"]:
                entry["changelog"] = notes["text"]
                entry["updated"] = notes["time"]
            if "icon.png" in files:
                with open(os.path.join("icons", app_id + ".png"), "wb") as f:
                    f.write(files["icon.png"])
                entry["icon"] = "icons/" + app_id + ".png"
            apps.append(entry)
            print("+", app_id, entry["version"])
        except Exception as e:  # noqa: BLE001 — показать любую ошибку архива
            errors.append("%s: %s" % (file, e))
            print("ERROR", file, e)
            # Обновление не прошло проверку — в каталоге остаётся прошлая версия (её архив в apps/ не тронут),
            # а не пропадает приложение целиком.
            old = old_entries.get(app_id)
            if not check and old and os.path.isfile(os.path.join("apps", app_id + ".zip")):
                apps.append(old)
                if old.get("uid"):
                    seen_uids[old["uid"]] = app_id
                print("KEEP", app_id, old.get("version"), "(previous version stays)")
    if check:
        sys.exit(1 if errors else 0)
    build_reviews_summary()
    with open("catalog.json", "w", encoding="utf-8") as f:
        json.dump({"name": "BlockPhone — официальный каталог", "apps": apps}, f, ensure_ascii=False, indent=2)
    print("catalog.json:", len(apps), "apps,", len(errors), "errors")


if __name__ == "__main__":
    main()
