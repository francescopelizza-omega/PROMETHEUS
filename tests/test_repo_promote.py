"""`repo.py::_promote` must REPLACE the live tree, or leave it untouched.

Regression: the old body was `rmtree(live, ignore_errors=True)` then `shutil.move(stage, live)`.
A single unremovable subtree made the rmtree a silent partial, and because `live` then still
existed, `shutil.move` moved the staged tree INSIDE it. Result: stale un-vetted files stayed
live and the vetted tree sat one directory deeper — while the caller recorded `localPath: live`
with a signed nemesis verdict, telling the user a vetted tree was in place.
"""

import os
import shutil
import stat
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "studio" / "python" / "sidecar"))
import repo  # noqa: E402


def _files(root: Path):
    out = set()
    for base, _dirs, names in os.walk(root):
        for n in names:
            out.add(str(Path(base, n).relative_to(root)))
    return out


class TestPromote(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="prom-promote-"))

    def tearDown(self):
        for base, dirs, _f in os.walk(self.tmp):
            for d in dirs:
                with contextlib_suppress():
                    os.chmod(Path(base, d), stat.S_IRWXU)
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _stage(self) -> Path:
        stage = self.tmp / "stage"
        (stage / "src").mkdir(parents=True)
        (stage / "src" / "app.py").write_text("print('new')\n")
        return stage

    def test_unremovable_subtree_does_not_strand_stale_files_or_nest_the_new_tree(self):
        live = self.tmp / "live"
        (live / "vendored").mkdir(parents=True)
        (live / "vendored" / "old.py").write_text("OLD-STALE\n")
        os.chmod(live / "vendored", 0o555)  # any subtree rmtree cannot unlink

        repo._promote(self._stage(), live)

        self.assertEqual(_files(live), {str(Path("src", "app.py"))})
        self.assertFalse((live / "vendored" / "old.py").exists(), "stale file survived promotion")
        self.assertTrue((live / "src" / "app.py").exists(), "the vetted tree was nested one deeper")

    def test_ordinary_replace(self):
        live = self.tmp / "live"
        live.mkdir()
        (live / "old.py").write_text("OLD\n")
        repo._promote(self._stage(), live)
        self.assertEqual(_files(live), {str(Path("src", "app.py"))})

    def test_first_promotion_with_no_live_tree(self):
        live = self.tmp / "live"
        repo._promote(self._stage(), live)
        self.assertEqual(_files(live), {str(Path("src", "app.py"))})

    def test_a_failed_promotion_is_a_NO_OP_not_a_half_applied_one(self):
        live = self.tmp / "live"
        live.mkdir()
        (live / "keep.py").write_text("KEEP\n")
        missing = self.tmp / "not-a-stage"  # the move cannot succeed
        with self.assertRaises(Exception):
            repo._promote(missing, live)
        self.assertTrue(live.exists(), "the live tree was destroyed by a failed promotion")
        self.assertEqual(_files(live), {"keep.py"})

    def test_no_retired_leftovers_beside_the_live_tree_on_success(self):
        live = self.tmp / "live"
        live.mkdir()
        (live / "old.py").write_text("OLD\n")
        repo._promote(self._stage(), live)
        siblings = [p.name for p in self.tmp.iterdir() if p.name.startswith("live.")]
        self.assertEqual(siblings, [], f"retired copies left behind: {siblings}")


class contextlib_suppress:
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return True


if __name__ == "__main__":
    unittest.main()
