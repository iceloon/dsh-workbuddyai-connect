# DSH WorkBuddy AI Connect

将 **WorkBuddy AI 桌面 App（国际版，www.workbuddy.ai）** 的模型接入 DeepSeek Harness。默认只列出产品配置里标价 `x0.00` 的免费模型，不需要打补丁。

相对 `dsh-workbuddy-connect`（国内版）的差别：

| | `dsh-workbuddy-connect` | `dsh-workbuddyai-connect` |
|---|---|---|
| 凭据文件 | `workbuddy-desktop.info` | `workbuddy-desktop-ai.info` |
| 目录接口 | `/console/enterprises/personal/models`（国内） | `/v2/enterprises/personal/models`（国际） |
| 免费判定 | 信任目录接口的 `credits` | 以 `~/.workbuddy-ai/cache/acc-product-config-v3.json` 为准 |
| 默认模型列表 | 目录里的全部 cli 模型 | 仅 `x0.00` 免费模型（可在设置里放开） |
| Provider | `workbuddy` | `workbuddyai` |

国际版目录接口不返回 `deepseek-v4.1-flash` 和 `hy4-preview-f`，插件会按产品配置把它们补进列表。`hy4-preview`（不带 `-f`）在目录里显示免费、产品配置里是 `x0.29`，按产品配置从严，避免误当免费而扣费。

## 免费模型

当前产品配置里 `credits: x0.00` 的 cli 模型：

- `deepseek-v4.1-flash` — 1M 上下文，图像，默认 high 推理档（实测接受 low / medium / high / xhigh / max）
- `hy4-preview-f` — 1M 上下文，图像，声明档位 high
- `hy3` — 192k 上下文，图像，声明档位 low / high

## 安装

前置：已安装并登录 **WorkBuddy AI 国际版** 桌面 App（插件复用它的登录状态）。

```sh
# 从 GitHub 安装到 web profile
dsh plugin --profile web add github:iceloon/dsh-workbuddyai-connect
dsh web
```

安装后在模型选择器里选 **WorkBuddy AI / Deepseek-V4.1-Flash**。默认模型可以写成：

```yaml
agent-default-model:
  provider: workbuddyai
  model: deepseek-v4.1-flash
  reasoningEffort: max
```

可以和 `dsh-workbuddy-connect` 并存（provider 不同）。若不再需要国内版插件：

```sh
dsh plugin --profile web remove dsh-workbuddy-connect
```

补丁改的是运行中的 Node 模块，安装或更新本插件后必须重启 `dsh web`，刷新浏览器不够。

## 配置

设置 → 插件 → **DSH WorkBuddy AI Connect**：

- **仅免费模型**（默认）：只列出产品配置 `x0.00` 的模型
- **全部模型**：同时列出付费模型，名称后会显示倍率；选用会真实扣费

也可在 profile 的 `cordis.patch.yml` 里写：

```yaml
- id: llm-workbuddyai
  config:
    authFile: "/absolute/path/to/workbuddy-desktop-ai.info"
    modelScope: free          # 或 all
    probeConsent: false
```

`authFile` 一般不用写：插件会按平台默认去找 `workbuddy-desktop-ai.info`。也可用环境变量 `WORKBUDDYAI_AUTH_FILE`。

## 命令行

```sh
dsh plugin --profile web exec dsh-workbuddyai-connect status
dsh plugin --profile web exec dsh-workbuddyai-connect doctor
dsh plugin --profile web exec dsh-workbuddyai-connect logout
```

## 已知限制

- 在 macOS 的 DSH Web 下验证。凭据路径对 Windows / WSL 做了探测，未在那些平台实测。
- 依赖 WorkBuddy 客户端接口（非官方开放 API），上游更新后插件可能需要随之调整。
- 仅支持已登录国际版账号。国内版请继续用 `dsh-workbuddy-connect`。

## 免责声明

本项目仅供个人学习和研究使用，仅驱动使用者自己的 WorkBuddy 账号在本机调用。请遵守 WorkBuddy 服务条款。本项目与腾讯、WorkBuddy、DeepSeek 均无关联。

架构参考了 [corrinehu/dsh-workbuddy-connect](https://github.com/corrinehu/dsh-workbuddy-connect)（MIT）。

## 许可证

[MIT](./LICENSE)
