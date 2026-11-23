---
name: minimax-video
description: Generate MiniMax H3 and Hailuo videos from the supplied local script and references.
compatibility: Portable to any agent that can read local files. The runtime script receives one JSON job on stdin.
---

# MiniMax H3 / 海螺视频制片

## 在工作室生成海螺镜头

1. 读取目标分集和分镜。用正式画面脚本描述一个镜头内可见的构图、主体位置、动作和运镜。确有对白或旁白才填本镜对白栏，保留原语言和字句。出场角色使用本镜的服饰引用，场景和道具使用实际设定卡。
2. 运行 `read_project` 的 `shot_assets` 预检。支持纯文本的型号可处理已确认无出场资产且无需首帧的镜头。海螺 2.3、2.3-Fast、02 及支持图像的 I2V 型号最多接收一张图，并将其作为首帧。首帧是视频开头的画面，不能拿五视图设定页当成想要的首帧构图。需要同时保留角色、场景或道具的多张图时，选支持本地多图的服务。不要丢弃任何已审核参考图来凑容量。
3. 读取本 Skill 和本文件末尾的 H3 Prompt Writing 规则后，按官方最终格式组装完整提示词，再通过 `run_command` 调用本 Skill，指定 `shotId`、`duration` 和 `finalPrompt`。例：`{"commands":[{"skill":"minimax-video","shotId":"shot-02","duration":6,"finalPrompt":"...官方 H3 最终提示词..."}]}`。已有分镜仍从已保存的画面、对白和引用图取素材。要求修改时先写回镜头，重新预检。工作室只校验 `finalPrompt` 并把它交给 `script/h3.py`，不会再调用第二个提示词整理模型。
4. H3 脚本也可以直接运行。将一个 JSON 任务写入 stdin，并设置 `STUDIO_API_URL`、`STUDIO_API_KEY` 和 `STUDIO_MODEL`，例如 `python script/h3.py < job.json`。任务至少包含 `prompt`、`inputMode`、`duration`、`ratio`、`references`、`audioReferences` 和 `output`。`references` 的每项包含 `path` 和 `type`，`audioReferences` 的每项包含 `path`。脚本将模型、提示词和时长提交到 `/video_generation`，图生视频另附 `first_frame_image`。首帧以 PNG、JPEG 或 WebP 的 data URL 传输，文件小于 20 MiB。显式关闭 `prompt_optimizer`，避免服务端扩写对白或剧情。凭据来自本次进程的环境，禁止写进脚本或对话。
5. 拿到任务编号后只轮询该任务，成功后下载文件并绑定分镜。HTTP 错误、失败终态或超时先检查原任务状态。核对实片的角色服饰、画面、口型和台词，再继续剪辑。

## 生成 MiniMax H3 镜头

在模型配置的 MiniMax 视频项填入 `MiniMax-H3`、`MiniMax-H3-Highspeed`、`MiniMax-H3-Lite` 或 `MiniMax-H3-Max` 及该服务的凭据。沿用 API 基础地址，应用使用 `/v2/video_generation` 提交，随后查询 `/v2/query/video_generation/{task_id}`。工作室默认输出 768P。H3 Max 可选 5–15 秒，其他三款可选 4–15 秒。最多上传九张本地参考图，图片的宽高和长宽比需在官方模式限制内。请求超过体积上限需先缩小图片文件。

- 无图时用 T2VA 文生音画。只有分镜首帧时用 I2VA，首帧构图按输入图锁定。
- 有角色服饰、场景或道具时用 Ref2VA，上传源图和参考编号顺序一致。若同时提供了分镜构图图，它作为参考图编号参与全参考模式。V2 的首尾帧与全参考是互斥输入模式。
- 已保存的对白和说话人由工作室在语言模型整理完成后填入。场景、角色、服饰、图号和媒体列表以分镜引用为准。H3 叙述用英语，原对白、画面文字与必要的专名保留原语言。
- 使用「角色名：台词」或角色 mention 标出说话人。角色卡已绑定样音时，工作室按上传顺序把 `<Audio N>` 绑定给说话人。最多 3 段 WAV 或 MP3，单段 2–15 秒、合计最多 15 秒。样音与参考图一起使用，底图也作为普通参考图参与全参考模式。
- 对 H3 Max，工作室发送 `extra.prompt_expansion_mode=disabled`，避免供应商再次扩写已经整理好的分镜。
- 本 Skill 的 H3 规则和参考资料只有 `SKILL.md`、`references/base-en.txt` 和 `references/ref-en.txt`。`legacy-hailuo/` 只存放旧海螺型号的运行依赖，H3 请求不要读取其中的文件。Agent 可以用 `read_skill` 的 `file` 参数读取两个参考文件。当前工作室分镜使用 T2VA、I2VA 和 Ref2VA；参考文件同时覆盖首尾帧和仅尾帧的提示词。
- 提示词必须直接返回官方 H3 最终字段，保留官方 `<d>`、`<scenetrans>`、`<cutoff>` 标签和原对白，不使用 `[[DIALOGUE]]` 或其它工作室占位符。字段值中不得写入其它字段标题、Markdown、JSON 或示例。英文说明中只使用 `<Picture N>`、`<Subject N>`、`<Audio N>` 等固定标签，不要复制中文角色名、服饰名或分析性备注。对白和画面中实际可见的文字保留原语言。
- 普通生成只在结构、对白占位和图片编号校验通过后提交。提示词整理失败可修正输入再运行。生成成功后仍应检查实际视频是否保持台词、构图和服饰。

## 选择正确的入口

| 目标        | 常用配置                                                      | 输入形态                                                    |
| ----------- | ------------------------------------------------------------- | ----------------------------------------------------------- |
| 海螺单镜    | `MiniMax-Hailuo-2.3`                                          | 文字，或一张真实分镜首帧。                                  |
| H3 多图镜头 | `MiniMax-H3`                                                  | 工作室会在 V2 的 `content` 中发送一段文本和实际对应的图片。 |
| 加速生成    | `MiniMax-H3-Highspeed`、`MiniMax-H3-Lite` 或 `MiniMax-H3-Max` | 使用所选型号支持的时长和模式。默认输出 768P。               |

例如已经写好分镜「雾中灯光」，且角色风衣、渡口和钥匙均有定稿。选择 H3 后只传该镜的 `shotId`，不用把已存入工程的正文、对白再拼一次。按 `<Picture N>` 和 `<Subject N>` 绑定的图像来自本镜，程序会保留实际上传顺序。

若模型提示输入超限，先检查分镜图数量、分辨率、长宽比和编码后体积。缺凭据时在模型配置中检查视频服务和语言模型。生成被提交后保留任务状态，用实际回执判断是服务限流、任务失败或下载问题。出现服饰或发声偏差时，从原末镜回到画面、对白或选图核对，避免把其他镜头的故事加入本镜。


---

# H3 Prompt Writing

## Workflow

1. Identify the input mode: T2VA, I2VA, FL2VA, L2VA, or full-reference Ref2VA.
2. For base text/keyframe modes, read `references/base-en.txt` and follow its final prompt structure.
3. For full-reference mode, read `references/ref-en.txt` and follow its six-section rewrite format.
4. Preserve the exact field names, section order, labels, and timing notation from the selected guide.

## Base Modes

- T2VA: build the full audiovisual timeline from text.
- I2VA: start from the first frame and develop forward from it.
- FL2VA: describe the continuous path between the first and last frames.
- L2VA: infer a plausible opening and converge to the supplied last frame.

Use `integrated_multimodal_description`, `overall_soundscape`, and `non_diegetic_music` in the order shown in `references/base-en.txt`.

## Full-Reference Mode

Ref2VA rewrites use `subject_definitions`, `summary`, `retention_analysis`, `detailed_description`, `overall_soundscape`, and `non_diegetic_music` in that order. Reference labels stay consistent across all sections.

Read `references/ref-en.txt` for label rules, retention analysis, and complete examples.

## Output Rules

- Write rewrite sections in English; preserve dialogue, lyrics, and visible scene text in their original language.
- Describe each shot by composition, subjects, environment, actions, camera, sound, and the exact point where referenced content appears.
- Avoid plot summaries, unresolved reference labels, and timing that does not match the requested duration.
## Tips for Better Results
- Always match the total duration of the description to the requested video length (4–15 seconds).
- Keep reference labels consistent (e.g. `<Picture 1>`, `<Video 1>`, `<Audio 1>`) across every section.
- Prefer concrete visual and audio details over abstract words like "cinematic" or "beautiful".
- When using keyframes (I2VA / FL2VA / L2VA), clearly state how the first and/or last frame connects to the timeline.
