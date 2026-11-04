@tool
extends EditorPlugin

## Enabling the plugin registers the GameData autoload (game_data.gd), and
## disabling it takes it away again. The path is read off this script's own
## folder, so the addon works wherever it is copied to.

const AUTOLOAD := "GameData"


func _enable_plugin() -> void:
	if not ProjectSettings.has_setting("autoload/" + AUTOLOAD):
		add_autoload_singleton(AUTOLOAD, get_script().resource_path.get_base_dir().path_join("game_data.gd"))


func _disable_plugin() -> void:
	if ProjectSettings.has_setting("autoload/" + AUTOLOAD):
		remove_autoload_singleton(AUTOLOAD)
