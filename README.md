# DSH WorkBuddy AI Connect

把 **WorkBuddy AI 国际版**（[www.workbuddy.ai](https://www.workbuddy.ai)）接到 DeepSeek Harness。

- **登录**：官网浏览器 OAuth，不必装桌面 App
- **默认模型**：只列出产品配置里 `credits: x0.00` 的免费模型
- **Provider**：`workbuddyai`（和国内版插件 `workbuddy` 可以并存）

## 快速开始

1. Node 22+，已安装 DSH。
2. 安装插件并启动：

```sh
dsh plugin --profile web add github:iceloon/dsh-workbuddyai-connect
dsh web
```

3. 打开 **设置 → 插件 → DSH WorkBuddy AI Connect**，点 **连接**，在弹出的 WorkBuddy AI 网站里登录。
4. 模型选择器里选 **WorkBuddy AI / Deepseek-V4.1-Flash**。

也可以在终端登录：

```sh
dsh plugin --profile web exec dsh-workbuddyai-connect login
```

安装、更新或登录后必须**重启 `dsh web`**。刷新浏览器不够，Node 模块常驻内存。

默认模型可以写在 `~/.dsh/settings.yaml`：

```yaml
agent-default-model:
  provider: workbuddyai
  model: deepseek-v4.1-flash
  reasoningEffort: max
```

## 登录怎么工作

插件走官方 CLI 登录接口，不经过桌面 App：

1. `POST /v2/plugin/auth/state?platform=CLI&nonce=`
2. 打开返回的 `authUrl`
3. 轮询 `GET /v2/plugin/auth/token?state=`（还在等时上游返回 `11217`）
4. 把 token 写到 **`$DSH_HOME/.workbuddyai-auth.json`**（一般是 `~/.dsh/.workbuddyai-auth.json`）

桌面 App 的 `workbuddy-desktop-ai.info` **只读、不写**。本机已经登录过桌面 App 时，插件会把它当后备凭据；两边都有时用过期更晚的那份。

设置卡片未登录时也可以点连接。登录 `state` 只存在当前 DSH 进程内存里，15 分钟未完成会超时。

**断开** / `logout` 只删插件自己的凭据文件，不影响桌面 App。

## 免费模型

国际版目录接口（`/v2/enterprises/personal/models`）会漏掉部分模型，而且目录里的 `credits` 不一定准。插件以应用下发的产品配置为准：

`~/.workbuddy-ai/cache/acc-product-config-v3.json`

读不到这份缓存时，用插件内置的免费名单。当前免费（`x0.00`）模型：

| 模型 | 上下文 | 图像 | 推理档 |
|---|---|---|---|
| `deepseek-v4.1-flash` | 1M | 是 | 默认 high；实测接受 low / medium / high / xhigh / max |
| `hy4-preview-f` | 1M | 是 | 声明 high |
| `hy3` | 192k | 是 | 声明 low / high |

目录不返回 `deepseek-v4.1-flash` 和 `hy4-preview-f`，插件会按产品配置补进列表。

`hy4-preview`（不带 `-f`）在目录里可能显示 `x0.00`，产品配置里是 `x0.29`。按产品配置从严，避免误当免费而扣费。

设置卡片可以把范围改成 **全部模型**。付费模型名称后会显示倍率，选用会真实扣积分。

## 和国内版插件的差别

| | `dsh-workbuddy-connect` | `dsh-workbuddyai-connect` |
|---|---|---|
| 登录 | 复用国内桌面 App | 浏览器 OAuth；国际版桌面 App 可选 |
| 凭据 | `workbuddy-desktop.info` | `$DSH_HOME/.workbuddyai-auth.json` |
| 目录接口 | `/console/enterprises/personal/models` | `/v2/enterprises/personal/models` |
| 免费判定 | 目录接口的 `credits` | 产品配置 `x0.00` |
| 默认列表 | 全部 cli 模型 | 仅免费模型（可放开） |
| Provider | `workbuddy` | `workbuddyai` |

两者可以同时安装。不再需要国内版时：

```sh
dsh plugin --profile web remove dsh-workbuddy-connect
```

## 配置

设置 → 插件 → **DSH WorkBuddy AI Connect**：

- **连接 / 断开**：浏览器登录，或删掉插件凭据
- **仅免费模型**（默认）/ **全部模型**
- 账号、剩余积分、模型倍率和上下文

也可以在 profile 的 `cordis.patch.yml` 里写：

```yaml
- id: llm-workbuddyai
  config:
    modelScope: free          # 或 all
    probeConsent: false
    # 局域网打开 DSH Web 时写访问用的 Host（不要写进 LOOPBACK）
    # allowedHosts: ["192.168.1.10"]
    # authFile: 一般不用。只在桌面凭据不在默认位置时才写绝对路径
```

环境变量：

| 变量 | 作用 |
|---|---|
| `WORKBUDDYAI_AUTH_FILE` | 覆盖桌面凭据路径（OAuth 凭据仍写插件自己的文件） |
| `WORKBUDDYAI_PRODUCT_CONFIG` | 覆盖产品配置 JSON 路径 |

## 命令行

```sh
dsh plugin --profile web exec dsh-workbuddyai-connect login
dsh plugin --profile web exec dsh-workbuddyai-connect status
dsh plugin --profile web exec dsh-workbuddyai-connect doctor
dsh plugin --profile web exec dsh-workbuddyai-connect logout
```

`status` / `doctor` 可加 `--json`。`logout` 只删 `$DSH_HOME/.workbuddyai-auth.json`。

## 故障排查

| 现象 | 处理 |
|---|---|
| 设置里没有这张卡片 / 模型列表没有 WorkBuddy AI | 重启 `dsh web`，不要只刷新浏览器 |
| 点连接后 `dsh web` 进程退出 | 无头 Linux 没有 `xdg-open` 时请更新到含 spawn `error` 处理的版本；用卡片上的登录链接 |
| 局域网 IP 打开卡片 403 `request-not-trusted` | 在 `allowedHosts` 里写该 IP/主机名，不要把它加进回环名单 |
| 登录成功但没有免费模型 | 看 `doctor` 是否读到产品配置；没有缓存时用内置三模型名单 |
| `doctor` 显示 signed-out | 先 `login`，或确认国际版桌面 App 已登录 |
| 想用付费模型 | 设置卡片把范围改成「全部模型」，注意会扣积分 |

```sh
dsh plugin --profile web exec dsh-workbuddyai-connect doctor
```

## 已知限制

- 在 macOS 的 DSH Web 下验证。无头 Linux 上「连接」不会再因缺少 `xdg-open` 把进程打崩。Windows / WSL 探测了凭据路径，未实测。
- 依赖 WorkBuddy 客户端接口（非官方开放 API），上游更新后插件可能要跟着改。
- 只接国际版。国内版请用 `dsh-workbuddy-connect`。

## 免责声明

仅供个人学习和研究，只驱动你自己的 WorkBuddy 账号在本机调用。请遵守 WorkBuddy 服务条款。本项目与腾讯、WorkBuddy、DeepSeek 均无关联。

架构参考 [corrinehu/dsh-workbuddy-connect](https://github.com/corrinehu/dsh-workbuddy-connect)（MIT）。

## 许可证

[MIT](./LICENSE)
