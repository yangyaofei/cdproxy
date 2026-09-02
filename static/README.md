# static/ — Admin 页静态文件

Admin 管理页的纯静态前端资产（无构建步骤），随代码仓库分发。

## 定位

| 项 | 说明 |
|----|------|
| 技术栈 | Alpine.js + 原生 JS + CSS，**零构建**——修改即生效，无 npm/webpack 环节 |
| 挂载 | `src/agent_browser_proxy/control.py` 的 `_STATIC_DIR`（GET / 与 GET /static/&lt;file&gt;） |
| `alpine.min.js` | 本地内置第三方库（3.14.9 版本固定），不走 CDN |
| 加载顺序 | `app.js` 必须在 `alpine.min.js` **之前**（Alpine 执行时组件函数需已定义） |

## 文件清单

| 文件 | 职责 |
|------|------|
| `admin/index.html` | 入口页（基座状态/会话表/设置表单/日志尾巴/停机） |
| `admin/app.js` | 应用逻辑（Alpine 组件 + API 调用） |
| `admin/app.css` | 样式 |
| `admin/vendor/alpine.min.js` | Alpine.js 运行时（本地固定版本） |

## 路径解析

`_STATIC_DIR` 相对包内模块的 `parents[2]`（仓库根 `static/admin/`）解析：
仓库根运行与容器部署（`COPY . .`）均正确。本项目不分发为 pip 包；
若未来改为安装分发，需将静态目录改为可配置路径。
