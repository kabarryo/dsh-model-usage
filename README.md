> **本插件全程由 DeepSeek Harness（DSH）+ DeepSeek V4.1 Flash 开发与维护：100% 纯 AI 生成，人工代码 0 添加。**

# dsh-model-usage

DSH 的模型额度插件。在会话输入框下方的状态区加一枚 pill，显示订阅的 5 小时 / 本周 / 本月用量，点开看重置时间与倒计时。

```
5H 26% · W 23% · M 25%
```

## 先说范围：目前只支持 opencode-go

名字叫 model usage，但**当前只实现了 opencode-go 订阅**（含同一套 `/usage` 端点的 Go / Go Plus 计划）。

- 数据来自 OpenCode 的订阅用量端点，只有这类订阅会返回该结构。
- 其它供应商（DeepSeek 官方、第三方中转、BYOK）没有这个端点：插件不报错，pill 直接不显示。
- 其它订阅**随缘开发**，不做承诺。想加自己的订阅，看下面的「配置」——只要对方也有等价的用量端点，填一行 meter 即可。

## 效果

收起态（在内置统计 pill 旁边，样式与之一致）：

```
5H 26% · W 23% · M 25%
```

点开是明细层：三个窗口各一条进度条、百分比、重置时间与倒计时，底部是数据新鲜度和刷新按钮。

进度条按用量分五档：绿（0–69%）、黄（70–79%）、橙（80–89%）、红（90–99%），到 100% 或端点拒绝时转红并在 pill 图标位与行首出现 ⚠。橙色没有专用主题 token，用黄红两色混合，浅色主题随 token 自动换算。

## 数据来源与口径

Host 侧调用 `GET {baseURL}/usage`，用与对话同一把 API Key：

```
{"usage":{
  "rolling":{"status":"ok","percent":26,"resetsAt":"2026-10-27T04:37:33Z"},
  "weekly": {"status":"ok","percent":23,"resetsAt":"2026-11-02T00:00:00Z"},
  "monthly":{"status":"ok","percent":25,"resetsAt":"2026-11-22T03:26:20Z"}}}
```

- **三个窗口**：5 小时 / 本周 / 本月。端点没有「日」窗口，所以 pill 用 `5H · W · M`，不用 `D`。
- **重置语义**：`rolling` 是 5 小时滚动窗；`weekly` 每周一 00:00 UTC；`monthly` 是订阅周年日，**不是自然月 1 号**。倒计时按 `resetsAt` 渲染，不做任何自然月假设。
- **无模型细分**：返回的是订阅级数字，不区分模型（`?model=` 之类的参数会被忽略）。所以弹层写明「订阅级用量，不区分模型」。
- **Key 不出进程**：API Key 只在 Host 进程里使用，浏览器只拿到百分比；快照路由 `/api/dsh-model-usage` 仅接受本机回环请求。

## 安装

### 推荐：让 agent 安装

把下面这段交给任意能执行命令的 agent（DSH、Claude Code 等），它会完成克隆、安装、重启核对：

```
安装 dsh-model-usage 插件：
1. git clone https://github.com/kabarryo/dsh-model-usage.git（已有目录则 git pull）
2. 用 dsh 的 plugin_manager install_bundle，target 指向上一步的目录绝对路径
3. 如果当前 profile 不是我正在用的那个（web / desktop），改用对应 profile 重装
4. 确认 curl http://127.0.0.1:<当前 GUI 端口>/api/dsh-model-usage?provider=opencode-go 返回 200 与 usage 数字
5. 刷新页面，确认输入框下方出现 5H/W/M 三个百分比
```

比手动安装省事的地方：agent 能自己判断该装 Web 还是桌面版 profile、核对端口、看返回码、刷新后再验收。手动安装最容易漏的是 profile 归属和刷新这两步。

### 手动安装

要求：DSH 0.2.x（Web 或桌面版 profile 均可），Node 20+，`OPENCODE_GO_API_KEY` 已配好（与模型调用用的是同一把）。

在 DSH 会话里让 agent 执行：

```
plugin_manager install_bundle target=/绝对路径/dsh-model-usage
```

或者直接改 profile（等价于 `install_bundle` 做的事）：

1. `~/.dsh/profiles/<profile>/package.json`：`dependencies` 加 `"dsh-model-usage": "link:/绝对路径/dsh-model-usage"`，`dsh.profile.bundles` 追加 `"dsh-model-usage"`。
2. 在该目录跑 `pnpm install`。
3. 重启对应的 DSH；客户端半需要刷新一次页面。

## 配置

`cordis.patch.yml` 里的 `meters` 决定「哪条路由用哪把 key 查哪个端点」。一个 meter = 一个订阅 = 一把 key：

```yaml
- insert:
    - id: dsh-model-usage
      name: dsh-model-usage
      config:
        refreshSeconds: 60
        meters:
          - id: opencode-go
            label: opencode-go
            providers: [opencode-go]          # 路由名，见 profile 的 llm-pi-ai 配置
            baseURL: https://opencode.ai/zen/go/v1
            keyRef: OPENCODE_GO_API_KEY      # provider 配置里 apiKeyEnv 的变量名
```

- 换 key 只需改 `keyRef`；加一个订阅就加一行 meter。
- meter 是懒加载的：只有当前会话所在的 `provider` 命中时才会去查，未命中的 meter 不会产生请求。
- 切到另一条路由的模型时，插件自动换用那条路由的 key 重新取数，不需要重启。
- 未配置的 key 只会在切到该路由时显示「未配置凭据」，不影响其它订阅。

## 刷新时机

- 页面可见时每 3 秒轮询本机快照路由。
- Host 侧缓存 TTL 60 秒；每轮 `assistant/message` 落盘后把对应 meter 标脏，下一次轮询即回源。
- 切换模型后，轮询里带的 `provider` 变了，立刻改用新 meter。
- 有旧数据时先返回旧值、后台刷新，不做阻塞等待。

## 自动更新

Host 半每 6 小时（可配置）查一次 GitHub Releases，结果缓存在 `$DSH_HOME/model-usage/update-check.json`，重启不会立刻重查，也不会频繁打 GitHub API。发现新版时：

- pill 展开面板底部出现「新版本 vX 已发布 · 更新」；
- 插件管理页对应的徽标与区块出现同样的提示和按钮。

点「更新」执行 `git pull --ff-only`，要求插件目录是 git 工作区（按上面的 git clone 方式安装即可满足）。完成后区分两种情况：

- 变更只涉及客户端文件（`client.js`、`locale/`、`icon.svg`）→ 面板提示「刷新页面」，点一下就生效；
- 变更涉及 Host 文件（`index.js`、`usage.js`、`package.json`、`cordis.patch.yml`）→ 提示「重启 DSH 后生效」。

失败会给出具体原因（不是 git 仓库、拉取冲突、网络不通），不静默吞掉。

```yaml
config:
  repo: kabarryo/dsh-model-usage   # 被查询的仓库，默认为此
  checkIntervalHours: 6            # 检查间隔，默认 6 小时
```

## 已知限制

- 只统计订阅端点报告的数量，与 Console 页面同源；端点未公开文档，形状变了会降级为「暂不可用」而不是显示错数。
- 不区分模型，只有订阅级百分比。
- 非 opencode-go 订阅不显示 pill。
- 依赖 `resetsAt` 做倒计时；该字段缺失时只显示百分比。
- 自动更新只对 git 工作区有效；用压缩包或 npm 安装的目录只会提示手动更新。
- 更新不会自动重启进程：Host 侧改动需要退出并重开 DSH。

## 卸载

```
plugin_manager remove_bundle target=dsh-model-usage
```

手工卸载：从 profile 的 `dsh.profile.bundles` 与 `dependencies` 移除该项，`pnpm install`，重启。

## 开发

纯 JS，无构建步骤：Host 半 `index.js`（路由 + 缓存 + 凭据解析），纯函数在 `usage.js`，客户端半 `client.js`（`window.__ModuleLoader__.load` 注册到 `conversation.composer.dock`）。

```bash
npm test                             # 解析 / meter 路由 / URL 拼接 / 五档阈值，14 项
npm run check:wiring                 # 模块装载与槽位注册
node scripts/smoke.mjs               # 真实端点全链路（读本机凭据，不打印、不上传）
```

## License

MIT
