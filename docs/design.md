
我希望复刻一个 [modelwatch.dev](https://modelwatch.dev/) 这样的日刊系统。

背后是一套打磨过的 workflow，基于 ai。每天跑下 npm run generate，然后等着 ai 从 200+ 到 500 条 twitter 中整理出 30+ 资讯，我人工选 6-10 条，然后按回车发布。

说下怎么实现的。

1）收集来源。当前包括一个 twitter list，再加上我 Substack 账号 follow 的 publications；后面有需要再增补新的列表或 Blog RSS 地址

 [https://x.com/i/lists/1602502639287435265](https://x.com/i/lists/1602502639287435265)

2）收集资讯。Twitter 优先通过 `twitter-cli` 收集 list，这样可以直接保留更完整的媒体信息（尤其是图片 URL / 尺寸），失败时再回退到 [twitterapi.io](http://twitterapi.io/)。Substack 则通过登录态列出已订阅 publications，再抓取每个 publication 的最新文章。两边都做来源级增量采集，避免重复吃旧内容。

3）ai 筛选和整理。Twitter 内容直接进主 prompt；Substack 文章正文不要粗暴截断，而是先交给一个额外的快模型完整阅读并压缩成结构化 briefing，再把 briefing、标题、副标题、来源信息和媒体元数据一起交给主整理模型。这样上下文成本可控，同时不会因为截断丢掉文章后半段关键信息。主整理输出不是短平快摘要，而是带编辑判断的深度 briefing：每条应尽量交代事实触发点、关键证据、背后的结构性信号，以及仍未证实或存在边界的部分。

4）格式化。整理一份 markdown 标记自动备份到我的 Obsidian 仓库中，然后整理一份用来发substack.com需要的格式。Twitter 与 Substack 都走同一套条目格式；v1 只渲染图片，不处理视频 / GIF 嵌入，Substack 来源只取 cover image。

5）发布。我还没发过 substack ，如果有能自动发 substack 的工具/脚本/cli 最好，如果是没有太推荐的方案，就请你最好在 README 中写一下如何把你整理出来的新文档发布到 substack 的步骤，我手工发布也没问题。输入来源缺失配置时应直接失败，不要默默只跑部分来源。
