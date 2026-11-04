"""Settings from the environment: defaults, blank lines, bad values."""

import pytest

from steamdata.config import DEFAULT_DB_PATH, Config, ConfigError


def test_defaults_from_empty_env():
    config = Config.from_env({})
    assert config.db_path == DEFAULT_DB_PATH
    assert config.web_api_key == ""
    assert config.country == "US"
    assert config.webapi_per_minute == 60 and config.appdetails_per_5min == 120
    assert config.pcgw_engines == ("Godot",)
    assert config.samples_keep_days == 0


def test_values_and_blank_lines():
    config = Config.from_env({"DB_PATH": " /x/steam.db ", "STEAM_WEB_API_KEY": " abc ", "COUNTRY": "se",
                              "WEBAPI_PER_MINUTE": "30", "APPDETAILS_PER_5MIN": "", "DETAILS_DAYS": "14",
                              "PCGW_ENGINES": "Godot, Redot", "LOG_LEVEL": "debug"})
    assert config.db_path == "/x/steam.db" and config.web_api_key == "abc"
    assert config.country == "SE" and config.webapi_per_minute == 30
    assert config.appdetails_per_5min == 120  # blank: the default
    assert config.details_days == 14 and config.pcgw_engines == ("Godot", "Redot")
    assert config.log_level == "DEBUG"


@pytest.mark.parametrize("env", [
    {"WEBAPI_PER_MINUTE": "fast"},
    {"WEBAPI_PER_MINUTE": "100"},       # over the Web API's 100,000 a day
    {"APPDETAILS_PER_5MIN": "250"},     # over the store's limit
    {"COUNTRY": "USA"},
    {"LOG_LEVEL": "LOUD"},
])
def test_bad_values(env):
    with pytest.raises(ConfigError):
        Config.from_env(env)
