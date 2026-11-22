import json, os, sys, unittest
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from captions import chunk, clean, clean_hint, window

def words(text, start=0.0, step=0.3):
    return [(start + i * step, start + i * step + 0.25, " " + w) for i, w in enumerate(text.split())]

class ChunkTest(unittest.TestCase):
    def test_caps_words_per_cue(self):
        cues = chunk([words("one two three four five six")])
        self.assertEqual([c[2] for c in cues], ["one two three four", "five six"])

    def test_caps_characters(self):
        cues = chunk([words("incredible unbelievable outrageous")])
        self.assertTrue(all(len(c[2]) <= 24 for c in cues))

    def test_breaks_after_sentence_end_and_on_pause(self):
        self.assertEqual([c[2] for c in chunk([words("let's go. again now")])], ["let's go.", "again now"])
        pause = words("before") + words("after", start=5.0)
        self.assertEqual([c[2] for c in chunk([pause])], ["before", "after"])

    def test_never_merges_segments_and_cues_do_not_overlap(self):
        cues = chunk([words("a b"), words("c d", start=0.7)])
        self.assertEqual([c[2] for c in cues], ["a b", "c d"])
        self.assertTrue(all(cues[i][1] <= cues[i + 1][0] for i in range(len(cues) - 1)))

    def test_strips_libass_override_syntax(self):
        self.assertEqual(clean(" {\\an8}hi<b>"), "an8hib")
        self.assertEqual(chunk([[(0, 0.2, " {}"), (0.3, 0.5, " ok")]])[0][2], "ok")

class WindowTest(unittest.TestCase):
    def test_keeps_words_inside_range_and_shifts_them(self):
        segments = [{"words": [[1.0, 1.5, " early"], [10.0, 10.4, " in"], [19.8, 20.3, " edge"]]}, {"words": [[12.0, 12.5, " also"]]}]
        self.assertEqual(window(segments, 10.0, 20.0), [[(0.0, 0.40000000000000036, " in")], [(2.0, 2.5, " also")]])

class HintTest(unittest.TestCase):
    def test_half_an_emoji_is_replaced_so_the_tokenizer_accepts_it(self):
        half = json.loads('"GTA 6 \\ud83d"')  # a title cut mid-emoji, as it arrives in a serve request
        self.assertEqual(clean_hint(half), "GTA 6 ?")
        self.assertEqual(clean_hint("  Speed 🔴 live  "), "Speed 🔴 live")
        self.assertEqual(clean_hint(None), "")
        self.assertEqual(len(clean_hint("x" * 500)), 200)

if __name__ == "__main__":
    unittest.main()
