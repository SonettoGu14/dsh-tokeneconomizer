# 插件市场条目（awesome-dsh-plugin）

DSH 的市场卡片来自 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)
的 `data/plugins/*.yml`，一个文件一条收录。本目录是三条**待提交**的条目，内容与本仓库
当前实现一致，直接复制过去即可。

## 为什么是三条，而不是一条 `dsh-te`

那个目录的收录规则第 7 条写得很明确：**收插件，不收聚合包**。`dsh-te` 的
`package.json` 只有一份依赖清单加一个 `cordis.patch.yml`，自己不带任何行为，属于
"纯聚合包"，不单独占一行；而 `cost` / `facts` / `prune` 三个子包各自可独立安装、
各自带行为，正是它允许的那种 monorepo 多条目形态（每个 PR 最多三条，就是为这种情形留的）。

所以三条卡片是合规形态。让它们读起来像同一个产品的办法只有两条：描述里说清套件关系
（下面三个文件已经这么写），以及每个子包自己的截图。

## 提交步骤

1. fork `awesome-dsh-plugin/awesome-dsh-plugin`；
2. 把本目录三个 `SonettoGu14__dsh-tokeneconomizer--*.yml` 放进 `data/plugins/`；
3. PR 标题：`Update the dsh-te entries: suite framing and screenshots`；
4. PR 描述里说明：三个条目是同一个套件的组件，`dsh-te` 是纯聚合包按要求不收录；
   截图已随仓库提供（`packages/*/screenshots.json`），本次只改描述文案。

## 截图

`packages/{cost,facts,prune}/screenshots.json` 各自声明 `assets/screenshot-1.png`，
路径相对于该文件，符合那个目录要求的"放在你自己的仓库里"。图片渲染自三条命令的
**真实输出**（用的是本仓库构建产物 + 一份 fixture 仓库状态，不含任何本机路径或私有数据）。
夜里那次构建会自动抓取，不需要为换图再提 PR。
