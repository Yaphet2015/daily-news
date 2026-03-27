
我希望复刻一个 [modelwatch.dev](https://modelwatch.dev/) 这样的日刊系统。

背后是一套打磨过的 workflow，基于 ai。每天跑下 npm run generate，然后等着 ai 从 200+ 到 500 条 twitter 中整理出 40-50 条资讯，我人工选 6-10 条，然后按回车发布。

说下怎么实现的。

1）收集来源。当前包括一个 twitter list，再加上我 Substack 账号 follow 的 publications；后面有需要再增补新的列表或 Blog RSS 地址

 [https://x.com/i/lists/1602502639287435265](https://x.com/i/lists/1602502639287435265)

2）收集资讯。Twitter 优先通过 `twitter-cli` 收集 list，这样可以直接保留更完整的媒体信息（尤其是图片 URL / 尺寸），失败时再回退到 [twitterapi.io](http://twitterapi.io/)。Substack 则通过登录态列出已订阅 publications，再抓取每个 publication 的最新文章。两边都做来源级增量采集，避免重复吃旧内容。Substack 的公开 RSS 抓取按 publication best-effort 处理：如果某个站点自己的 feed 因为坏重定向、TLS 握手或超时失败，该 publication 会被记录 warning 并跳过，不会拖垮整次采集；但像缺少 `SUBSTACK_PUBLICATION_URL` 这类本地配置错误仍然直接失败。Twitter 采集完成后还要多做一层 source 归一化：优先使用结构化外链字段；如果 `twitter-cli` 漏掉了正文里的 `t.co`，就再做一次短链解析；最终允许成为主 source 的链接只包括官方网站 / 个人博客等外部页面，以及 `x.com/i/article/...` 这种 X 长文 article。普通 X status 只能作为线索继续往下追，不算最终来源；视频页和直链媒体文件也不算来源。只有正文和 quoted 线索都没能落到合格来源时，才去看最近 1-3 条 replies 里的外链，并轻量读取候选页面。若 tweet 只是把官方页面或 X article 当宣发渠道做总结和介绍，后续流程一律把那个主 source 当最终引用目标，原 tweet 链接只保留作审计元数据；人工 `select` 阶段会同时显示原帖 URL 和最终来源 URL，方便肉眼核对。

3）ai 筛选和整理。Twitter 内容直接进主 prompt；但如果某条 tweet 已经被归一到官方 source，那么 prompt 里要同时给主模型看主 source URL、原始 tweet URL、页面标题/描述/excerpt 和 replies 上下文，让模型把 tweet 视为分发渠道而不是最终引用目标。Substack 文章正文不要粗暴截断，而是先交给一个额外的快模型完整阅读并压缩成结构化 briefing，再把 briefing、标题、副标题、来源信息和媒体元数据一起交给主整理模型。这样上下文成本可控，同时不会因为截断丢掉文章后半段关键信息。主整理前还有一层显式 ranking：程序先基于信息量、证据、来源信号、新鲜度、重复关系和 Twitter 时间加权互动速度做确定性打分，再只把高优先级候选池交给主模型，候选池稳定上限为 150。ranking 还支持一层仓库内维护的编辑偏好规则，用于对特定作者做可解释的强降权；当前默认对 `@tom_doerr` 降权，以减少高频 GitHub 项目转发内容挤占候选位。这样规则排序仍然负责去重、初筛和偏好约束，但主模型还能看到更宽的候选面，弥补打分规则不够全面的地方。重复关系除了文本 fingerprint，也要优先看 canonical source URL，避免同一官方页面被多条宣发 tweet 反复占位。主整理输出不是短平快摘要，而是带编辑判断的深度 briefing：每条应尽量交代事实触发点、关键证据、背后的结构性信号，以及仍未证实或存在边界的部分，并返回简短 `editorialReason` 解释它为什么值得进入本期。正常情况下会尽量整理出 40-50 条供人工复选；如果当天高质量信息不够，则宁可低于软下限也不回填低价值条目。最终条目固定落到 `Product`、`Tutorial`、`Opinions/Thoughts` 三类之一，替代原先的自由标签。每次运行还会额外产出 selection report，便于回看为什么某条内容被保留、降权或淘汰。

4）格式化。整理一份 markdown 标记自动备份到我的 Obsidian 仓库中，然后整理一份用来发substack.com需要的格式。Twitter 与 Substack 都走同一套条目格式；输出按三大类分组，不再展示条目标签；v1 只渲染图片，不处理视频 / GIF 嵌入，Substack 来源只取 cover image。对于被归一成官方 source 的 Twitter 条目，最终 `来源：` 应显示官方站点名并跳转官方链接，而不是继续指向 X。

5）发布。我还没发过 substack ，如果有能自动发 substack 的工具/脚本/cli 最好，如果是没有太推荐的方案，就请你最好在 README 中写一下如何把你整理出来的新文档发布到 substack 的步骤，我手工发布也没问题。输入来源缺失配置时应直接失败，不要默默只跑部分来源。
