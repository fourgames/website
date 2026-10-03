"""Steam community discussions: new threads and new replies in every subforum. Steam has no API for
forums, so this reads the same HTML and JSON the forum pages use."""

import math
import re
import time

from bs4 import BeautifulSoup

import steam

PAGE_SIZE = 15  # replies per topic page
MAX_TOPICS_PER_RUN = 120  # bounds a first backfill; the rest follows next run
MAX_LIST_PAGES = 20  # 50 topics each, per subforum
# Studio accounts (Steam account IDs) whose posts are ours, not feedback. Steam badges developers in
# the regular forums (those are learned automatically), but not in announcement comments.
DEV_ACCOUNTS = {"1029710208"}  # Danny


def subforums(app_id):
    """(owner clan id, {watermark key: (forum type, feature, name)}): the discussion subforums plus
    the comments under announcements and patch notes. Reported posts are moderator-only, and the
    trading forum isn't feedback."""
    html = steam.request(f"https://steamcommunity.com/app/{app_id}/discussions/", as_json=False)
    owner = re.search(r'"owner":"(\d+)"', html)
    if not owner:
        return None, {}
    soup = BeautifulSoup(html, "html.parser")
    forums = {}
    for a in soup.select('a[href*="/discussions/"]'):
        m = re.search(rf"/app/{app_id}/discussions/(\d+)/$", a.get("href", ""))
        if m and m.group(1) not in forums:
            forums[m.group(1)] = ("General", m.group(1), a.get_text(strip=True))
    forums = forums or {"0": ("General", "0", "General Discussions")}
    try:
        events = steam.request(f"https://steamcommunity.com/app/{app_id}/eventcomments/", as_json=False)
        feature = re.search(r'"type":"Event","feature":"(\d+)"', events)
        if feature:
            forums[f"event:{feature.group(1)}"] = ("Event", feature.group(1), "Events & Announcements")
    except steam.HttpError as error:
        print(f"[forum] {app_id} announcement comments: {error}")
    return owner.group(1), forums


def topic_list(owner, kind, forum, since):
    """Topics with activity after `since`, newest activity first (pinned topics are skipped)."""
    topics = []
    for page in range(MAX_LIST_PAGES):
        res = steam.request(
            f"https://steamcommunity.com/forum/{owner}/{kind}/render/{forum}/", params={"start": page * 50, "count": 50}
        )
        soup = BeautifulSoup(res.get("topics_html") or "", "html.parser")
        rows = soup.select("div.forum_topic")
        older = False
        for row in rows:
            last = row.select_one(".forum_topic_lastpost")
            last_post = int(last["data-timestamp"]) if last and last.get("data-timestamp") else 0
            if "sticky" in (row.get("class") or []):
                continue
            if last_post <= since:
                older = True
                continue
            replies = row.select_one(".forum_topic_reply_count")
            topics.append(
                {
                    "id": row.get("data-gidforumtopic"),
                    "url": row.select_one("a.forum_topic_overlay")["href"],
                    "lastPost": last_post,
                    "replies": int(re.sub(r"\D", "", replies.get_text()) or 0) if replies else 0,
                }
            )
        if older or len(rows) < 50 or (page + 1) * 50 >= int(res.get("total_count") or 0):
            break
        time.sleep(0.5)
    return topics


def _text(node):
    for quote in node.select("blockquote, .bb_blockquote"):
        quote.decompose()  # "Originally posted by…" quotes repeat what's stored already
    return node.get_text("\n", strip=True)


def _author(link):
    if not link:
        return {"id": None, "name": None}
    return {"id": link.get("data-miniprofile") or link.get("href"), "name": link.get_text(strip=True)}


def topic_pages(url, first_reply_page):
    """The opening post plus every reply from `first_reply_page` (1-based) on. Returns (op, replies)."""
    op, replies, page = None, [], 1
    last_page = None
    while True:
        html = steam.request(url, params={"ctp": page} if page > 1 else None, as_json=False)
        soup = BeautifulSoup(html, "html.parser")
        if page == 1:
            node = soup.select_one("div.forum_op")
            if node is None:
                return None, []  # deleted, or hidden by a moderator
            stamp = node.select_one("[data-timestamp]")
            author = node.select_one("a.forum_op_author")
            op = {
                "title": node.select_one(".topic").get_text(" ", strip=True) if node.select_one(".topic") else "",
                "text": _text(node.select_one(".content")) if node.select_one(".content") else "",
                "author": _author(author),
                "created": int(stamp["data-timestamp"]) if stamp else 0,
                "dev": "commentthread_author_developer" in ((author.get("class") if author else None) or []),
            }
            total = re.search(r'InitializeCommentThread\(.*?"total_count":(\d+)', html, re.S)
            last_page = max(1, math.ceil(int(total.group(1)) / PAGE_SIZE)) if total else 1
        if page >= first_reply_page:
            for c in soup.select("div.commentthread_comment"):
                author = c.select_one("a.commentthread_author_link")
                stamp = c.select_one(".commentthread_comment_timestamp[data-timestamp]")
                body = c.select_one(".commentthread_comment_text")
                replies.append(
                    {
                        "id": (c.get("id") or "").removeprefix("comment_"),
                        "author": _author(author),
                        "created": int(stamp["data-timestamp"]) if stamp else 0,
                        "text": _text(body) if body else "",
                        "dev": "commentthread_author_developer" in ((author.get("class") if author else None) or []),
                    }
                )
        page = max(page + 1, first_reply_page)
        if page > last_page:
            return op, replies
        time.sleep(0.5)


def ingest(state, game, run):
    """New threads, new replies, and edits to the posts on the pages it reads."""
    app_id = game["appId"]
    try:
        owner, forums = subforums(app_id)
    except steam.HttpError as error:
        print(f"[forum] {game['name']}: {error}")
        return
    if not owner:
        return
    marks = state["watermarks"].setdefault("forums", {})
    threads = state.setdefault("threads", {})
    budget = MAX_TOPICS_PER_RUN
    devs = set(state.setdefault("devAccounts", [])) | DEV_ACCOUNTS
    for forum, (kind, feature, forum_name) in forums.items():
        try:
            topics = topic_list(owner, kind, feature, marks.get(forum, 0))
        except steam.HttpError as error:
            print(f"[forum] {game['name']} / {forum_name}: {error}")
            continue
        topics = [t for t in topics if t["lastPost"] > threads.get(t["id"], {}).get("lastPost", 0)]
        topics.sort(key=lambda t: t["lastPost"])  # oldest activity first, so the watermark can follow
        done = 0
        for topic in topics:
            if budget <= 0:
                break
            known = threads.get(topic["id"], {}).get("replies", 0)
            try:
                op, replies = topic_pages(topic["url"], known // PAGE_SIZE + 1)
            except steam.HttpError as error:
                print(f"[forum] topic {topic['id']}: {error}")
                break
            budget -= 1
            done += 1
            if op is None:
                if f"t{topic['id']}" in state["items"]:
                    state["items"][f"t{topic['id']}"]["deleted"] = True
                threads[topic["id"]] = {"lastPost": topic["lastPost"], "replies": known, "forum": forum_name}
                continue
            if kind == "Event":
                op["dev"] = True  # the announcement itself
            for post in [op, *replies]:
                if post["dev"] and post["author"]["id"]:
                    devs.add(post["author"]["id"])
                post["dev"] = post["dev"] or post["author"]["id"] in devs
            upsert(state, run, f"t{topic['id']}", "topic", topic["url"], op, forum=forum_name)
            for reply in replies:
                if reply["id"]:
                    upsert(state, run, f"c{reply['id']}", "reply", f"{topic['url']}#c{reply['id']}", reply,
                           topic=f"t{topic['id']}", forum=forum_name)
            count = sum(1 for i in state["items"].values() if i.get("topic") == f"t{topic['id']}")
            threads[topic["id"]] = {"lastPost": topic["lastPost"], "replies": max(count, known), "forum": forum_name}
        state["devAccounts"] = sorted(devs - DEV_ACCOUNTS)
        if done == len(topics):
            marks[forum] = max([marks.get(forum, 0)] + [t["lastPost"] for t in topics])
        elif done:
            marks[forum] = max(marks.get(forum, 0), topics[done - 1]["lastPost"])


def upsert(state, run, item_id, kind, url, post, **extra):
    item = state["items"].get(item_id)
    text = post["text"]
    if item is None:
        state["items"][item_id] = {
            "id": item_id,
            "kind": kind,
            "url": url,
            "author": post["author"],
            "created": post["created"],
            "updated": post["created"],
            "text": text,
            **({"title": post["title"]} if kind == "topic" else {}),
            **extra,
            "dev": post["dev"],
            "versions": [],
            "pending": not post["dev"],
        }
        run["new"].append(item_id)
        return
    title = post.get("title", item.get("title"))
    if text != item["text"] or title != item.get("title"):
        # Edited on Steam: keep what it said before.
        item["versions"].append({"at": item["updated"], "text": item["text"], **({"title": item["title"]} if "title" in item else {})})
        item.update(text=text, updated=int(time.time()), edited=True, pending=not item.get("dev"))
        if kind == "topic":
            item["title"] = title
        run["edited"].append(item_id)
