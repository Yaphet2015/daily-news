
我希望复刻一个 [modelwatch.dev](https://modelwatch.dev/) 这样的日刊系统。

背后是一套打磨过的 workflow，基于 ai。每天跑下 npm run generate，然后等着 ai 从 200+ 到 500 条 twitter 中整理出 30+ 资讯，我人工选 6-10 条，然后按回车发布。

说下怎么实现的。

1）收集 twitter list 。目前只有这条，后面有需要再增补新的列表或 Blog RSS 地址

 [https://x.com/i/lists/1602502639287435265](https://x.com/i/lists/1602502639287435265)

2）收集资讯。通过 [twitterapi.io](http://twitterapi.io/) 收集 twitter list 的增量信息，用 api 的方式，这个服务还挺稳的，而且不贵，推荐。设上限 500 条，太多了没必要而且会触及 ai 的 context limit。

3）ai 筛选和整理。组织了下 prompt，然后让 ai 按我的风格和喜好整理资讯。这里最好能利用上我的 codex 订阅，走 codex 提供的 chatGPT 模型来实现。如果不行或者不稳定，可以使用 ai-sdk 走独立的 provider，我有订阅按量付费的 API 聚合商。如果采用后者，baseURL 和 api key 先留空占位即可

4）格式化。整理一份 markdown 标记自动备份到我的 Obsidian 仓库中，然后整理一份用来发substack.com需要的格式

5）发布。我还没发过 substack ，如果有能自动发 substack 的工具/脚本/cli 最好，如果是没有太推荐的方案，就请你最好在 README 中写一下如何把你整理出来的新文档发布到 substack 的步骤，我手工发布也没问题