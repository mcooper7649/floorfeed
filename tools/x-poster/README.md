# x-poster

Publishes FloorFeed's approved posts to X through the web composer (Playwright, headless Chromium), so no paid X API access is needed. See "Auto-posting to X" in the main README.

Setup:

1. `python3 -m venv venv && venv/bin/pip install playwright && venv/bin/playwright install chromium`
2. Save a logged-in X session as a Playwright `storage_state` JSON (cookies incl. `auth_token` and `ct0`), `chmod 600`.
3. Cron: `*/20 * * * * cd /path/to/tools/x-poster && SOCIAL_TOKEN=... X_STATE=/path/state.json flock -n /tmp/x_post.lock venv/bin/python3 x_post.py >> poster.log 2>&1`

`--now` skips the random start delay (for testing). On failure a screenshot is saved to `$TMPDIR/x_post_error.png`, and after 3 failed attempts the post is marked failed and the Telegram card says why.
