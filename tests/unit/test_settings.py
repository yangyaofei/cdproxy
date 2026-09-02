"""SettingsStore 纯逻辑单测（tmp_path 隔离，无真实配置路径依赖）。"""

import json

import pytest

from agent_browser_proxy.settings import RuntimeSettings, SettingsStore


@pytest.fixture()
def store(tmp_path):
    return SettingsStore(tmp_path / "settings.json")


class TestLoad:
    def test_missing_file_returns_defaults(self, tmp_path) -> None:
        store = SettingsStore(tmp_path / "none.json")
        assert store.settings == RuntimeSettings()

    def test_corrupt_file_returns_defaults(self, tmp_path) -> None:
        path = tmp_path / "settings.json"
        path.write_text("{not json", encoding="utf-8")
        store = SettingsStore(path)
        assert store.settings.disconnect_reap_seconds == 60.0

    def test_known_fields_loaded(self, tmp_path) -> None:
        path = tmp_path / "settings.json"
        path.write_text(
            json.dumps({"disconnect_reap_seconds": 30, "unknown": 1}),
            encoding="utf-8",
        )
        store = SettingsStore(path)
        assert store.settings.disconnect_reap_seconds == 30.0
        assert store.settings.alloc_reap_seconds == 300.0  # 未提及用默认

    def test_focus_mode_valid_loaded(self, tmp_path) -> None:
        path = tmp_path / "settings.json"
        path.write_text(json.dumps({"focus_mode": "steal"}), encoding="utf-8")
        store = SettingsStore(path)
        assert store.settings.focus_mode == "steal"

    def test_focus_mode_invalid_falls_back(self, tmp_path) -> None:
        path = tmp_path / "settings.json"
        path.write_text(json.dumps({"focus_mode": "chaos"}), encoding="utf-8")
        store = SettingsStore(path)
        assert store.settings.focus_mode == "background"  # 非法回落默认


class TestUpdate:
    def test_update_persists_and_applies(self, store: SettingsStore) -> None:
        updated = store.update({"alloc_reap_seconds": 120})
        assert updated.alloc_reap_seconds == 120.0
        # 重载验证持久化
        reloaded = SettingsStore(store._path)
        assert reloaded.settings.alloc_reap_seconds == 120.0

    def test_update_clamps_to_minimum(self, store: SettingsStore) -> None:
        updated = store.update({"disconnect_reap_seconds": 0})
        assert updated.disconnect_reap_seconds == 5.0

    def test_update_ignores_unknown_and_non_numeric(self, store: SettingsStore) -> None:
        updated = store.update({"hack": 1, "alloc_reap_seconds": "fast"})
        assert updated == RuntimeSettings()

    def test_update_focus_mode(self, store: SettingsStore) -> None:
        assert store.update({"focus_mode": "steal"}).focus_mode == "steal"
        # 非法值被忽略（保持当前）
        assert store.update({"focus_mode": "nope"}).focus_mode == "steal"

    def test_update_rejects_non_object(self, store: SettingsStore) -> None:
        with pytest.raises(ValueError):
            store.update([1, 2, 3])
