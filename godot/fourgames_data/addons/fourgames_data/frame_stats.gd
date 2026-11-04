extends RefCounted

## Frame times over a stretch of play, for the "perf" events: the average fps,
## the 1% low, the longest frame and how many frames ran over SLOW_MS. A frame
## costs a few adds and one histogram bucket -- nothing is allocated per frame --
## so it can watch every frame of a session.
##
## The 1% low is the fps of the 99th-percentile frame time, read off the
## histogram to the bucket's top (STEP_MS), so it errs a little slow.

const SLOW_MS := 50.0
## Half-millisecond buckets up to 250 ms; anything longer lands in the last.
const STEP_MS := 0.5
const BUCKETS := 501

var frames := 0
var total_ms := 0.0
var max_ms := 0.0
var slow := 0
var _buckets := PackedInt32Array()


func _init() -> void:
	_buckets.resize(BUCKETS)


func add(ms: float) -> void:
	if ms <= 0.0:
		return
	frames += 1
	total_ms += ms
	max_ms = maxf(max_ms, ms)
	if ms > SLOW_MS:
		slow += 1
	_buckets[mini(int(ms / STEP_MS), BUCKETS - 1)] += 1


## The frame time `p` of the frames came in at or under.
func percentile_ms(p: float) -> float:
	if frames == 0:
		return 0.0
	var above := frames - ceili(frames * p)
	var seen := 0
	for i in range(BUCKETS - 1, -1, -1):
		seen += _buckets[i]
		if seen > above:
			return max_ms if i == BUCKETS - 1 else minf((i + 1) * STEP_MS, max_ms)
	return max_ms


## What a "perf" event says about these frames. Nulls when there were none (the
## window was in the background the whole time).
func report() -> Dictionary:
	if frames == 0:
		return {"frames": 0, "fps_avg": null, "fps_1pct_low": null, "frame_ms_max": null, "slow_frames": 0}
	return {
		"frames": frames,
		"fps_avg": snappedf(1000.0 * frames / total_ms, 0.1),
		"fps_1pct_low": snappedf(1000.0 / maxf(percentile_ms(0.99), 0.001), 0.1),
		"frame_ms_max": snappedf(max_ms, 0.1),
		"slow_frames": slow,
	}


func reset() -> void:
	frames = 0
	total_ms = 0.0
	max_ms = 0.0
	slow = 0
	_buckets.fill(0)
