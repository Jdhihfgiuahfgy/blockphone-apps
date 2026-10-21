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

ALLOWED = {".json", ".lua", ".png", ".obj", ".txt", ".md"}
MAX_UNPACKED = 40 * 1024 * 1024
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
            if total > MAX_UNPACKED or len(files) > 400:
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


def main():
    check = "--check" in sys.argv
    apps, errors = [], []
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
            if check:
                print("OK", app_id, manifest.get("version", "1.0"))
                continue
            buf = io.BytesIO()
            with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
                for name in sorted(files):
                    z.writestr(name, files[name])
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
            }
            if "icon.png" in files:
                with open(os.path.join("icons", app_id + ".png"), "wb") as f:
                    f.write(files["icon.png"])
                entry["icon"] = "icons/" + app_id + ".png"
            apps.append(entry)
            print("+", app_id, entry["version"])
        except Exception as e:  # noqa: BLE001 — показать любую ошибку архива
            errors.append("%s: %s" % (file, e))
            print("ERROR", file, e)
    if check:
        sys.exit(1 if errors else 0)
    with open("catalog.json", "w", encoding="utf-8") as f:
        json.dump({"name": "BlockPhone — официальный каталог", "apps": apps}, f, ensure_ascii=False, indent=2)
    print("catalog.json:", len(apps), "apps,", len(errors), "errors")


if __name__ == "__main__":
    main()
