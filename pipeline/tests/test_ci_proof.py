import unittest


class TestCiBlocks(unittest.TestCase):
    def test_fails_on_purpose(self):
        self.assertEqual(1, 2, "deliberate failure: this PR must be blocked from merging")
