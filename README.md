# 提示词优化（Prompt Optimizer）

把随手写下的基础提示词一键重写成结构清晰、模型更好执行的高质量提示词。Hana v2 应用。

## 功能

- 六种场景预设：通用 / 编程 / 写作 / 图像 / 分析 / Agent，每种带各自的侧重项
- 卡片界面：写输入、切场景、补硬性要求，输出与原文长度对照，一键复制
- 模型工具 `optimize_prompt`：Agent 在对话里可以说「帮我优化这段提示词」直接调用
- 检查更新：比对指定 GitHub 仓库的 Release，有新版给更新日志与下载入口
- 设置页：发布仓库地址、版本号、GitHub 与更新入口

## 用法

卡片：把画布上的「提示词优化」放到需要的位置，直接写、直接点「优化」。`Ctrl + Enter` 是快捷键。

对话：让 Agent 调用工具，或直接说「帮我把这句话改成能喂给模型的提示词」。

设置：`设置 → 提示词优化`，改发布仓库（格式 `owner/repo`）或手动检查更新。

## 结构

```
manifest.json     应用清单（cards / settings / capabilities）
index.js          入口：路由 + 模型工具
lib/prompt.js     场景与系统提示词（纯逻辑）
lib/update-check.js  Release 版本比对
ui/               卡片页、设置页与静态资源
sdk/              打包随附的 App SDK（不依赖宿主 node_modules）
```

后端接口一律走 `/api/apps/prompt-optimizer/routes/`：

| 路径 | 说明 |
|------|------|
| `POST /optimize` | 一次改写，返回 `{ ok, optimized, originalLength, optimizedLength }` |
| `GET /meta` | 当前版本与发布仓库 |
| `GET/POST /config` | 读写应用配置 |
| `GET /update-check` | 与 GitHub Release 比对版本 |

## 兼容性

| 项目 | 值 |
|------|-----|
| 宿主 | Hana ≥ 0.1013.0 |
| 声明能力 | `app/tools.expose-to-model`、`app/models.infer`、`app/ui.clipboard-write`、`app/ui.open-external` |
| 网络 | 仅 `api.github.com`（GET），用于检查更新 |
| 实测日期 | 2026-09-22 |

## 依赖

- 宿主已配置可用的 utility 模型（对应 `app/models.infer`），否则改写会明确报错
- 检查更新需要能访问 `api.github.com`

## 已知限制

- 模型调用只走宿主 utility 配置，不能指定 provider / model / 密钥
- 应用不能自我更新：v2 应用安装目录宿主只读，安装与升级走「设置 → 扩展」
- 卡片不携带会话上下文，不跟随当前会话

## 许可

MIT
