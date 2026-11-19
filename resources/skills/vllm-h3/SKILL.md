# 自定义 MiniMax H3（vLLM-Omni）

在模型配置的「视频生成」选择「自定义 MiniMax H3（vLLM-Omni）」，填写运行 H3 的服务地址和部署时的模型名。API Key 对应部署时的 `--api-key`，无鉴权的本机实例可留空。推理默认 10 步，可根据实际部署修改。

使用 `read_project` 的 `shot_assets` 核对分镜，再用 `run_command` 传入 `skill: "vllm-h3"` 和 `shotId`。选择 4–15 秒的时长。带角色样音时，服务端需加载 Ref2VA，且同镜至少有一张参考图。只有一张分镜底图且无样音时使用 FL2VA 首帧。纯文本使用 T2VA。对白和素材按本镜自动组装。

请求使用 vLLM-Omni 的 `/v1/videos` multipart 接口。样音按实际上传顺序引用，生成结果通过同一服务的任务查询和内容接口下载。
