# Steam broadcasts

A video on repeat, shown as a broadcast on a game's Steam store page, around the clock. Steam can't
loop anything itself ("You need to continue to send us the video"), so the server sends it: one
`steam-broadcast@<name>` service per stream, each copying a prepared file to Steam over RTMP.

## Steam's side (once per stream)

1. **A streaming account.** Not limited (it has spent at least $5 on Steam) and it owns the game.
   One stream key per account, so each stream that runs at the same time needs its own account.
2. **Permission to broadcast:** Steamworks → Users & Permissions → that account gets *Broadcast
   Live*, or it joins [Store Broadcast Beta](https://steamcommunity.com/groups/storebroadcastbeta).
3. **Allowed on the store page:** Steamworks → the game → Edit Store Page → Special Settings →
   *Steam Broadcast (Beta)*: add the streaming account.
4. **The key:** signed in as that account, [steamcommunity.com/broadcast/upload](https://steamcommunity.com/broadcast/upload):
   set the game's App ID (the base game, not a demo), *Create RTMP Token*, and set the broadcast to
   **Public** (new ones are friends only). The token is a password.
5. **Mark it as not live.** Steam's rule for replays: a banner or title that says the stream is not
   live. `prepare.sh` puts "Pre-recorded" in the bottom right (pass another text as its third
   argument); a title like "Pomo Valley trailer (pre-recorded)" covers it too.

## Server side

```bash
# The video in Steam's format, with the banner. The server has ffmpeg, so send the original there
# and convert it there (a slow but one-time job on its one core: a few minutes for a 2-minute trailer)
scp trailer.mov fourgames-server:/tmp/
ssh fourgames-server '/srv/fourgames/own/server/broadcast/prepare.sh /tmp/trailer.mov /srv/fourgames/broadcast/pomo-valley.mp4 && rm /tmp/trailer.mov'

# On the server: the key (from a file, never typed into chat), then start it
sudo install -m 640 -o root -g fourgames /dev/null /etc/fourgames/broadcast/pomo-valley.env
sudo nano /etc/fourgames/broadcast/pomo-valley.env      # see broadcast.env.example
sudo systemctl enable --now steam-broadcast@pomo-valley
journalctl -u steam-broadcast@pomo-valley -f
```

It reconnects on its own when Steam drops it, and starts again after a reboot. Stop a stream with
`sudo systemctl disable --now steam-broadcast@pomo-valley`; a new video is just a new file and a
`restart`.

`steam-broadcast-status.timer` writes `/srv/fourgames/status/broadcast.json` every minute, and
status.fourgames.se shows a *Steam broadcasts* row once a stream is set up.

## What it costs

- **CPU:** next to none. The video is encoded once (on the server or a Mac with ffmpeg); the stream only copies it
  (`ffmpeg -c copy`). The server has one core, so it could not encode live.
- **Traffic:** 4.5 Mbit/s per stream, about **1.5 TB a month**. Start with one or two and check
  Strato's traffic after a week.
