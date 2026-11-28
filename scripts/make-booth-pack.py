"""Compatibility entry point. The approved Markdown and SQLite source are mandatory."""
from pathlib import Path
import subprocess, sys
raise SystemExit(subprocess.call(["node", str(Path(__file__).with_name("generate-reviewed-voice.cjs")), *sys.argv[1:]]))
