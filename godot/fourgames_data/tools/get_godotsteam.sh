#!/usr/bin/env sh
# Copies GodotSteam's desktop binaries (osx, win64, linux64; ~30 MB) into this test project from one
# of the games, since they aren't kept in the website repo. addons/godotsteam/godotsteam.gdextension
# (trimmed to desktop 64-bit) is in the repo. Run from anywhere:
#   sh godot/fourgames_data/tools/get_godotsteam.sh [path/to/a/game]   (default: ../Pomo-Valley)
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
src=${1:-"$here/../../../Pomo-Valley"}/addons/godotsteam
[ -d "$src" ] || { echo "No GodotSteam at $src; pass a game folder that has addons/godotsteam" >&2; exit 1; }
dst="$here/addons/godotsteam"
for d in osx win64 linux64; do
  [ -d "$src/$d" ] || { echo "Missing $src/$d" >&2; exit 1; }
  rm -rf "$dst/$d" && cp -R "$src/$d" "$dst/"
done
echo "GodotSteam binaries copied to $dst ($(du -sh "$dst" | cut -f1))"
