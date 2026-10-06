# 贡献到 DSH 社区 · 提交清单

本项目已满足社区收录的硬性前提：`package.json` 声明 `dsh.bundle`（`dsh plugin add` 可安装的前提）、仓库根含 `cordis.patch.yml`（`insert` 行含 `id`/`name`）、MIT License、真实功能代码 + 163 项自动化测试、描述与代码一致。

## 第一步：发布到 GitHub（一切的前提）

```bash
# 在 GitHub 创建空仓库 weixshaw/dsh-rss（不要初始化 README），然后：
git remote add origin https://github.com/weixshaw/dsh-rss.git
git push -u origin main
```

**必做：给仓库加 topic `dsh-plugin`**（仓库页 About 齿轮 → Topics）。
dsh-plugin-radar 每日 02:00 全量扫描带该 topic 的仓库**自动收录**——即使不主动投稿，这也是被发现的途径。

## 第二步（推荐）：awesome-dsh-plugin 清单 PR

指南：https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md

1. Fork awesome-dsh-plugin，新建分支；
2. 把本目录 `awesome-dsh-plugin.yml` 的内容保存为 `data/plugins/weixshaw__dsh-rss.yml`（这一个文件就是全部投稿，README 由脚本自动生成，**不要手编**）；
3. 开 PR（一个 PR 只投这一个条目）；
4. CI 依次检查：条目数 ≤ 3 → `dsh.bundle` 存在 → 仓库年龄 ≥ 1 天 → lint/站点构建；
5. 维护者人工核对**描述与代码一致**（功能、数字、API 名都算声明）、分类合理（当前选 `tools`）、非空壳非聚合包。

检查失败在同一分支推送修复即可，无需重开 PR。

## 第三步（可选）：dshmarket 插件市场

- dshmarket 是市场应用本身，**不要向它 PR 插件条目**；
- 入口是市场内的 **「Submit your plugin」**（提交时会校验 manifest）；
- 当前市场仅收录 GitHub 条目——第一步完成后即可提交。

## 后续增强（提升收录与曝光，非必须）

- **截图**：在仓库根放 `screenshots.json`（1–8 张，路径相对该文件、不以 `/` 开头、不含 `..`；绝对 URL 必须是 GitHub 托管的 https，第三方图床会被拒）。实机截图后补充；
- **发 npm**：可免去 tarball/allowBuilds 授权环节。注意 `package.json` 目前是 `private: true`（防误发布），发 npm 前需移除；官方 `@deepseek-ai/*` 包保持 `peerDependencies` 且范围需显式 `||` 预发布分支；
- **版本发布**：打 tag（如 `v0.6.0`），描述性 Release Notes 便于市场展示。

## 打回红线（指南明确的高频原因）

- 描述夸大或与代码不符（数字、API 名都会被核对）；
- 只声明 `dsh.client` 而缺 `dsh.bundle`（无法安装，CI 直接拒）；
- 占位/空壳/抢名仓库；纯聚合包；依赖指向重传的他人插件副本；
- PR 改动了不相关条目。
