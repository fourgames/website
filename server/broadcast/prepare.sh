#!/usr/bin/env bash
# Turns any video (trailer, gameplay capture) into a file Steam's broadcast accepts, with a "not live"
# banner, once. Run it on the Mac (brew install ffmpeg), then copy the result to the server:
#   server/broadcast/prepare.sh trailer.mov pomo-valley.mp4 ["Trailer · not live"]
#   scp pomo-valley.mp4 fourgames-server:/srv/fourgames/broadcast/
# Steam's rules: H.264 High 4.1, 30 or 60 fps, keyframe every 2 s, CBR, at most 7000 kbit/s; AAC-LC
# audio at most 128 kbit/s. A replay must say it isn't live, hence the banner. 1080p30 at 4500 kbit/s
# looks fine for a trailer and keeps the traffic near 1.5 TB a month per stream.
set -euo pipefail
in=${1:?usage: prepare.sh INPUT OUTPUT.mp4 [BANNER]}
out=${2:?usage: prepare.sh INPUT OUTPUT.mp4 [BANNER]}
banner=${3:-Trailer · not live}
command -v ffmpeg >/dev/null || { echo "ffmpeg is missing: brew install ffmpeg" >&2; exit 1; }

font=""
for f in "/System/Library/Fonts/Supplemental/Arial Bold.ttf" /usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf; do
  [ -r "$f" ] && { font=$f; break; }
done

# Scale to fit 1920x1080 (black bars when it isn't 16:9), 30 fps, and the banner in the top left.
vf="scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,fps=30"
if ffmpeg -hide_banner -filters 2>/dev/null | grep -q drawtext; then
  text=${banner//:/\\:}
  vf+=",drawtext=${font:+fontfile='$font':}text='${text//\'/}':fontsize=34:fontcolor=white:box=1:boxcolor=black@0.55:boxborderw=14:x=36:y=36"
else
  echo "This ffmpeg can't draw text: the banner is left out. Put 'not live' in the stream title on Steam instead." >&2
fi

# A video without sound gets silence: Steam expects an audio track.
if ffprobe -v error -select_streams a -show_entries stream=index -of csv=p=0 "$in" | grep -q .; then
  audio=(-map 0:v:0 -map 0:a:0)
else
  audio=(-f lavfi -i anullsrc=r=48000:cl=stereo -map 0:v:0 -map 1:a:0 -shortest)
fi

ffmpeg -hide_banner -y -i "$in" "${audio[@]}" -vf "$vf" \
  -c:v libx264 -profile:v high -level:v 4.1 -pix_fmt yuv420p -preset slow \
  -b:v 4500k -minrate 4500k -maxrate 4500k -bufsize 9000k -x264-params nal-hrd=cbr \
  -g 60 -keyint_min 60 -sc_threshold 0 \
  -c:a aac -b:a 128k -ar 48000 -ac 2 \
  -movflags +faststart "$out"
echo "Ready: $out ($(du -h "$out" | cut -f1)). Copy it to /srv/fourgames/broadcast/ on the server."
