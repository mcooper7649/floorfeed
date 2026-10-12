#!/usr/bin/env python3
"""Publish FloorFeed's next approved post to X through the web UI.

Run from cron every ~20 minutes. It asks the API for the next approved post
(GET /social/next, which also enforces spacing between posts), types it into
X's composer with a logged-in Playwright session, attaches the image, posts,
and reports the result (POST /social/<id>/result).

Env:
  FLOORFEED_API   API base, default http://127.0.0.1:8030
  SOCIAL_TOKEN    shared secret, same as the server's SOCIAL_TOKEN
  X_STATE         Playwright storage_state JSON of the logged-in X session
"""
import json
import os
import random
import sys
import tempfile
import time
import urllib.request

from playwright.sync_api import sync_playwright

API = os.environ.get("FLOORFEED_API", "http://127.0.0.1:8030")
TOKEN = os.environ["SOCIAL_TOKEN"]
STATE = os.path.expanduser(os.environ.get("X_STATE", "~/world-monitor/storage_state.json"))
HANDLE = os.environ.get("X_HANDLE", "FloorFeed")
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36"


def api(method, path, body=None):
    req = urllib.request.Request(
        API + path,
        method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"authorization": f"Bearer {TOKEN}", "content-type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=20) as r:
        return r.status, (json.loads(r.read() or b"null") if r.status != 204 else None)


def download(url):
    req = urllib.request.Request(url, headers={"user-agent": UA})
    with urllib.request.urlopen(req, timeout=30) as r:
        kind = r.headers.get("content-type", "")
        data = r.read()
    ext = ".png" if "png" in kind else ".gif" if "gif" in kind else ".webp" if "webp" in kind else ".jpg"
    f = tempfile.NamedTemporaryFile(suffix=ext, delete=False)
    f.write(data)
    f.close()
    return f.name


def find_post(pg, text):
    """URL of a recent post on our profile starting with this text, if any."""
    pg.goto(f"https://x.com/{HANDLE}", wait_until="domcontentloaded")
    first_line = text.split("\n")[0][:25]
    for _ in range(8):
        arts = pg.locator("article").all()[:6]
        for a in arts:
            if first_line in a.inner_text():
                href = a.locator("a time").first.locator("xpath=..").get_attribute("href")
                return "https://x.com" + href if href else "https://x.com/" + HANDLE
        if arts:
            return None
        time.sleep(2)
    return None


def publish(post):
    image = None
    if post.get("image"):
        try:
            image = download(post["image"])
        except Exception as e:  # post without the image rather than not at all
            print("image download failed:", e, flush=True)

    with sync_playwright() as p:
        b = p.chromium.launch(headless=True, args=["--disable-blink-features=AutomationControlled"])
        ctx = b.new_context(storage_state=STATE, user_agent=UA, viewport={"width": 1280, "height": 1000})
        pg = ctx.new_page()
        try:
            # A previous attempt may have posted before failing; don't post twice.
            existing = find_post(pg, post["text"])
            if existing:
                print("already on the profile:", existing, flush=True)
                return existing
            pg.goto("https://x.com/compose/post", wait_until="domcontentloaded")
            box = pg.locator('[data-testid="tweetTextarea_0"]').first
            box.wait_for(timeout=30_000)
            box.click()
            time.sleep(1)
            # The composer is a rich-text editor: type line by line, Enter between.
            lines = post["text"].split("\n")
            for i, line in enumerate(lines):
                if line:
                    pg.keyboard.insert_text(line)
                if i < len(lines) - 1:
                    pg.keyboard.press("Enter")
                time.sleep(random.uniform(0.2, 0.6))
            if image:
                pg.locator('input[data-testid="fileInput"]').first.set_input_files(image)
                pg.locator('[data-testid="attachments"]').first.wait_for(timeout=60_000)
            btn = pg.locator('[data-testid="tweetButton"]').first
            for _ in range(60):  # wait for the upload to finish and the button to enable
                if btn.is_enabled():
                    break
                time.sleep(1)
            time.sleep(random.uniform(1, 3))
            btn.click()
            # Once the post is accepted X leaves /compose/post for the timeline
            # (which has its own inline composer, so don't wait on the textarea).
            for _ in range(60):
                if "/compose/" not in pg.url:
                    break
                time.sleep(1)
            else:
                raise TimeoutError("composer did not close")
            time.sleep(4)

            url = None
            for _ in range(3):  # the profile can lag a few seconds behind
                url = find_post(pg, post["text"])
                if url:
                    break
                time.sleep(4)
            ctx.storage_state(path=STATE)  # keep refreshed cookies
            os.chmod(STATE, 0o600)
            return url
        except Exception:
            pg.screenshot(path=os.path.join(tempfile.gettempdir(), "x_post_error.png"))
            raise
        finally:
            b.close()
            if image:
                os.unlink(image)


def main():
    status, post = api("GET", "/social/next")
    if status == 204 or not post:
        print("nothing to post", flush=True)
        return
    # Don't post at the exact same minute every time.
    if "--now" not in sys.argv:
        time.sleep(random.uniform(0, 240))
    print(f"posting #{post['id']} ({post['kind']})", flush=True)
    try:
        url = publish(post)
        api("POST", f"/social/{post['id']}/result", {"ok": True, "url": url})
        print("posted", url, flush=True)
    except Exception as e:
        api("POST", f"/social/{post['id']}/result", {"ok": False, "error": f"{type(e).__name__}: {e}"[:480]})
        print("failed:", e, flush=True)
        sys.exit(1)


if __name__ == "__main__":
    main()
