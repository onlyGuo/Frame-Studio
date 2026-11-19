"""MiniMax H3 V2：以一个已整理的提示词和锁定的工程图片提交、查询、下载。"""

import base64
import json
import os
import re
import subprocess
import time
from pathlib import Path
from urllib.parse import quote, urlsplit

import requests

MIME_TYPES = {".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp"}


def image_item(job, reference, role, fail):
    """检查 H3 的图片尺寸、比例和体积，保留文件和提示词编号的顺序。"""
    path = Path(reference["path"])
    mime = MIME_TYPES.get(path.suffix.lower())
    if not mime or path.stat().st_size > 30_000_000:
        fail(job, "reference_format")
    result = subprocess.run(
        ["ffmpeg", "-hide_banner", "-nostdin", "-protocol_whitelist", "file,pipe", "-i", str(path)],
        capture_output=True, timeout=10,
    )
    match = re.search(rb"Video:[^\r\n]*?\b(\d{1,8})x(\d{1,8})\b", result.stderr)
    if not match:
        fail(job, "reference_format")
    width, height = map(int, match.groups())
    if min(width, height) < 256 or max(width, height) > 5760 or not 0.4 <= width / height <= 2.5:
        fail(job, "reference_format")
    encoded = base64.b64encode(path.read_bytes()).decode("ascii")
    return {"type": "image_url", "role": role, "image_url": {"url": f"data:{mime};base64,{encoded}"}}


def generate(job, model, fail):
    """H3 使用 V2 接口，保留自定义网关路径与已有的 V1 配置兼容。"""
    base = re.sub(r"/v[12]$", "", os.environ["STUDIO_API_URL"].rstrip("/")) + "/v2"
    headers = {"Authorization": "Bearer " + os.environ["STUDIO_API_KEY"], "Content-Type": "application/json"}

    def request(method, route, stage, body=None):
        try:
            response = requests.request(
                method, base + route, headers=headers, data=body, timeout=90, allow_redirects=False
            )
        except requests.Timeout:
            fail(job, "timeout", stage=stage)
        except requests.RequestException:
            fail(job, "network", stage=stage)
        if response.status_code != 200:
            fail(job, "http", response.status_code, stage)
        try:
            return response.json()
        except ValueError:
            fail(job, "format", stage=stage)

    refs = job["references"]
    mode = job["inputMode"]
    if not (mode == "text" and not refs or
            mode == "first-frame" and len(refs) == 1 and refs[0]["type"] == "分镜参考" or
            mode == "references" and 1 <= len(refs) <= 9):
        fail(job, "reference_unsupported")
    duration = job["duration"]
    is_max = model.lower().endswith("-max")
    if type(duration) is not int or not (5 if is_max else 4) <= duration <= 15:
        fail(job, "duration")
    # 先核对编码体积上界，避免在主进程检查后才构建出超限请求。
    if sum(4 * ((Path(ref["path"]).stat().st_size + 2) // 3) for ref in refs) > 64_000_000:
        fail(job, "reference_format")
    role = "first_frame" if mode == "first-frame" else "reference_image"
    content = [{"type": "text", "text": job["prompt"]}] + [image_item(job, ref, role, fail) for ref in refs]
    payload = {
        "model": model, "content": content, "resolution": "768P", "duration": duration,
        "ratio": "adaptive" if mode == "first-frame" and not model.lower().endswith("-lite") else job["ratio"],
    }
    if is_max:
        payload["extra"] = {"prompt_expansion_mode": "disabled"}
    body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    if len(body) > 64_000_000:
        fail(job, "reference_format")
    task_id = request("POST", "/video_generation", "submit", body).get("task_id")
    if not isinstance(task_id, str) or not task_id:
        fail(job, "format")

    deadline = time.monotonic() + 900
    while time.monotonic() < deadline:
        task = request("GET", "/query/video_generation/" + quote(task_id, safe=""), "poll").get("task", {})
        if task.get("status") == "succeeded":
            url = task.get("content", {}).get("url", "")
            if not isinstance(url, str) or urlsplit(url).scheme not in ("https", "http"):
                fail(job, "format", stage="download")
            try:
                with requests.get(url, timeout=90, stream=True) as response:
                    if response.status_code != 200:
                        fail(job, "http", response.status_code, "download")
                    with Path(job["output"]).open("wb") as output:
                        for chunk in response.iter_content(64 * 1024):
                            output.write(chunk)
            except requests.Timeout:
                fail(job, "timeout", stage="download")
            except requests.RequestException:
                fail(job, "network", stage="download")
            return
        if task.get("status") not in ("queued", "running"):
            fail(job, "task", stage="poll")
        time.sleep(5)
    fail(job, "timeout", stage="poll")
