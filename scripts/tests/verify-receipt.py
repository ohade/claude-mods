"""Independent fixture assertions for the landing receipt."""
import json
import sys
from datetime import datetime
from pathlib import Path

path, target, previous = sys.argv[1:]
receipt = json.loads(Path(path).read_text())
assert receipt["commit"] == target
assert receipt["previous_commit"] == previous
assert receipt["mods"] == {"image-thumbs": {"pass": 3, "fail": 0}, "track": {"pass": 3, "fail": 0}}
assert datetime.fromisoformat(receipt["deployed_at"].replace("Z", "+00:00")).utcoffset().total_seconds() == 0
assert Path(receipt["log_dir"], "track.log").is_file()
