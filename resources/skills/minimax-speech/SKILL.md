# MiniMax 角色样音

在模型配置的「声音生成」中设置 MiniMax Speech 地址、语音模型和 API Key。角色的样音跟随角色卡，每套服饰使用同一份声音。

- 用 `read_project` 的 `cards` 查看角色及现有的 `voiceAssetId`。已有合适样音时继续使用。可将素材库中已确认合适的 WAV 或 MP3 用 `edit_project` 绑定到角色卡。
- 用 `run_command` 生成，填写 `skill: "minimax-speech"` 和 `cardId`。设计新声音时，用 `prompt` 描述语言、年龄感、音域、音色与日常说话方式。复用已有 MiniMax 音色时可传 `voiceId`。接口返回的试听会登记为角色样音。
- `sampleText` 是可选的独立试听台词，建议用一到两句约 4–5 秒的自然对白。目标是一段无配乐、无其他说话人的干声。样音应为 2–15 秒，多人同镜送入模型的样音总时长最多 15 秒。
- 例：`{"commands":[{"skill":"minimax-speech","cardId":"lin","prompt":"年轻男声，普通话，音域偏低，日常讲话自然沉稳","sampleText":"你先坐一会儿吧。等雨小一些，我们再一起出门。"}]}`
