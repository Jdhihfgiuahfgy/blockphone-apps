# BlockPhone — официальный каталог приложений

Приложения для телефона из мода BlockPhone (Minecraft). Их видно в приложении «Магазин» в телефоне.

* `apps-src/<id>.zip` — приложения, как их прислали (заявки от игроков приходят сюда через Pull Request).
* `catalog.json`, `apps/`, `icons/` — собираются автоматически (`build_catalog.py`, GitHub Actions) — руками не править.
* `worker.js` — «приёмник» публикаций для Cloudflare Workers.

Как устроено и как одобрять заявки — `docs/STORE_SETUP.md` в репозитории мода.
