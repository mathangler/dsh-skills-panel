# dsh-skills-panel

[English](README.md) | 中文

给 DeepSeek Harness 设置面板加一个**技能**页：查看 DSH 能加载的全部技能（全局与按项目）、
从 [skills.sh](https://skills.sh) 搜索并安装、逐个控制是否自动注入模型 context、
以及在已安装技能上游有变化时收到提示。

> **非官方。** 这是第三方插件，与 DeepSeek 无隶属或背书关系，只使用 DSH 公开的插件接口。

---

## 功能

**已安装**

- 按作用域列出实际生效的技能，标注来源（`user-dsh`、`project-dsh`、预设、agent 预设……），
  并在项目技能覆盖同名全局技能时给出提示。
- 每个技能一个开关：**开**表示留在模型可见的技能目录里；**关**会在该技能的
  frontmatter 写入 `disable-model-invocation: true`，于是它退出目录、但仍可用 `/名称`
  手动调用。这是 DSH 自带的机制，不是本插件私定的约定。
- 指向其他工具的 junction、或不属于 DSH 的技能显示为只读——本面板不会去改和别人共用的文件。
- **查看**就地展开该技能的 SKILL.md。
- **移除**会删除技能目录；若技能是 junction 则只删链接本身
  （普通 `rmdir` 无法穿过 junction 去动目标）。
- **检查全部更新**逐个比对"本面板安装"的技能与仓库，把有变化的标记出来。

**搜索安装**

- 搜索 skills.sh，显示上游描述，并在安装前预览 SKILL.md 与确切的安装位置。
- 本地已有的结果显示 **已安装** 标记，按钮变为 **重新安装**。
- 可安装到全局技能目录，或当前项目的 `.dsh/skills`。

**导入**

- 把磁盘上已有的技能目录导入，方式为 **链接**（junction，原目录仍是唯一来源）或 **复制**。
- 导入的技能刻意不参与更新检查——它们没有可比对的上游。

**更新**

- 每次打开页面后在后台检查一次全部"本面板安装"的技能。有变化的会得到一个小圆点和一个
  标签，tab 标题上出现计数。
- **更新**按钮会先比对，确认没有变化就不做任何改动。

---

## 安装

需要带 `web` profile 的 DSH，且 `pnpm` 在 `PATH` 上。

```sh
dsh plugin --profile web add github:mathangler/dsh-skills-panel
```

然后重启 Web 应用：

```sh
dsh web
```

`dsh plugin` 会在 `~/.dsh/profiles/web` 里执行 pnpm，并在之后自动把这个包追加到
`dsh.profile.bundles`（因为它声明了 `dsh.bundle`）。**不需要手工编辑任何 YAML。**

打开 **设置 → 技能**。

### 更新

```sh
dsh plugin --profile web update dsh-skills-panel
```

### 卸载

```sh
dsh plugin --profile web remove dsh-skills-panel
```

---

## 安装技能时发生了什么

安装**不走** GitHub REST API，因此不需要 token，也不受匿名每小时 60 次的限制：

1. `git ls-remote --symref` 解析仓库默认分支（失败则退回 `main`、`master`）
2. `curl` 下载 `codeload.github.com/<repo>/tar.gz/<branch>`
3. `tar` 解压到 profile 目录下的短期缓存
4. 在解压树里定位"名字等于技能 id、且确实含有 SKILL.md"的目录，**整个**拷贝出来
   —— 包含子目录、脚本和资源文件

描述、详情预览和更新检查都从这个解压树读取，因此完全不依赖
`raw.githubusercontent.com`。在那些 codeload 通、raw 不通的网络环境下，这一点是决定性的。

每个已安装技能会记录在其技能根目录的 `.skills-panel.json` 里，包含仓库、分支、仓库内路径
和内容哈希。这个清单是更新检查和干净卸载的依据；删掉它技能仍会显示，但不再提供更新。

---

## 平台说明

- **面向 Windows。** 安装/卸载的驱动脚本使用 PowerShell、`curl.exe` 和 `tar.exe`。
  macOS 与 Linux 未经验证。
- "导入为复制"路径遇到已知二进制扩展名会跳过并报告；仓库安装路径不受此限，
  因为它用 `Copy-Item` 而不是只能写文本的 fs 服务。
- 更新检查**只比对 SKILL.md 内容**。如果上游只改了附带文件，面板会显示"已是最新"。
  这是为了让检查保持廉价而有意做的取舍。

---

## 许可

MIT，见 [LICENSE](LICENSE)。
