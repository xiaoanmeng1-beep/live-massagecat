"""Compare full click-to-WAV subprocess times using a synthetic reference, offline."""
import json
import subprocess
import time
from pathlib import Path

engine = Path(__file__).resolve().parents[1] / "data" / "qwen3-tts"
out = engine / "output" / time.strftime("compare-%Y%m%d-%H%M%S")
text = "你这台朗逸，跑了九万公里是吧？收车大概六万三到六万八，具体还得看车况。"
style = "三十五岁左右的男声，中低音，近距离说话。刚低头看完一条留言，抬头只回这个人。开头接话很快，「我看看」轻声带过，数字说清楚，最后三个字轻轻收住。平常聊天的音量。"
reftext = "你这台威驰，十七年上的牌，是吧？十二万公里……我看看。四万二到四万八，看车况。"
ref = engine / "output" / "host-reply-A.wav"

if __name__ == "__main__":
    out.mkdir(parents=True)
    rows = []
    for mode, seed in (("design", 42), ("base", 42), ("base", 43), ("design", 43)):
        cmd = [str(engine/".venv/bin/python"), str(engine/"generate.py"), "--engine", mode,
               "--text", text, "--output", str(out/f"{mode}-{seed}.wav"), "--seed", str(seed)]
        cmd += ["--ref-audio", str(ref), "--ref-text", reftext] if mode == "base" else ["--style", style]
        start = time.monotonic()
        done = subprocess.run(cmd, stdout=subprocess.PIPE, text=True, check=True)
        wall = time.monotonic() - start
        info = json.loads(done.stdout.strip().splitlines()[-1])
        info.update(wall_seconds=round(wall, 2), seed=seed, wall_per_audio_second=round(wall/info["audio_seconds"], 3))
        rows.append(info)
        (out/"timings.json").write_text(json.dumps({"text":text,"reference":str(ref),"runs":rows},ensure_ascii=False,indent=2))
        print(json.dumps(info, ensure_ascii=False), flush=True)
