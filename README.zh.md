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

- 搜索 skills.sh，每条结果给出 **GitHub** 和 **skills.sh** 两个入口，安装前由你自己去查看。
  面板本身**不下载任何内容**：未经你确认的技能，一个字节都不会落到本机。
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

1. 从 `codeload.github.com/<repo>/tar.gz/<ref>` 拉取压缩包，先试 `HEAD`（因此
   **不需要 git**），失败再试 `main`、`master`
2. `tar` 解压到系统临时目录下的短期缓存
3. 在解压树里定位"名字等于技能 id、且确实含有 SKILL.md"的目录
4. 用 `fs.cp` **整个**拷贝出来 —— 逐字节复制，脚本、图片等二进制资源同样完整保留

**只有"安装"和"检查更新"会走这条管线**，两者都是你点名的动作。搜索结果本身不发任何
请求去取技能内容——这正是为了不让你还没决定，磁盘上就多了一份陌生人的仓库。

这条管线只依赖 `codeload.github.com`，不依赖 `raw.githubusercontent.com`。
在那些 codeload 通、raw 不通的网络环境下，这一点是决定性的。

每个已安装技能会记录在其技能根目录的 `.skills-panel.json` 里，包含仓库、分支、仓库内路径
和内容哈希。这个清单是更新检查和干净卸载的依据；删掉它技能仍会显示，但不再提供更新。

---

## 平台说明

- **Windows、macOS、Linux 同一套代码。** 没有 shell 脚本、没有 PowerShell：整条流水线
  都是 Node —— `fetch`、`fs.cp`、`fs.symlink`、`fs.rm` —— 三平台行为一致。Windows 的
  junction 和 POSIX 的符号链接都由 `fs.symlink` 创建，两者都不需要提权。
- **唯一的外部工具是 `tar`。** macOS、Linux 自带，Windows 10 (1803) 及以后也自带。
  不需要 `git`，不需要 `curl`，也不需要 PowerShell。
- 更新检查**只比对 SKILL.md 内容**。如果上游只改了附带文件，面板会显示"已是最新"。
  这是为了让检查保持廉价而有意做的取舍。

---

## 许可

MIT，见 [LICENSE](LICENSE)。
