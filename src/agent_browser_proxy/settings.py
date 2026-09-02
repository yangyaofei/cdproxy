"""运行时设置：可在 Admin 页面在线修改的参数。

持久化到 var/settings.json（启动加载，修改即存盘并即时生效——
被 proxy 在排程回收时现读，无缓存失效问题）。
"""

import json
import logging
from dataclasses import asdict, dataclass, fields
from pathlib import Path

logger = logging.getLogger(__name__)

# 各字段的下限（防误配成 0 导致回收风暴）
_MIN_VALUES = {
    "disconnect_reap_seconds": 5.0,
    "alloc_reap_seconds": 5.0,
}


@dataclass
class RuntimeSettings:
    """运行时可调参数。

    :param disconnect_reap_seconds: 上游断连后的回收宽限（容忍 daemon 重启）。
    :param alloc_reap_seconds: 分配后从未连接的回收时限（防泄漏）。
    """

    disconnect_reap_seconds: float = 60.0
    alloc_reap_seconds: float = 300.0


def default_settings_path() -> Path:
    """默认设置文件位置（仓库 var/ 下）。"""
    return Path(__file__).resolve().parents[2] / "var" / "settings.json"


class SettingsStore:
    """设置的加载/校验/保存。"""

    def __init__(self, path: Path) -> None:
        self._path = path
        self.settings = self._load()

    def _load(self) -> RuntimeSettings:
        """从磁盘加载；缺失/损坏回落默认值。"""
        if not self._path.exists():
            return RuntimeSettings()
        try:
            data = json.loads(self._path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            logger.warning("settings.json 损坏，回落默认值: %s", self._path)
            return RuntimeSettings()
        known = {f.name: f.type for f in fields(RuntimeSettings)}
        kwargs = {
            k: v for k, v in data.items() if k in known and isinstance(v, (int, float))
        }
        return RuntimeSettings(**kwargs)

    def update(self, patch: dict) -> RuntimeSettings:
        """合并式更新（未知字段忽略，越下限钳制），存盘并返回新值。

        :raises ValueError: patch 不是对象。
        """
        if not isinstance(patch, dict):
            raise ValueError("settings 必须是 JSON 对象")
        current = asdict(self.settings)
        for key, value in patch.items():
            if key not in current or not isinstance(value, (int, float)):
                continue
            minimum = _MIN_VALUES.get(key)
            current[key] = max(float(value), minimum) if minimum else float(value)
        self.settings = RuntimeSettings(**current)
        self._save()
        logger.info("设置已更新: %s", current)
        return self.settings

    def _save(self) -> None:
        """原子写盘（临时文件 + rename）。"""
        self._path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self._path.with_suffix(".json.tmp")
        tmp.write_text(
            json.dumps(asdict(self.settings), ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        tmp.replace(self._path)
