# Homepage rollback

As of this change, **Flagster** (the flag football game) is served as the
homepage at `/` (`index.html`). The previous personal portfolio site is fully
preserved and can be restored at any time — nothing was deleted.

## Where the old portfolio lives now

- **Live backup:** it still works at **`/index-portfolio.html`**
  (all its assets — `css/`, `js/`, `lib/`, `templates/`, `img/` — are untouched).
- **Git history:** the `master` branch still has the portfolio as its homepage,
  so `master:index.html` is the original, unchanged portfolio entry point.
  (A local tag `portfolio-site` also marks it, if present in your clone.)

## Roll back to the portfolio homepage

Pick either method.

**A. Simplest — copy the backup over the homepage:**

```bash
cp index-portfolio.html index.html
git commit -am "Restore portfolio as homepage"
git push
```

**B. From git history (restores the exact original index.html from master):**

```bash
git checkout master -- index.html
git commit -m "Restore portfolio as homepage"
git push
```

Either way the game stays available at **`/flagster/`**, so you lose nothing.

## Go back to Flagster as the homepage

```bash
git checkout <this-commit> -- index.html   # or re-copy the game entry
```

## What changed

| Path | Before | After |
| --- | --- | --- |
| `/` (`index.html`) | Portfolio (Ionic) | **Flagster game** |
| `/index-portfolio.html` | — | Portfolio (live backup) |
| `/flagster/` | Flagster game | Flagster game (unchanged) |
| `css/`, `js/`, `lib/`, `templates/`, `img/` | Portfolio assets | Portfolio assets (unchanged) |
