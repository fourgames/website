extends "res://tests/tools/suite.gd"

## The perf events' arithmetic (frame_stats.gd): the average, the 1% low read
## off the histogram, the longest frame and the slow ones, and a reset.

const FrameStats := preload("res://addons/fourgames_data/frame_stats.gd")


func test_one_hitch_in_a_hundred_frames() -> void:
	var stats := FrameStats.new()
	for i in 99:
		stats.add(16.6)
	stats.add(100.0)
	var report := stats.report()
	assert_eq(report.frames, 100)
	assert_eq(report.fps_avg, snappedf(100000.0 / (99 * 16.6 + 100.0), 0.1))
	# 99 of the 100 frames came in at 16.6 ms, which the histogram reads as up to 17.
	assert_eq(report.fps_1pct_low, snappedf(1000.0 / 17.0, 0.1))
	assert_eq(report.frame_ms_max, 100.0)
	assert_eq(report.slow_frames, 1)


func test_the_1pct_low_is_the_slowest_hundredth() -> void:
	var stats := FrameStats.new()
	for i in 980:
		stats.add(10.0)
	for i in 20:
		stats.add(40.0)
	assert_eq(stats.percentile_ms(0.99), 40.0)
	assert_eq(stats.report().fps_1pct_low, 25.0)
	assert_eq(stats.report().slow_frames, 0, "40 ms is not over 50")


func test_a_frame_past_the_histogram_is_still_the_longest() -> void:
	var stats := FrameStats.new()
	stats.add(400.0)
	assert_eq(stats.report().frame_ms_max, 400.0)
	assert_eq(stats.percentile_ms(0.99), 400.0)
	assert_eq(stats.report().fps_1pct_low, 2.5)


func test_no_frames_say_nothing_and_a_reset_starts_over() -> void:
	var stats := FrameStats.new()
	assert_eq(stats.report(), {"frames": 0, "fps_avg": null, "fps_1pct_low": null, "frame_ms_max": null, "slow_frames": 0})
	stats.add(60.0)
	stats.add(0.0)
	assert_eq(stats.frames, 1, "a frame of no time is no frame")
	stats.reset()
	assert_eq(stats.report().frames, 0)
	stats.add(20.0)
	assert_eq(stats.report().frame_ms_max, 20.0)
	assert_eq(stats.report().slow_frames, 0)
