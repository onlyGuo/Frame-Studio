"""将工作室的分镜与参考图交给 MiniMax，轮询和下载复用随包官方 Skill。"""
import base64
import json
import os
import re
import sys
from pathlib import Path

import requests

sys.path[:0] = [str(Path(__file__).resolve().parent / "upstream"), str(Path(__file__).resolve().parent)]
os.environ["MINIMAX_API_KEY"] = os.environ["STUDIO_API_KEY"]
os.environ["MINIMAX_API_BASE"] = os.environ["STUDIO_API_URL"]
import minimax_video as upstream


def fail(job, reason, status=None, stage="submit"):
    """只回送允许显示的错误类别，不把密钥、路径和厂商响应传入模型。"""
    Path(job["output"] + ".diagnostic").write_text(json.dumps({"stage": stage, "reason": reason, "status": status}))
    raise SystemExit(1)


def create_image_task(job, model, frame):
    """将登记的首帧编码为 data URL，提交一次图生视频任务。"""
    path = Path(frame["path"])
    mime = {".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp"}.get(path.suffix.lower())
    if not mime or path.stat().st_size >= 20 * 1024 ** 2:
        fail(job, "reference_format")
    payload = {
        "model": model, "prompt": job["prompt"], "duration": job["duration"], "prompt_optimizer": False,
        "first_frame_image": "data:" + mime + ";base64," + base64.b64encode(path.read_bytes()).decode("ascii")
    }
    if model.startswith("MiniMax-Hailuo"):
        payload["resolution"] = "768P"
    response = requests.post(
        os.environ["STUDIO_API_URL"] + "/video_generation",
        headers={"Authorization": "Bearer " + os.environ["STUDIO_API_KEY"]}, json=payload,
        timeout=90, allow_redirects=False
    )
    if response.status_code != 200:
        fail(job, "http", response.status_code)
    result = response.json()
    if result.get("base_resp", {}).get("status_code", 0) or not result.get("task_id"):
        fail(job, "task")
    return result["task_id"]


def main():
    """只有当前接口可接收本镜全部图片时才提交任务。"""
    job = json.load(sys.stdin.buffer)
    model = os.environ["STUDIO_MODEL"]
    if re.fullmatch(r"MiniMax-H3(?:-(?:Highspeed|Lite|Max))?", model, re.IGNORECASE):
        import h3
        return h3.generate(job, model, fail)
    refs = job.get("references") or []
    image_models = {"MiniMax-Hailuo-2.3", "MiniMax-Hailuo-2.3-Fast", "MiniMax-Hailuo-02", "I2V-01-Director", "I2V-01-live", "I2V-01"}
    if not refs and (model.startswith("I2V-") or model == "MiniMax-Hailuo-2.3-Fast"):
        fail(job, "reference_missing")
    if refs:
        if model not in image_models:
            fail(job, "reference_unsupported")
        if len(refs) > 1:
            fail(job, "reference_limit")
        task_id = create_image_task(job, model, refs[0])
        upstream.download_video(upstream.poll_task(task_id), job["output"])
    else:
        upstream.generate(job["prompt"], job["output"], model=model, duration=job["duration"], prompt_optimizer=False)


if __name__ == "__main__":
    main()
