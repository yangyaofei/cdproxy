"""agent-browser-proxy：agent-browser 共享 Chrome 的 CDP 转发代理。

架构（一个进程管全部）：
- keeper：共享 Chrome 的生命周期（启动/复用/探活），固定调试端口
- proxy：CDP WebSocket 转发核心——每个消费 session 一条上游连接，
  下游单连接复用到 Chrome 浏览器级 WS；按 session 过滤 Target 域
  （tab 归属隔离），命令/响应 id 双向重映射
- control：本机 HTTP 控制面（分配/释放 session、状态查询）
- plugin（仓库 plugin/ 目录）：薄壳，把 agent-browser 的
  browser.launch/close 请求转到 control，返回代理后的 cdpUrl
"""
__version__ = "0.1.0"
